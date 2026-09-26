"""Turn a foreground mask + monocular depth map into a closed, two-sided mesh.

The reconstruction works on a regular grid laid over the image:

* **Front surface** - the relief given by the depth network, plus a small
  bulge near the silhouette so edges curve away instead of ending abruptly.
* **Back surface** - a smoothed copy of the front relief pushed backwards by an
  *inflation* field. The inflation is ``sqrt(2 h)`` where ``h`` solves the
  Poisson equation ``laplace(h) = -1`` inside the silhouette with ``h = 0`` on
  its boundary. Elongated parts (arms, legs, strands of hair) get circular
  cross sections (a round blob gets R / sqrt(2)), so thin parts stay thin and
  wide parts get deep.
* The two surfaces share the silhouette vertices, which makes the result a
  single watertight solid.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy import sparse
from scipy.sparse.linalg import spsolve


@dataclass
class MeshParams:
    resolution: int = 384
    """Number of grid cells along the image's long side."""
    depth_scale: float = 0.35
    """Front relief depth as a fraction of the object's size."""
    thickness: float = 0.7
    """Back inflation strength. 1.0 gives elongated parts circular cross sections."""
    front_bulge: float = 0.15
    """How much the front surface rounds off towards the silhouette."""
    back_smooth: float = 0.03
    """Blur applied to the relief used for the back, as a fraction of object size."""
    mask_threshold: float = 0.5
    keep_all_parts: bool = False
    """Keep every sizeable foreground component instead of only the largest."""


@dataclass
class Surface:
    """Grid mesh with front/back vertices kept separate (for texturing)."""

    vertices: np.ndarray  # (N, 3) float
    faces: np.ndarray  # (M, 3) int
    uv_image: np.ndarray  # (N, 2) image-space UV in [0, 1], v pointing up
    is_back: np.ndarray  # (N,) bool
    seam_twin: np.ndarray  # (N,) index of the coincident vertex on the other side, or -1


# --------------------------------------------------------------------------- mask


def clean_mask(prob: np.ndarray, threshold: float = 0.5, keep_all: bool = False) -> np.ndarray:
    """Threshold a soft mask, drop speckles and fill small holes."""
    mask = prob > threshold
    mask = ndi.binary_opening(mask, iterations=2)
    labels, n = ndi.label(mask)
    if n == 0:
        raise ValueError("no foreground found in the image")
    sizes = ndi.sum(mask, labels, np.arange(1, n + 1))
    if keep_all:
        keep = np.flatnonzero(sizes >= 0.02 * sizes.max()) + 1
    else:
        keep = [int(np.argmax(sizes)) + 1]
    mask = np.isin(labels, keep)

    # Fill holes that are tiny relative to the object (noise), keep real gaps.
    holes = ndi.binary_fill_holes(mask) & ~mask
    hlabels, hn = ndi.label(holes)
    if hn:
        hsizes = ndi.sum(holes, hlabels, np.arange(1, hn + 1))
        small = np.flatnonzero(hsizes < 0.002 * mask.sum()) + 1
        mask |= np.isin(hlabels, small)
    return mask


def _grid_mask(mask: np.ndarray, gw: int, gh: int) -> np.ndarray:
    """Downsample the mask to grid cells and make it edge-connected and manifold."""
    cov = np.asarray(
        Image.fromarray(mask.astype(np.float32), mode="F").resize((gw, gh), Image.BOX), np.float32
    )
    cells = cov > 0.5

    # Keep the pieces that are 4-connected (they share edges, not just corners).
    labels, n = ndi.label(cells)
    if n == 0:
        raise ValueError("foreground too small for the chosen resolution")
    sizes = ndi.sum(cells, labels, np.arange(1, n + 1))
    cells = np.isin(labels, np.flatnonzero(sizes >= max(4, 0.02 * sizes.max())) + 1)

    # Every cell must belong to a full 2x2 block (so front and back never
    # collapse onto each other), and two cells touching only diagonally would
    # create a pinched, non-manifold vertex: bridge those by filling a gap.
    for _ in range(20):
        cells = ndi.binary_opening(cells, structure=np.ones((2, 2), bool))
        a, b = cells[:-1, :-1], cells[:-1, 1:]
        c, d = cells[1:, :-1], cells[1:, 1:]
        p1 = a & d & ~b & ~c
        p2 = b & c & ~a & ~d
        if not (p1.any() or p2.any()):
            break
        cells[:-1, 1:] |= p1
        cells[:-1, :-1] |= p2
    return cells


# ------------------------------------------------------------------------ fields


