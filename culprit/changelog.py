"""Patch notes, straight from the checkout's commit history.

The host runs from a git checkout (culprit.sh installs into one, and the
agent updater relies on the same fact), so the commit log *is* the change
log: one `git log` at first request, parsed and cached for the life of the
process (the code cannot change under a running host without a restart).
Each commit is tagged with the version `version.json` carried after it, read
from the diffs of the commits that touched that file, so the view can group
the entries under the release they landed in.

A container image (the Dockerfile copies files, not `.git`) or a tarball
has no history: the payload then says `available: False` with the reason,
never an empty list dressed as "nothing changed".
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
from typing import Any

from . import __version__
from .config import ROOT

log = logging.getLogger("culprit.changelog")

LIMIT = 400          # newest commits served; the view lists them all
_SEP_FIELD = "\x1f"
_SEP_RECORD = "\x1e"
_SUBJECT = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?: (?P<summary>.+)$")
_VERSION_LINE = re.compile(r'^([-+])\s*"version"\s*:\s*"([^"]+)"', re.M)

_cache: dict[str, Any] | None = None
_lock = threading.Lock()


def _git(args: list[str]) -> tuple[str | None, str]:
    """(stdout, reason): stdout is None when git could not answer."""
    try:
        done = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True,
                              text=True, timeout=15, errors="replace")
    except FileNotFoundError:
        return None, "git is not installed on the host"
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"git failed: {exc}"
    if done.returncode != 0:
        err = done.stderr.strip().splitlines()
        return None, (err[-1] if err else f"git exited {done.returncode}")
    return done.stdout, ""


def _bumps() -> dict[str, tuple[str | None, str | None]]:
    """sha -> (version before, version after) for every commit that changed
    version.json. Empty when the file has no history yet."""
    out, _ = _git(["log", "--no-color", "-p", f"--format={_SEP_RECORD}%H", "--", "version.json"])
    bumps: dict[str, tuple[str | None, str | None]] = {}
    if not out:
        return bumps
    for record in out.split(_SEP_RECORD):
        record = record.strip()
        if not record:
            continue
        sha, _, diff = record.partition("\n")
        before = after = None
        for sign, value in _VERSION_LINE.findall(diff):
            if sign == "-":
                before = value
            else:
                after = value
        bumps[sha.strip()] = (before, after)
    return bumps


def _parse(raw: str, bumps: dict[str, tuple[str | None, str | None]]) -> list[dict[str, Any]]:
    commits: list[dict[str, Any]] = []
    # Newest first: the version a commit belongs to is the one version.json
    # held after it, which is the current version until we pass the commit
    # that set it; from there on, the version that commit replaced.
    version: str | None = __version__ if __version__ != "unknown" else None
    for record in raw.split(_SEP_RECORD):
        if not record.strip():
            continue
        parts = record.lstrip("\n").split(_SEP_FIELD)
        if len(parts) < 5:
            continue
        sha, short, ts, subject, body = parts[0], parts[1], parts[2], parts[3], parts[4]
        sha = sha.strip()
        match = _SUBJECT.match(subject.strip())
        bump = bumps.get(sha)
        if bump and bump[1]:
            version = bump[1]
        commits.append({
            "sha": sha,
            "short": short.strip(),
            "ts": int(ts) if ts.strip().isdigit() else None,
            "subject": subject.strip(),
            "type": match.group("type") if match else None,
            "scope": (match.group("scope") or None) if match else None,
            "breaking": bool(match and match.group("bang")),
            "summary": match.group("summary") if match else subject.strip(),
            "body": body.strip(),
            "version": version,
            "bumped_to": bump[1] if bump else None,
        })
        if bump and bump[0]:
            version = bump[0]
    return commits


def _build() -> dict[str, Any]:
    fmt = _SEP_FIELD.join(["%H", "%h", "%at", "%s", "%b"]) + _SEP_RECORD
    raw, reason = _git(["log", "--no-color", f"-n{LIMIT}", f"--format={fmt}"])
    if raw is None:
        if "not a git repository" in reason.lower():
            reason = "this host is not running from a git checkout, so it has no commit history"
        return {"available": False, "reason": reason, "current": __version__, "commits": []}
    commits = _parse(raw, _bumps())
    branch, _ = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    return {
        "available": True,
        "reason": None,
        "current": __version__,
        "branch": (branch or "").strip() or None,
        "limit": LIMIT,
        "commits": commits,
    }


def load() -> dict[str, Any]:
    """The parsed log, computed once per process. Safe to call from a thread."""
    global _cache
    with _lock:
        if _cache is None:
            _cache = _build()
            if _cache["available"]:
                log.debug("changelog: %d commits parsed", len(_cache["commits"]))
            else:
                log.info("changelog unavailable: %s", _cache["reason"])
        return _cache
