"""Command-line interface: ``aiinfo scan`` and ``aiinfo clean``."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .cleaner import clean
from .scanner import scan

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def _collect(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            files.extend(sorted(f for f in p.iterdir() if f.suffix.lower() in IMAGE_EXTS))
        else:
            files.append(p)
    return files


def _print_scan(path: Path) -> bool:
    r = scan(path)
    status = "AI markers found" if r.has_ai_markers else ("metadata found" if r.has_metadata else "clean")
    print(f"{path}  [{r.format}]  -> {status}")
    for s in r.signatures:
        print(f"  signature : {s}")
    for k, v in r.generator_text.items():
        print(f"  text      : {k} = {v}")
    for k, v in r.exif_tags.items():
        print(f"  exif      : {k} = {v}")
    if r.info_keys:
        print(f"  info keys : {', '.join(r.info_keys)}")
    return r.has_ai_markers


def cmd_scan(args: argparse.Namespace) -> int:
    found = False
    for f in _collect(args.paths):
        found |= _print_scan(f)
    return 1 if found else 0


def cmd_clean(args: argparse.Namespace) -> int:
    files = _collect(args.paths)
    if args.output and len(files) > 1 and not Path(args.output).is_dir():
        Path(args.output).mkdir(parents=True, exist_ok=True)
    for f in files:
        dst = None
        if args.in_place:
            dst = f
        elif args.output:
            out = Path(args.output)
            dst = out / f.name if (len(files) > 1 or out.is_dir()) else out
        written = clean(f, dst, keep_icc=args.keep_icc, quality=args.quality)
        remaining = scan(written)
        note = "OK" if not remaining.has_metadata else f"leftover: {remaining.signatures or remaining.info_keys}"
        print(f"{f} -> {written}  [{note}]")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aiinfo", description="Inspect and strip AI-provenance metadata from images.")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("scan", help="Report metadata / AI markers (exit code 1 if AI markers found)")
    s.add_argument("paths", nargs="+", help="Image files or directories")
    s.set_defaults(func=cmd_scan)

    c = sub.add_parser("clean", help="Write metadata-free copies of images")
    c.add_argument("paths", nargs="+", help="Image files or directories")
    group = c.add_mutually_exclusive_group()
    group.add_argument("-o", "--output", help="Output file, or directory when cleaning several files")
    group.add_argument("--in-place", action="store_true", help="Overwrite the original files")
    c.add_argument("--keep-icc", action="store_true", help="Keep the ICC colour profile")
    c.add_argument("-q", "--quality", type=int, default=95, help="JPEG/WebP quality (default 95)")
    c.set_defaults(func=cmd_clean)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