def _fill_outside(values: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Replace values outside ``mask`` with the nearest inside value."""
    _, (iy, ix) = ndi.distance_transform_edt(~mask, return_indices=True)
    return values[iy, ix]


def _masked_blur(values: np.ndarray, mask: np.ndarray, sigma: float) -> np.ndarray:
    m = mask.astype(np.float32)
    num = ndi.gaussian_filter(values * m, sigma)
    den = ndi.gaussian_filter(m, sigma)
    out = num / np.maximum(den, 1e-6)
    return np.where(den > 1e-4, out, values)


def _poisson_cells(cells: np.ndarray, step: float) -> np.ndarray:
    """Solve laplace(h) = -1 over mask cells with h = 0 outside (cell centred)."""
    idx = -np.ones((cells.shape[0] + 2, cells.shape[1] + 2), np.int64)
    ys, xs = np.nonzero(cells)
    n = len(ys)
    ys, xs = ys + 1, xs + 1  # padded coordinates
    idx[ys, xs] = np.arange(n)
    rows, cols, vals = [np.arange(n)], [np.arange(n)], [np.full(n, 4.0)]
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nb = idx[ys + dy, xs + dx]
        ok = nb >= 0
        rows.append(np.arange(n)[ok])
        cols.append(nb[ok])
        vals.append(np.full(ok.sum(), -1.0))
    A = sparse.csc_matrix(
        (np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)
    )
    h = np.zeros(idx.shape, np.float64)
    h[ys, xs] = spsolve(A, np.full(n, step * step))
    return h  # padded by one cell of zeros


def _outline_operator(padded: np.ndarray, used: np.ndarray, interior: np.ndarray):
    """Row-normalised neighbour-averaging matrix over the used corners.

    Seam corners average their neighbours *along the outline*; interior corners
    their four grid neighbours.
    """
    ids = -np.ones(used.shape, np.int64)
    ids[used] = np.arange(used.sum())
    n = int(used.sum())

    rows, cols = [], []
    # Horizontal cell edges between (i-1, j) and (i, j) join corners (i, j)-(i, j+1);
    # vertical ones between (i, j-1) and (i, j) join (i, j)-(i+1, j).
    h_edge = padded[:-1, 1:-1] != padded[1:, 1:-1]  # (gh+1, gw)
    v_edge = padded[1:-1, :-1] != padded[1:-1, 1:]  # (gh, gw+1)
    i, j = np.nonzero(h_edge)
    rows += [ids[i, j], ids[i, j + 1]]
    cols += [ids[i, j + 1], ids[i, j]]
    i, j = np.nonzero(v_edge)
    rows += [ids[i, j], ids[i + 1, j]]
    cols += [ids[i + 1, j], ids[i, j]]
    i, j = np.nonzero(interior)
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        rows.append(ids[i, j])
        cols.append(ids[i + di, j + dj])
    rows, cols = np.concatenate(rows), np.concatenate(cols)
    A = sparse.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n))
    deg = np.asarray(A.sum(1)).ravel()
    return sparse.diags(1.0 / np.maximum(deg, 1)) @ A


def _smooth(values: np.ndarray, op, active: np.ndarray, iterations: int) -> np.ndarray:
    """Damped Laplacian smoothing of the ``active`` entries."""
    values = values.copy()
    for _ in range(iterations):
        new = 0.5 * values + 0.5 * (op @ values)
        values[active] = new[active]
    return values


# -------------------------------------------------------------------------- mesh


def build_surface(mask: np.ndarray, disparity: np.ndarray, params: MeshParams) -> Surface:
    """Build the two-sided grid mesh from a full-resolution mask and disparity map."""
    H, W = mask.shape
    long_side = max(H, W)
    gw = max(2, int(round(W / long_side * params.resolution)))
    gh = max(2, int(round(H / long_side * params.resolution)))
    cells = _grid_mask(mask, gw, gh)

    padded = np.pad(cells, 1)
    # Corner (i, j) touches cells (i-1..i, j-1..j) -> padded[i:i+2, j:j+2].
    count = padded[:-1, :-1].astype(np.int8) + padded[:-1, 1:] + padded[1:, :-1] + padded[1:, 1:]
    used = count > 0
    interior = count == 4

    sx, sy = W / gw, H / gh  # pixels per cell
    cy, cx = np.mgrid[0 : gh + 1, 0 : gw + 1].astype(np.float64)
    px, py = cx * sx, cy * sy  # corner positions in pixel units

    # Smooth the stair-stepped grid outline. Interior corners are relaxed too,
    # which keeps the regular grid in place and only evens out the cells next
    # to the moved outline.
    op = _outline_operator(padded, used, interior)
    seam_c = (used & ~interior)[used]
    pos = _smooth(np.stack([px[used], py[used]], 1), op, np.ones(len(seam_c), bool), 10)
    px, py = px.copy(), py.copy()
    px[used], py[used] = pos[:, 0], pos[:, 1]

    # Model units: the image's long side spans 1.0.
    unit = 1.0 / long_side
    step = 0.5 * (sx + sy) * unit

    inside = mask
    ys_m, xs_m = np.nonzero(inside)
    size_px = max(np.ptp(ys_m) + 1, np.ptp(xs_m) + 1)
    size = size_px * unit

    # Relief from disparity, normalised inside the silhouette. Depth networks
    # blur the object into the background over the last few pixels, so the
    # edge band is replaced by the nearest value from a slightly eroded core.
    core = ndi.binary_erosion(inside, iterations=max(2, int(round(0.012 * size_px))))
    if core.sum() < 0.25 * inside.sum():
        core = inside
    lo, hi = np.percentile(disparity[core], [1, 99])
    disp = np.clip((disparity - lo) / max(hi - lo, 1e-6), -0.1, 1.1).astype(np.float32)
    disp = _fill_outside(disp, core)
    disp = _masked_blur(disp, inside, max(sx, sy))
    relief_full = disp * params.depth_scale * size

    sigma_px = max(params.back_smooth * size / unit, 1.0)
    relief_back_full = _masked_blur(relief_full, inside, sigma_px)
    # Blend towards the smoothed relief away from the silhouette so the back
    # meets the front exactly at the seam.
    dist_px = ndi.distance_transform_edt(inside)
    w = np.clip(dist_px / (2.0 * sigma_px), 0.0, 1.0)
    w = w * w * (3 - 2 * w)
    relief_back_full = relief_full * (1 - w) + relief_back_full * w

    def sample(field: np.ndarray) -> np.ndarray:
        coords = np.stack([np.clip(py - 0.5, 0, H - 1), np.clip(px - 0.5, 0, W - 1)])
        return ndi.map_coordinates(field, coords, order=1, mode="nearest")

    relief = sample(relief_full)
    relief_back = sample(relief_back_full)
    # Depth along the outline comes from the very edge of the depth map, which
    # is noisy; even it out along the seam.
    relief[used] = _smooth(relief[used], op, seam_c, 6)

    # Inflation: sample the Poisson solution at the relaxed positions, so it
    # follows the smooth outline rather than the grid staircase.
    h = _poisson_cells(cells, step)
    coords = np.stack([py / sy + 0.5, px / sx + 0.5])  # padded cell-centre coords
    h = ndi.map_coordinates(h, coords, order=1, mode="constant")
    infl = np.sqrt(2.0 * np.maximum(h, 0.0)) * interior

    z_front = relief + params.front_bulge * infl
    z_back = relief_back - params.thickness * infl
    z_back = np.minimum(z_back, z_front - 1e-4 * interior)
    z_back[~interior] = z_front[~interior]

    x = px * unit
    y = -py * unit

    # Vertex ids: every used corner gets a front vertex and a back vertex.
    fid = -np.ones(used.shape, np.int64)
    fid[used] = np.arange(used.sum())
    nf = int(used.sum())
    bid = np.where(used, fid + nf, -1)

    sel = used
    front_v = np.stack([x[sel], y[sel], z_front[sel]], 1)
    back_v = np.stack([x[sel], y[sel], z_back[sel]], 1)
    vertices = np.concatenate([front_v, back_v])

    uv = np.stack([px[sel] / W, 1.0 - py[sel] / H], 1)
    uv_image = np.concatenate([uv, uv])
    is_back = np.concatenate([np.zeros(nf, bool), np.ones(nf, bool)])

    seam_twin = -np.ones(2 * nf, np.int64)
    bnd = (used & ~interior)[sel]
    seam_twin[:nf][bnd] = np.flatnonzero(bnd) + nf
    seam_twin[nf:][bnd] = np.flatnonzero(bnd)

    # Split each cell along a diagonal that passes through an interior corner,
    # so no triangle lies entirely on the seam (it would have zero thickness).
    ci, cj = np.nonzero(cells)
    a, b = (ci, cj), (ci, cj + 1)
    c, d = (ci + 1, cj), (ci + 1, cj + 1)
    ad = interior[a] | interior[d]
    tris = [  # counter-clockwise when seen from the front
        np.where(ad[:, None], np.stack([fid[a], fid[c], fid[d]], 1), np.stack([fid[a], fid[c], fid[b]], 1)),
        np.where(ad[:, None], np.stack([fid[a], fid[d], fid[b]], 1), np.stack([fid[b], fid[c], fid[d]], 1)),
    ]
    front_f = np.concatenate(tris)
    back_f = np.where(front_f < nf, front_f + nf, front_f)[:, ::-1]
    faces = np.concatenate([front_f, back_f])

    # Centre horizontally/in depth and stand the model on y = 0.
    lo_v, hi_v = vertices.min(0), vertices.max(0)
    offset = np.array([(lo_v[0] + hi_v[0]) / 2, lo_v[1], (lo_v[2] + hi_v[2]) / 2])
    vertices = vertices - offset

    return Surface(vertices, faces, uv_image, is_back, seam_twin)


def weld(surface: Surface) -> tuple[np.ndarray, np.ndarray]:
    """Merge seam duplicates so the mesh is a single closed solid (for STL/printing)."""
    remap = np.arange(len(surface.vertices))
    twin = surface.seam_twin
    back_seam = surface.is_back & (twin >= 0)
    remap[back_seam] = twin[back_seam]
    keep = np.unique(remap)
    compact = -np.ones(len(remap), np.int64)
    compact[keep] = np.arange(len(keep))
    return surface.vertices[keep], compact[remap[surface.faces]]
