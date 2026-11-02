"""Detect AI-provenance metadata embedded in image files."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image
from PIL.ExifTags import TAGS

# Byte signatures that commonly indicate AI-generation metadata.
# (label, needle) - matched case-sensitively against the raw file bytes.
SIGNATURES: list[tuple[str, bytes]] = [
    ("C2PA manifest", b"c2pa"),
    ("JUMBF box (C2PA container)", b"jumb"),
    ("PNG C2PA chunk (caBX)", b"caBX"),
    ("IPTC 'trainedAlgorithmicMedia' source type", b"trainedAlgorithmicMedia"),
    ("IPTC 'compositeSynthetic' source type", b"compositeSynthetic"),
    ("OpenAI", b"OpenAI"),
    ("ChatGPT", b"ChatGPT"),
    ("DALL-E", b"DALL"),
    ("Midjourney", b"Midjourney"),
    ("Stable Diffusion", b"Stable Diffusion"),
    ("ComfyUI workflow", b"\"class_type\""),
    ("Adobe Firefly", b"Firefly"),
    ("Google Imagen / Gemini", b"Imagen"),
]

# Format-structural fields Pillow exposes in ``img.info`` that carry no provenance.
STRUCTURAL_KEYS = {
    "dpi", "gamma", "transparency", "jfif", "jfif_density", "jfif_unit", "jfif_version",
    "progressive", "progression", "loop", "duration", "background", "lossless",
}

# PNG text keys written by popular generators (e.g. AUTOMATIC1111, ComfyUI).
GENERATOR_TEXT_KEYS = {"parameters", "prompt", "workflow", "Software", "Comment", "Description"}


@dataclass
class ScanResult:
    path: Path
    format: str | None
    signatures: list[str] = field(default_factory=list)
    info_keys: list[str] = field(default_factory=list)
    exif_tags: dict[str, str] = field(default_factory=dict)
    generator_text: dict[str, str] = field(default_factory=dict)

    @property
    def has_metadata(self) -> bool:
        return bool(self.signatures or self.info_keys or self.exif_tags)

    @property
    def has_ai_markers(self) -> bool:
        return bool(self.signatures or self.generator_text)


def _short(value: object, limit: int = 80) -> str:
    text = value.decode(errors="replace") if isinstance(value, bytes) else str(value)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def scan(path: str | Path) -> ScanResult:
    path = Path(path)
    raw = path.read_bytes()

    with Image.open(path) as img:
        result = ScanResult(path=path, format=img.format)
        result.signatures = [label for label, needle in SIGNATURES if needle in raw]
        result.info_keys = sorted(k for k in img.info if k not in STRUCTURAL_KEYS)
        for key in GENERATOR_TEXT_KEYS & set(img.info):
            result.generator_text[key] = _short(img.info[key])
        for tag_id, value in img.getexif().items():
            result.exif_tags[TAGS.get(tag_id, f"Tag{tag_id}")] = _short(value)

    return result
