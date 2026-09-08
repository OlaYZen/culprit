#!/usr/bin/env python3
"""Create the GitHub release for every version in the host's commit history
that does not have one yet.

The commit log is the source, exactly as Patch notes reads it
(`culprit.changelog`): every version `version.json` ever held is a release,
its tag (`vX.Y.Z-b`) points at the commit that set it, and its notes are the
commits grouped under that version by conventional type. Idempotent: a tag
that already has a release is left alone, so running it after every bump
keeps the releases in step with the history.

Every release is flagged **pre-release** while the version carries the `-b`
suffix (all of them until 1.0.0): GitHub then never marks one "Latest", which
is the honest state of a beta line. Drop the flag only for 1.0.0 and after.

    .venv/bin/python tools/make_releases.py          # create what is missing
    .venv/bin/python tools/make_releases.py --dry    # print the plan, create nothing

Needs `gh` signed in with write access to the repository.
"""
from __future__ import annotations

import datetime
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from culprit import changelog  # noqa: E402

REPO = "OlaYZen/culprit"
TYPES: list[tuple[str | None, str]] = [
    ("feat", "Features"), ("fix", "Fixes"), ("perf", "Performance"), ("refactor", "Refactoring"),
    ("build", "Build"), ("ci", "CI"), ("test", "Tests"), ("docs", "Documentation"),
    ("chore", "Chores"), ("revert", "Reverts"), (None, "Other"),
]
KNOWN = {t for t, _ in TYPES if t}


def _gh(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", *args], capture_output=True, text=True)


def _existing() -> set[str]:
    out = _gh(["release", "list", "--repo", REPO, "--limit", "1000", "--json", "tagName"])
    if out.returncode:
        sys.exit(f"gh release list failed: {out.stderr.strip()}")
    return {r["tagName"] for r in json.loads(out.stdout or "[]")}


def _notes(version: str, group: list[dict], bump: dict) -> str:
    by_type: dict[str | None, list[dict]] = {}
    for c in group:
        by_type.setdefault(c["type"] if c["type"] in KNOWN else None, []).append(c)
    when = datetime.datetime.fromtimestamp(bump["ts"], datetime.timezone.utc).strftime("%Y-%m-%d")
    lines = [f"Released {when} · {len(group)} commit{'s' if len(group) != 1 else ''}", ""]
    for key, title in TYPES:
        items = by_type.get(key)
        if not items:
            continue
        lines.append(f"### {title}")
        for c in items:
            scope = f"**{c['scope']}:** " if c["scope"] else ""
            lines.append(f"- {scope}{c['summary']} ({c['short']})")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def plan() -> list[tuple[str, str, str]]:
    data = changelog.load("host")
    if not data.get("available"):
        sys.exit(f"no history to read: {data.get('reason')}")
    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for c in data["commits"]:                       # newest first
        v = c["version"]
        if v not in groups:
            groups[v] = []
            order.append(v)
        groups[v].append(c)
    existing = _existing()
    out: list[tuple[str, str, str]] = []
    for v in reversed(order):                       # oldest first: the newest ends up on top
        if not v:
            continue
        tag = f"v{v}"
        if tag in existing:
            continue
        bump = next((c for c in groups[v] if c["bumped_to"] == v), None)
        if bump is None:
            print(f"skip {tag}: no commit sets it", file=sys.stderr)
            continue
        out.append((tag, bump["sha"], _notes(v, groups[v], bump)))
    print(f"{len(out)} release(s) to create; {len(existing)} exist", file=sys.stderr)
    return out


def main() -> int:
    dry = "--dry" in sys.argv[1:]
    todo = plan()
    if dry:
        for tag, sha, notes in todo:
            print(f"=== {tag} @ {sha[:7]}\n{notes}")
        return 0
    failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        for tag, sha, notes in todo:
            path = Path(tmp) / f"{tag}.md"
            path.write_text(notes, encoding="utf-8")
            args = ["release", "create", tag, "--repo", REPO, "--target", sha, "--title", tag,
                    "--notes-file", str(path)]
            if tag.endswith("-b"):                  # beta line: never "Latest" until 1.0.0
                args.append("--prerelease")
            r = _gh(args)
            if r.returncode:
                failed += 1
                print(f"ERR {tag}: {r.stderr.strip()}", flush=True)
            else:
                print(f"ok  {tag}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
