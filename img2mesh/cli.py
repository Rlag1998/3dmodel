"""Command line interface: ``img2mesh IMAGE [IMAGE ...] -o OUT_DIR``."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from .export import BACK_MODES
from .geometry import MeshParams
from .models import DEPTH_MODELS, SEGMENT_MODELS
from .pipeline import Options, convert

FORMATS = ("glb", "obj", "stl", "html")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    d = MeshParams()
    p = argparse.ArgumentParser(
        prog="img2mesh",
        description="Turn a 2D image into a textured, watertight 3D model (runs on CPU).",
    )
    p.add_argument("images", nargs="+", type=Path, help="input image(s)")
    p.add_argument("-o", "--out", type=Path, default=Path("output"), help="output directory")
    p.add_argument("--formats", default=",".join(FORMATS),
                   help=f"comma separated subset of {','.join(FORMATS)} (default: all)")

    g = p.add_argument_group("shape")
    g.add_argument("--resolution", type=int, default=d.resolution,
                   help="mesh grid cells along the subject's long side (detail vs. file size)")
    g.add_argument("--depth-scale", type=float, default=d.depth_scale,
                   help="front relief depth relative to object size")
    g.add_argument("--thickness", type=float, default=d.thickness,
                   help="how far the back bulges out; 1.0 = round limbs")
    g.add_argument("--front-bulge", type=float, default=d.front_bulge,
                   help="extra rounding of the front towards the outline")
    g.add_argument("--back-smooth", type=float, default=d.back_smooth,
                   help="smoothing of the back surface relative to object size")

    g = p.add_argument_group("models")
    g.add_argument("--depth-model", choices=sorted(DEPTH_MODELS), default="base",
                   help="Depth Anything V2 size (large is sharper but ~1.3 GB)")
    g.add_argument("--depth-resolution", type=int, default=770,
                   help="network input size for depth estimation")
    g.add_argument("--segment-model", choices=sorted(SEGMENT_MODELS), default="anime",
                   help="background removal model: 'anime' for illustrations, 'general' for photos")

    g = p.add_argument_group("foreground")
    g.add_argument("--mask", type=Path, help="use this mask image (white = object)")
    g.add_argument("--no-segment", action="store_true",
                   help="use the whole image as the object (bas-relief)")
    g.add_argument("--mask-threshold", type=float, default=d.mask_threshold)
    g.add_argument("--keep-all-parts", action="store_true",
                   help="keep every sizeable foreground piece, not just the largest")

    g = p.add_argument_group("texture")
    g.add_argument("--back-texture", choices=BACK_MODES, default="fill",
                   help="fill: diffuse the outline colours inward (default); "
                        "blur: blurred front; mirror: copy the front")
    g.add_argument("--no-debug", action="store_true", help="don't write mask/depth PNGs")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    a = parse_args(argv)
    formats = tuple(f.strip() for f in a.formats.split(",") if f.strip())
    unknown = set(formats) - set(FORMATS)
    if unknown:
        print(f"unknown format(s): {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    if a.mask and len(a.images) > 1:
        print("--mask can only be used with a single image", file=sys.stderr)
        return 2

    opts = Options(
        mesh=MeshParams(
            resolution=a.resolution,
            depth_scale=a.depth_scale,
            thickness=a.thickness,
            front_bulge=a.front_bulge,
            back_smooth=a.back_smooth,
            mask_threshold=a.mask_threshold,
            keep_all_parts=a.keep_all_parts,
        ),
        depth_model=a.depth_model,
        depth_resolution=a.depth_resolution,
        segment_model=a.segment_model,
        mask_path=a.mask,
        no_segment=a.no_segment,
        back_texture=a.back_texture,
        formats=formats,
        save_debug=not a.no_debug,
    )

    status = 0
    for image in a.images:
        t0 = time.time()
        try:
            written = convert(image, a.out, opts)
        except Exception as exc:  # keep going with the other images
            print(f"{image}: failed: {exc}", file=sys.stderr)
            status = 1
            continue
        stats = written.pop("_stats")
        print(f"{image} -> {stats['vertices']} vertices, {stats['faces']} faces, "
              f"size {stats['size']} ({time.time() - t0:.1f}s)")
        for kind, path in written.items():
            print(f"  {kind:5s} {path}")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
