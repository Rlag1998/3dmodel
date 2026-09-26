"""Model download/caching and ONNX inference for segmentation and depth.

Everything runs through onnxruntime on the CPU, so no PyTorch or GPU is
required. Weights are downloaded once into ``~/.cache/img2mesh`` (override
with the ``IMG2MESH_CACHE`` environment variable).
"""

from __future__ import annotations

import os
import shutil
import sys
import urllib.request
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

HF = "https://huggingface.co"

DEPTH_MODELS = {
    "small": f"{HF}/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx",
    "base": f"{HF}/onnx-community/depth-anything-v2-base/resolve/main/onnx/model.onnx",
    "large": f"{HF}/onnx-community/depth-anything-v2-large/resolve/main/onnx/model.onnx",
}

REMBG = "https://github.com/danielgatis/rembg/releases/download/v0.0.0"
SEGMENT_MODELS = {
    # Trained on anime/illustration characters.
    "anime": f"{REMBG}/isnet-anime.onnx",
    # General-purpose dichotomous image segmentation (photos, objects).
    "general": f"{REMBG}/isnet-general-use.onnx",
}

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def cache_dir() -> Path:
    path = Path(os.environ.get("IMG2MESH_CACHE", Path.home() / ".cache" / "img2mesh"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def download(url: str, name: str) -> Path:
    """Download ``url`` into the cache as ``name`` unless it is already there."""
    target = cache_dir() / name
    if target.exists():
        return target
    tmp = target.with_suffix(target.suffix + ".part")
    print(f"[img2mesh] downloading {name} ...", file=sys.stderr)
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as out:
        shutil.copyfileobj(resp, out, length=1 << 20)
    tmp.rename(target)
    return target


@lru_cache(maxsize=None)
def _session(url: str, name: str):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    return ort.InferenceSession(
        str(download(url, name)), opts, providers=ort.get_available_providers()
    )


def segment(image: Image.Image, model: str = "anime") -> np.ndarray:
    """Return a float foreground-probability map in [0, 1] at image resolution."""
    sess = _session(SEGMENT_MODELS[model], f"isnet-{model}.onnx")
    size = 1024
    rgb = np.asarray(image.convert("RGB").resize((size, size), Image.LANCZOS), np.float32)
    rgb = rgb / max(rgb.max(), 1e-6)
    x = (rgb - 0.5).transpose(2, 0, 1)[None]
    inp = sess.get_inputs()[0].name
    pred = sess.run(None, {inp: x.astype(np.float32)})[0][0, 0]
    pred = (pred - pred.min()) / max(pred.max() - pred.min(), 1e-6)
    out = Image.fromarray((pred * 255).astype(np.uint8)).resize(image.size, Image.LANCZOS)
    return np.asarray(out, np.float32) / 255.0


def estimate_depth(image: Image.Image, model: str = "base", resolution: int = 770) -> np.ndarray:
    """Relative inverse depth (disparity; larger = closer) at image resolution.

    ``resolution`` is the long side fed to the network (rounded to a multiple
    of 14, the ViT patch size). Higher values recover finer detail.
    """
    sess = _session(DEPTH_MODELS[model], f"depth-anything-v2-{model}.onnx")
    w, h = image.size
    scale = resolution / max(w, h)
    nw = max(14, int(round(w * scale / 14)) * 14)
    nh = max(14, int(round(h * scale / 14)) * 14)
    rgb = np.asarray(image.convert("RGB").resize((nw, nh), Image.BICUBIC), np.float32) / 255.0
    x = ((rgb - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None].astype(np.float32)
    inp = sess.get_inputs()[0].name
    pred = sess.run(None, {inp: x})[0]
    pred = np.squeeze(pred).astype(np.float32)
    out = Image.fromarray(pred, mode="F").resize((w, h), Image.BICUBIC)
    return np.asarray(out, np.float32)
