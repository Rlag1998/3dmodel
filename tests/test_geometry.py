"""Geometry and texture tests on synthetic inputs (no model downloads)."""

import numpy as np
import pytest
import trimesh
from PIL import Image

from img2mesh.export import make_texture, textured_mesh
from img2mesh.geometry import MeshParams, build_surface, clean_mask, weld


def disc(size=200, radius=70):
    yy, xx = np.mgrid[:size, :size]
    return (yy - size / 2) ** 2 + (xx - size / 2) ** 2 < radius**2


def ring(size=200):
    yy, xx = np.mgrid[:size, :size]
    r2 = (yy - size / 2) ** 2 + (xx - size / 2) ** 2
    return (r2 < 80**2) & (r2 > 35**2)


def solid(mask, disparity=None, **params):
    disparity = np.zeros(mask.shape, np.float32) if disparity is None else disparity
    surface = build_surface(mask, disparity, MeshParams(resolution=96, **params))
    v, f = weld(surface)
    return surface, trimesh.Trimesh(v, f, process=False)


@pytest.mark.parametrize("make", [disc, ring])
def test_closed_consistent_solid(make):
    _, mesh = solid(make())
    assert mesh.is_watertight
    assert mesh.is_winding_consistent
    assert mesh.volume > 0  # outward-facing normals
    assert mesh.euler_number == (2 if make is disc else 0)


def test_inflation_profile():
    # No relief, thickness=1, no front bulge: an elongated strip gets a round
    # cross section (depth = half width); a disc gets R / sqrt(2).
    mask = np.zeros((200, 200), bool)
    mask[70:130, 10:190] = True
    surface, mesh = solid(mask, thickness=1.0, front_bulge=0.0)
    assert np.ptp(mesh.vertices[:, 2]) == pytest.approx(30 / 200, rel=0.08)

    _, mesh = solid(disc(radius=70), thickness=1.0, front_bulge=0.0)
    assert np.ptp(mesh.vertices[:, 2]) == pytest.approx(70 / 200 / np.sqrt(2), rel=0.05)


def test_relief_follows_disparity():
    mask = disc()
    xx = np.tile(np.linspace(0, 1, 200, dtype=np.float32), (200, 1))
    surface, _ = solid(mask, xx, thickness=0.0, front_bulge=0.0)
    front = surface.vertices[~surface.is_back]
    # Larger disparity (right side) must be closer to the camera (+z).
    assert np.corrcoef(front[:, 0], front[:, 2])[0, 1] > 0.95


def test_diagonal_touching_parts_stay_manifold():
    mask = np.zeros((120, 120), bool)
    mask[10:60, 10:60] = True
    mask[60:110, 60:110] = True  # touches the first square only at a corner
    _, mesh = solid(clean_mask(mask.astype(np.float32), keep_all=True))
    assert mesh.is_watertight


def test_clean_mask_keeps_largest_and_fills_specks():
    mask = disc().astype(np.float32)
    mask[100, 100] = 0  # pin-hole
    mask[5:9, 5:9] = 1  # speck
    m = clean_mask(mask)
    assert m[100, 100]
    assert not m[5:9, 5:9].any()


@pytest.mark.parametrize("mode", ["fill", "blur", "mirror"])
def test_texture_atlas_and_uvs(mode):
    mask = disc()
    rgb = np.zeros((200, 200, 3), np.uint8)
    rgb[mask] = (200, 30, 30)
    rgb[90:110, 90:110] = (0, 0, 255)  # a "face" in the middle
    texture = make_texture(Image.fromarray(rgb), mask, mode)
    assert texture.size == (400, 200)
    back = np.asarray(texture)[:, 200:]
    if mode == "fill":
        # The back is filled from the outline colour, so the face is gone.
        assert back[100, 100, 2] < 60 and back[100, 100, 0] > 150

    surface, _ = solid(mask)
    mesh = textured_mesh(surface, texture)
    uv = mesh.visual.uv
    assert (uv[~surface.is_back, 0] <= 0.5).all() and (uv[surface.is_back, 0] >= 0.5).all()
