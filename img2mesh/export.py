"""Texturing and file export (GLB, OBJ, STL, standalone HTML viewer)."""

from __future__ import annotations

import base64
from html import escape as html_escape
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage as ndi
from scipy import sparse
from scipy.sparse.linalg import spsolve

from .geometry import Surface, weld

BACK_MODES = ("fill", "blur", "mirror")


def _bleed(rgb: np.ndarray, mask: np.ndarray, erode: int = 2) -> np.ndarray:
    """Replace colours outside the (slightly eroded) mask with the nearest inside
    colour, so silhouette triangles don't pick up the background."""
    core = ndi.binary_erosion(mask, iterations=erode) if mask.sum() > 1000 else mask
    _, (iy, ix) = ndi.distance_transform_edt(~core, return_indices=True)
    return rgb[iy, ix]


def _edge_fill(rgb: np.ndarray, mask: np.ndarray, band: float = 0.03, work: int = 256) -> np.ndarray:
    """Guess the colours of the unseen back side.

    Colours in a band just inside the silhouette are what the object shows at
    its sides, so they are the best evidence for its back. They are kept and
    diffused inwards (Laplace equation) to fill the rest, which e.g. gives the
    back of a head the hair colour seen around the outline instead of a face.
    """
    H, W = mask.shape
    scale = work / max(H, W)
    w, h = max(8, round(W * scale)), max(8, round(H * scale))
    small = np.asarray(Image.fromarray(rgb.astype(np.uint8)).resize((w, h), Image.BOX), np.float64)
    m = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize((w, h), Image.BOX)) > 127

    dist = ndi.distance_transform_edt(m)
    unknown = dist > max(band * work, 2.0)
    unknown[[0, -1], :] = False
    unknown[:, [0, -1]] = False
    ids = -np.ones(m.shape, np.int64)
    ys, xs = np.nonzero(unknown)
    n = len(ys)
    out = small.copy()
    if n:
        ids[ys, xs] = np.arange(n)
        rows, cols, vals = [np.arange(n)], [np.arange(n)], [np.full(n, 4.0)]
        rhs = np.zeros((n, 3))
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = ids[ys + dy, xs + dx]
            ok = nb >= 0
            rows.append(np.arange(n)[ok])
            cols.append(nb[ok])
            vals.append(np.full(ok.sum(), -1.0))
            rhs[~ok] += small[ys[~ok] + dy, xs[~ok] + dx]
        A = sparse.csc_matrix(
            (np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)
        )
        out[ys, xs] = spsolve(A, rhs)
    out = ndi.gaussian_filter(out, (1.0, 1.0, 0))
    big = np.stack(
        [np.asarray(Image.fromarray(out[..., k].astype(np.float32), mode="F").resize((W, H), Image.BICUBIC))
         for k in range(3)],
        -1,
    )
    return big


def make_texture(image: Image.Image, mask: np.ndarray, back: str = "fill") -> Image.Image:
    """Front texture on the left half, back texture on the right half."""
    if back not in BACK_MODES:
        raise ValueError(f"back texture must be one of {BACK_MODES}")
    rgb = np.asarray(image.convert("RGB"), np.float32)
    front = _bleed(rgb, mask)

    if back == "mirror":
        rear = front
    elif back == "fill":
        rear = _bleed(_edge_fill(front, mask), mask)
    else:
        # Keep the broad colour regions but wash out features (eyes, mouth, ...)
        # that would look wrong if they appeared on the back.
        sigma = 0.015 * max(mask.shape)
        m = mask.astype(np.float32)[..., None]
        num = ndi.gaussian_filter(front * m, (sigma, sigma, 0))
        den = ndi.gaussian_filter(m, (sigma, sigma, 0))
        rear = _bleed(num / np.maximum(den, 1e-6), mask)

    atlas = np.concatenate([front, rear], axis=1)
    return Image.fromarray(np.clip(atlas, 0, 255).astype(np.uint8))


def textured_mesh(surface: Surface, texture: Image.Image, name: str = "img2mesh") -> trimesh.Trimesh:
    uv = surface.uv_image.copy()
    uv[:, 0] = uv[:, 0] * 0.5 + 0.5 * surface.is_back
    material = trimesh.visual.material.PBRMaterial(
        name=name,
        baseColorTexture=texture,
        metallicFactor=0.0,
        roughnessFactor=0.85,
    )
    visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
    return trimesh.Trimesh(surface.vertices, surface.faces, visual=visual, process=False)


def save_glb(mesh: trimesh.Trimesh, path: Path) -> None:
    path.write_bytes(trimesh.exchange.gltf.export_glb(mesh))


def save_obj(mesh: trimesh.Trimesh, path: Path) -> None:
    """Writes ``path`` plus a ``.mtl`` and ``.png`` texture next to it."""
    obj, files = trimesh.exchange.obj.export_obj(
        mesh, include_texture=True, return_texture=True, mtl_name=path.stem + ".mtl"
    )
    path.write_text(obj)
    for name, data in files.items():
        (path.parent / name).write_bytes(data)


