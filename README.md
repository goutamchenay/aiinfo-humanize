# aiinfo-humanize

A small CLI and Python library to **inspect** and **strip** AI-provenance metadata
from images (PNG, JPEG, WebP), such as images exported from ChatGPT / DALL·E,
Midjourney, Stable Diffusion, ComfyUI or Adobe Firefly.

## What it removes

`aiinfo clean` decodes the image and re-encodes it **from raw pixels only**, so every
piece of attached metadata is dropped:

| Metadata | Where it lives | Example |
|---|---|---|
| C2PA / Content Credentials | PNG `caBX` chunk, JPEG APP11 (JUMBF) | ChatGPT / DALL·E, Firefly |
| EXIF | JPEG APP1, PNG `eXIf` | `Software = DALL-E 3` |
| XMP / IPTC | APP1 / text chunks | `DigitalSourceType = trainedAlgorithmicMedia` |
| PNG text chunks | `tEXt` / `iTXt` / `zTXt` | A1111 `parameters`, ComfyUI `workflow` |
| ICC profile | optional, kept with `--keep-icc` | |

EXIF orientation is applied to the pixels before stripping, so photos don't turn sideways.
PNG output is lossless, and pixels are identical to the original.

## Install

```bash
pip install git+https://github.com/sizuelboro/aiinfo-humanize
# or, from a clone:
pip install -e ".[dev]"
```

## Usage

```bash
# Inspect (exit code 1 if AI markers are found, 0 otherwise)
aiinfo scan image.png
aiinfo scan ./folder

# Clean -> writes image_clean.png next to the original
aiinfo clean image.png

# Choose output / batch a folder / overwrite
aiinfo clean image.png -o final.png
aiinfo clean ./folder -o ./cleaned
aiinfo clean image.jpg --in-place -q 92
```

Example:

```text
$ aiinfo scan demo.png
demo.png  [PNG]  -> AI markers found
  signature : C2PA manifest
  signature : PNG C2PA chunk (caBX)
  signature : OpenAI
  text      : Software = OpenAI ChatGPT

$ aiinfo clean demo.png
demo.png -> demo_clean.png  [OK]
```

Python API:

```python
from aiinfo_humanize import scan, clean

print(scan("image.png").signatures)
clean("image.png", "image_clean.png")
```

## Limitations

- **Metadata only.** Invisible pixel-level watermarks (for example Google SynthID) are
  part of the image itself and are **not** removed. AI-image classifiers can also still
  recognise generated images from their visual content.
- Supported formats: PNG, JPEG, WebP. JPEG/WebP are re-encoded (default quality 95).

## Responsible use

Removing metadata is useful for privacy, smaller files, and personal projects. Don't use
it to pass off AI-generated images as real photographs or as your own hand-made work
where disclosure is expected (news, contests, client work, platforms that require AI
labels).

## Development

```bash
pip install -e ".[dev]"
pytest
```
