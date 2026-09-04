"""Refresh this branch's site from the real frontend.

This branch *is* the GitHub Pages site: `index.html`, `favicon.svg` and
`assets/` at the root are what Pages serves. The dashboard's own CSS and JS
under `assets/` are a copy of `web/` from the main branch, plus two things
that exist only here -- the in-browser stand-in for the host
(`assets/js/demo/`) and the recorded, scrubbed fleet (`assets/demo/data/`).

Running this pulls `web/` out of a git ref (main by default), replaces every
copied file under `assets/` while keeping the demo module and its data, and
writes the root `index.html` with the two edits a host-less page needs:
root-absolute asset paths made relative (so the page works under a Pages
project sub-path), and the demo module loaded before app.js. It refuses to
run without the fixtures, because a demo with no data is a page of skeletons.

    python3 tools/build_demo.py            # from main
    python3 tools/build_demo.py --ref v1.2 # from a tag or any other ref
    python3 -m http.server 8080            # then open http://localhost:8080/
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
KEEP = ("js/demo", "demo")   # what this branch owns under assets/

DEMO_SCRIPT = '<script type="module" src="./assets/js/demo/boot.js"></script>\n'


def extract_web(ref: str, into: Path) -> Path:
    archive = into / "web.tar"
    with archive.open("wb") as handle:
        subprocess.run(["git", "archive", ref, "web"], cwd=ROOT, check=True, stdout=handle)
    with tarfile.open(archive) as tar:
        tar.extractall(into, filter="data")
    web = into / "web"
    if not (web / "index.html").exists() or not (web / "js" / "app.js").exists():
        raise SystemExit(f"{ref}:web does not look like the dashboard (no index.html / js/app.js)")
    return web


def build(ref: str) -> int:
    manifest = ASSETS / "demo" / "data" / "manifest.json"
    if not manifest.exists():
        print(f"no fixtures at {manifest.relative_to(ROOT)}; run tools/record_demo.py against a host first")
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        web = extract_web(ref, Path(tmp))
        # Replace the copied frontend, keep what is ours.
        for entry in sorted(ASSETS.iterdir()) if ASSETS.exists() else []:
            rel = entry.relative_to(ASSETS).as_posix()
            if rel in KEEP:
                continue
            if entry.is_dir():
                for child in sorted(entry.iterdir()):
                    child_rel = child.relative_to(ASSETS).as_posix()
                    if child_rel in KEEP:
                        continue
                    shutil.rmtree(child) if child.is_dir() else child.unlink()
            else:
                entry.unlink()
        copied = 0
        for source in sorted(web.rglob("*")):
            rel = source.relative_to(web)
            if source.is_dir() or rel.name in ("index.html", "login.html", "favicon.svg"):
                continue
            if rel.as_posix().startswith(KEEP):
                continue
            target = ASSETS / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied += 1

        index = (web / "index.html").read_text(encoding="utf-8")
        index, n_paths = re.subn(r'(href|src)="/(assets|favicon\.svg)', r'\1="./\2', index)
        index, n_hook = re.subn(r'(<script type="module" src="\./assets/js/app\.js"></script>)',
                                DEMO_SCRIPT + r"\1", index, count=1)
        if n_hook != 1 or n_paths < 3:
            print(f"index.html did not look as expected (app.js tag x{n_hook}, root paths x{n_paths})")
            return 1
        index = index.replace("<title>Culprit</title>", "<title>Culprit — demo</title>", 1)
        (ROOT / "index.html").write_text(index, encoding="utf-8")
        shutil.copy2(web / "favicon.svg", ROOT / "favicon.svg")
    # GitHub Pages: no Jekyll pass (it would drop paths it considers private).
    (ROOT / ".nojekyll").write_text("")

    head = subprocess.run(["git", "rev-parse", "--short", ref], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    print(f"refreshed assets/ from {ref} ({head}): {copied} files copied, demo module and data kept, index.html written")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--ref", default="main", help="git ref whose web/ becomes the site (default main)")
    args = parser.parse_args()
    return build(args.ref)


if __name__ == "__main__":
    sys.exit(main())