def save_stl(surface: Surface, path: Path) -> None:
    """Welded, watertight solid without texture (e.g. for 3D printing)."""
    v, f = weld(surface)
    trimesh.Trimesh(v, f, process=False).export(path)


VIEWER_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>__TITLE__</title>
<style>
  /* A single dark "turntable" stage, chosen deliberately for viewing models. */
  :root {
    color-scheme: dark;
    --stage: #17191f;
    --panel: #23262e;
    --line: #3a3f4b;
    --text: #d9dce4;
    --muted: #8b91a0;
    --accent: #8fa8d8;
  }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--stage);
    color: var(--text); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  canvas { display: block; touch-action: none; }
  .bar { position: fixed; left: 0; right: 0; display: flex; flex-wrap: wrap; gap: 6px;
    align-items: center; padding-inline: 16px; pointer-events: none; }
  .bar > * { pointer-events: auto; }
  #ui { top: 0; padding-top: calc(env(safe-area-inset-top, 0px) + 12px); }
  #info { bottom: 0; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 10px);
    justify-content: space-between; color: var(--muted); font-variant-numeric: tabular-nums; }
  button { font: inherit; background: var(--panel); color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  button:hover { border-color: var(--muted); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button[aria-pressed="true"] { border-color: var(--accent); color: #fff;
    background: color-mix(in srgb, var(--accent) 30%, var(--panel)); }
  .sep { width: 1px; height: 20px; background: var(--line); margin-inline: 4px; }
  #status { position: fixed; inset: 0; display: grid; place-items: center; color: var(--muted); }
  [hidden] { display: none !important; }
</style>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
} }
</script>
</head>
<body>
<div id="status">Loading model&hellip;</div>
<div id="ui" class="bar">
  <button id="rotate" aria-pressed="true">Turntable</button>
  <button id="tex" aria-pressed="true">Texture</button>
  <button id="wire" aria-pressed="false">Wireframe</button>
  <span class="sep" aria-hidden="true"></span>
  <button id="front">Front</button>
  <button id="side">Side</button>
  <button id="back">Back</button>
</div>
<div id="info" class="bar">
  <span>Drag to orbit &middot; scroll or pinch to zoom &middot; right-drag to pan</span>
  <span>__STATS__</span>
</div>
<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const GLB = "__GLB__";

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x17191f);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotateSpeed = 1.5;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 1.7));
const key = new THREE.DirectionalLight(0xffffff, 1.7);
key.position.set(1.5, 2, 2.5);
scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.8);
rim.position.set(-2, 1, -2);
scene.add(rim);
scene.add(new THREE.GridHelper(2, 20, 0x3a3f4b, 0x262a33));

const buttons = {};
const toggle = (id, fn) => {
  const b = buttons[id] = document.getElementById(id);
  b.onclick = () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", on);
    fn(on);
  };
};
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
controls.autoRotate = !reduced;
document.getElementById("rotate").setAttribute("aria-pressed", !reduced);

const bytes = Uint8Array.from(atob(GLB), c => c.charCodeAt(0));
const materials = [], textures = new Map();
new GLTFLoader().parse(bytes.buffer, "", gltf => {
  const model = gltf.scene;
  model.traverse(o => {
    if (o.isMesh) {
      o.geometry.computeVertexNormals();
      materials.push(o.material);
      textures.set(o.material, o.material.map);
    }
  });
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  const dist = Math.max(size.x, size.y) * 1.9;
  window.view = az => {
    camera.position.set(center.x + Math.sin(az) * dist, center.y + size.y * 0.1,
                        center.z + Math.cos(az) * dist);
    controls.update();
  };
  view(0.35);
  document.getElementById("status").hidden = true;
  window.modelReady = true;
}, err => {
  document.getElementById("status").textContent = "The model could not be loaded: " + err.message;
});

toggle("rotate", on => controls.autoRotate = on);
toggle("wire", on => materials.forEach(m => { m.wireframe = on; }));
toggle("tex", on => materials.forEach(m => { m.map = on ? textures.get(m) : null; m.needsUpdate = true; }));
document.getElementById("front").onclick = () => view(0);
document.getElementById("side").onclick = () => view(Math.PI / 2);
document.getElementById("back").onclick = () => view(Math.PI);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
</script>
</body>
</html>
"""


def save_viewer(glb_path: Path, path: Path, title: str, stats: str = "") -> None:
    """Self-contained HTML page (the GLB is embedded) that orbits the model."""
    data = base64.b64encode(glb_path.read_bytes()).decode("ascii")
    html = (
        VIEWER_TEMPLATE.replace("__TITLE__", html_escape(title))
        .replace("__STATS__", html_escape(stats))
        .replace("__GLB__", data)
    )
    path.write_text(html)
