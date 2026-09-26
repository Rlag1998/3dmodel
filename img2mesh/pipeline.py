"""End-to-end image -> 3D model conversion."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from . import export, models
from .geometry import MeshParams, build_surface, clean_mask


@dataclass
class Options:
    mesh: MeshParams = field(default_factory=MeshParams)
    depth_model: str = "base"
    depth_resolution: int = 770
    segment_model: str = "anime"
    mask_path: Path | None = None
    """Use this mask image (white = object) instead of automatic segmentation."""
    no_segment: bool = False
    """Treat the whole image as the object (e.g. for a relief of a painting)."""
    back_texture: str = "fill"
    formats: tuple[str, ...] = ("glb", "obj", "stl", "html")
    save_debug: bool = True


def _foreground(image: Image.Image, opts: Options) -> np.ndarray:
    if opts.mask_path is not None:
        m = Image.open(opts.mask_path).convert("L").resize(image.size, Image.BILINEAR)
        return np.asarray(m, np.float32) / 255.0
    if opts.no_segment:
        return np.ones((image.height, image.width), np.float32)
    if image.mode in ("RGBA", "LA") or "transparency" in image.info:
        alpha = np.asarray(image.convert("RGBA"), np.float32)[..., 3] / 255.0
        if (alpha < 0.5).mean() > 0.01:  # a real cut-out, not just an opaque alpha channel
            return alpha
    return models.segment(image, opts.segment_model)


def _subject_box(mask: np.ndarray, margin: float = 0.03) -> tuple[int, int, int, int]:
    """Bounding box (left, top, right, bottom) of the mask plus a small margin."""
    ys, xs = np.nonzero(mask)
    pad = int(round(margin * max(np.ptp(ys), np.ptp(xs)))) + 2
    h, w = mask.shape
    return (
        max(0, xs.min() - pad),
        max(0, ys.min() - pad),
        min(w, xs.max() + 1 + pad),
        min(h, ys.max() + 1 + pad),
    )


def convert(image_path: Path, out_dir: Path, opts: Options | None = None) -> dict[str, Path]:
    """Convert one image; returns the written files keyed by kind."""
    opts = opts or Options()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = image_path.stem
    image = Image.open(image_path)
    image.load()

    prob = _foreground(image, opts)
    mask = clean_mask(prob, opts.mesh.mask_threshold, opts.mesh.keep_all_parts)
    disparity = models.estimate_depth(image, opts.depth_model, opts.depth_resolution)

    # Work on the subject's bounding box so the mesh resolution and texture
    # are spent on the object, however small it is in the frame.
    box = _subject_box(mask)
    mask_c = mask[box[1] : box[3], box[0] : box[2]]
    surface = build_surface(mask_c, disparity[box[1] : box[3], box[0] : box[2]], opts.mesh)
    texture = export.make_texture(image.crop(box), mask_c, opts.back_texture)
    mesh = export.textured_mesh(surface, texture, stem)

    written: dict[str, Path] = {}
    if "glb" in opts.formats or "html" in opts.formats:
        written["glb"] = out_dir / f"{stem}.glb"
        export.save_glb(mesh, written["glb"])
    if "obj" in opts.formats:
        written["obj"] = out_dir / f"{stem}.obj"
        export.save_obj(mesh, written["obj"])
    if "stl" in opts.formats:
        written["stl"] = out_dir / f"{stem}.stl"
        export.save_stl(surface, written["stl"])
    if "html" in opts.formats:
        written["html"] = out_dir / f"{stem}_viewer.html"
        w, h, d = mesh.extents
        stats = f"{len(mesh.faces):,} triangles · {w / h:.2f} : 1 : {d / h:.2f} (w : h : d)"
        export.save_viewer(written["glb"], written["html"], f"{stem.replace('_', ' ').title()} 3D Model", stats)
    if opts.save_debug:
        written["mask"] = out_dir / f"{stem}_mask.png"
        Image.fromarray((mask * 255).astype(np.uint8)).save(written["mask"])
        d = disparity[mask]
        dn = np.clip((disparity - d.min()) / max(np.ptp(d), 1e-6), 0, 1) * mask
        written["depth"] = out_dir / f"{stem}_depth.png"
        Image.fromarray((dn * 255).astype(np.uint8)).save(written["depth"])

    written["_stats"] = {  # type: ignore[assignment]
        "vertices": len(mesh.vertices),
        "faces": len(mesh.faces),
        "size": mesh.extents.round(3).tolist(),
    }
    return written
