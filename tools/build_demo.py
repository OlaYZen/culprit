"""Build the static demo site: the dashboard, no backend, recorded data.

Copies `web/` into `dist/demo/` in the layout the host serves it in (the
static files under `assets/`, `index.html` and the favicon at the root) and
makes the two edits a host-less deployment needs:

  - root-absolute asset paths become relative, so the page works under a
    GitHub Pages project sub-path (`https://<user>.github.io/culprit/`) as
    well as at a domain root;
  - `<html>` gets `data-demo="1"`, which is what makes app.js load the
    in-browser stand-in for the host (`web/js/demo/`).

The fixtures come from `web/demo/data/` (see `tools/record_demo.py`); the
build refuses to run without them, because a demo with no data is a page of
skeletons. Nothing else is rewritten -- the demo runs the same CSS and JS
the host serves, so what people try is what they would install.

    .venv/bin/python tools/build_demo.py [--out dist/demo]
    python3 -m http.server -d dist/demo 8080   # then open http://localhost:8080/
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT_DEFAULT = ROOT / "dist" / "demo"


def build(out: Path) -> int:
    data = WEB / "demo" / "data" / "manifest.json"
    if not data.exists():
        print(f"no fixtures at {data.relative_to(ROOT)}; run tools/record_demo.py against a host first")
        return 2
    if out.exists():
        shutil.rmtree(out)
    assets = out / "assets"
    shutil.copytree(WEB, assets, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "login.html"))

    index = (WEB / "index.html").read_text(encoding="utf-8")
    index, n_paths = re.subn(r'(href|src)="/(assets|favicon\.svg)', r'\1="./\2', index)
    index, n_flag = re.subn(r"<html\b([^>]*)>", r'<html\1 data-demo="1">', index, count=1)
    if n_flag != 1 or n_paths < 3:
        print(f"index.html did not look as expected (html tag x{n_flag}, root paths x{n_paths})")
        return 1
    index = index.replace("<title>Culprit</title>", "<title>Culprit — demo</title>", 1)
    (out / "index.html").write_text(index, encoding="utf-8")
    shutil.copy2(WEB / "favicon.svg", out / "favicon.svg")
    # GitHub Pages: no Jekyll pass (it would drop paths it considers private).
    (out / ".nojekyll").write_text("")

    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    files = sum(1 for p in out.rglob("*") if p.is_file())
    print(f"built {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}: {files} files, {total / 1048576:.1f} MB")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()
    return build(args.out.resolve())


if __name__ == "__main__":
    sys.exit(main())
