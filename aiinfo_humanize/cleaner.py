"""Strip all metadata from an image by rebuilding it from raw pixels."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageOps

SUPPORTED = {"PNG", "JPEG", "WEBP"}


def default_output(path: Path) -> Path:
    return path.with_name(f"{path.stem}_clean{path.suffix}")


def clean(src: str | Path, dst: str | Path | None = None, *, keep_icc: bool = False, quality: int = 95) -> Path:
    """Write a metadata-free copy of ``src`` and return its path.

    The image is decoded and re-encoded from pixel data only, so EXIF, XMP,
    IPTC, PNG text chunks and C2PA/JUMBF manifests are all dropped. EXIF
    orientation is applied to the pixels first so the image doesn't rotate.
    """
    src = Path(src)
    dst = Path(dst) if dst else default_output(src)

    with Image.open(src) as img:
        fmt = img.format
        if fmt not in SUPPORTED:
            raise ValueError(f"Unsupported format {fmt!r}; supported: {', '.join(sorted(SUPPORTED))}")
        icc = img.info.get("icc_profile") if keep_icc else None
        img = ImageOps.exif_transpose(img)
        pixels = Image.frombytes(img.mode, img.size, img.tobytes())
        if img.mode == "P":
            pixels.putpalette(img.getpalette())

    save_kwargs: dict = {}
    if icc:
        save_kwargs["icc_profile"] = icc
    if fmt == "JPEG":
        if pixels.mode not in {"RGB", "L", "CMYK"}:
            pixels = pixels.convert("RGB")
        save_kwargs.update(quality=quality, subsampling=0)
    elif fmt == "WEBP":
        save_kwargs.update(quality=quality)

    dst.parent.mkdir(parents=True, exist_ok=True)
    pixels.save(dst, format=fmt, **save_kwargs)
    return dst
