"""aiinfo-humanize: inspect and strip AI-provenance metadata from images."""

__version__ = "0.1.0"

from .cleaner import clean
from .scanner import scan

__all__ = ["clean", "scan", "__version__"]
