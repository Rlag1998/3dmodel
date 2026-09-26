"""img2mesh: turn a single 2D image into a textured 3D model."""

from .geometry import MeshParams
from .pipeline import Options, convert

__all__ = ["MeshParams", "Options", "convert"]
__version__ = "0.1.0"
