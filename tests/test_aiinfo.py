from pathlib import Path

import pytest
from PIL import Image, PngImagePlugin

from aiinfo_humanize import clean, scan
from aiinfo_humanize.cli import main


def _gradient(mode: str = "RGB") -> Image.Image:
    img = Image.new("RGB", (32, 24))
    img.putdata([(x * 8, y * 10, 128) for y in range(24) for x in range(32)])
    return img.convert(mode)


@pytest.fixture
def ai_png(tmp_path: Path) -> Path:
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", "a cat, Steps: 20, Sampler: Euler, Model: Stable Diffusion")
    info.add_text("Software", "OpenAI ChatGPT")
    info.add(b"caBX", b"jumb\x00\x00c2pa.manifest trainedAlgorithmicMedia")
    path = tmp_path / "ai.png"
    _gradient("RGBA").save(path, pnginfo=info)
    return path


@pytest.fixture
def ai_jpeg(tmp_path: Path) -> Path:
    exif = Image.Exif()
    exif[0x0131] = "DALL-E 3"  # Software
    exif[0x0112] = 6  # Orientation: rotate 90 CW
    path = tmp_path / "ai.jpg"
    _gradient().save(path, exif=exif.tobytes(), quality=95)
    # Inject an APP11 (JUMBF/C2PA) segment right after SOI.
    payload = b"JP\x00\x01jumbc2pa OpenAI"
    segment = b"\xff\xeb" + (len(payload) + 2).to_bytes(2, "big") + payload
    raw = path.read_bytes()
    path.write_bytes(raw[:2] + segment + raw[2:])
    return path


def test_scan_detects_png_markers(ai_png):
    r = scan(ai_png)
    assert r.has_ai_markers
    assert "PNG C2PA chunk (caBX)" in r.signatures
    assert "C2PA manifest" in r.signatures
    assert "parameters" in r.generator_text


def test_clean_png_removes_everything_and_keeps_pixels(ai_png, tmp_path):
    out = clean(ai_png, tmp_path / "out.png")
    r = scan(out)
    assert not r.has_metadata and not r.has_ai_markers
    with Image.open(ai_png) as a, Image.open(out) as b:
        assert a.mode == b.mode and a.size == b.size
        assert a.tobytes() == b.tobytes()


def test_clean_jpeg_removes_exif_and_app11_and_applies_orientation(ai_jpeg):
    assert scan(ai_jpeg).has_ai_markers
    out = clean(ai_jpeg)
    assert out.name == "ai_clean.jpg"
    r = scan(out)
    assert not r.has_metadata, r
    assert b"\xff\xeb" not in out.read_bytes()[:200]
    with Image.open(out) as img:
        assert img.size == (24, 32)  # rotated by orientation tag


def test_clean_palette_png(tmp_path):
    src = tmp_path / "p.png"
    _gradient("P").save(src)
    out = clean(src, tmp_path / "p_out.png")
    with Image.open(src) as a, Image.open(out) as b:
        assert a.convert("RGB").tobytes() == b.convert("RGB").tobytes()


def test_cli_scan_exit_codes_and_batch_clean(ai_png, ai_jpeg, tmp_path):
    assert main(["scan", str(ai_png)]) == 1
    outdir = tmp_path / "cleaned"
    assert main(["clean", str(ai_png), str(ai_jpeg), "-o", str(outdir)]) == 0
    assert main(["scan", str(outdir)]) == 0
    assert sorted(p.name for p in outdir.iterdir()) == ["ai.jpg", "ai.png"]


def test_cli_rejects_unsupported(tmp_path, capsys):
    src = tmp_path / "x.gif"
    _gradient().save(src)
    assert main(["clean", str(src)]) == 2
    assert "Unsupported format" in capsys.readouterr().err
