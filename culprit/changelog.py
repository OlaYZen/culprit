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

The agent's notes come the same way from a bare mirror of the agent
repository kept under data/ (the host already talks to GitHub for the
agent's published version, so this is the same trust): cloned on first
request, fetched again at most once an hour, and parsed by the same code
with the mirror's main as the tip. A failed fetch keeps the last good parse
rather than blanking the view; a host that cannot clone says why.
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
from typing import Any

import time

from . import __version__
from . import config as config_module
from .config import ROOT

log = logging.getLogger("culprit.changelog")

LIMIT = 400          # newest commits served; the view lists them all
_SEP_FIELD = "\x1f"
_SEP_RECORD = "\x1e"
_SUBJECT = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?: (?P<summary>.+)$")
_VERSION_LINE = re.compile(r'^([-+])\s*"version"\s*:\s*"([^"]+)"', re.M)

AGENT_REPO_URL = "https://github.com/OlaYZen/culprit-agent.git"
AGENT_MIRROR = ROOT / "data" / "culprit-agent.git"
AGENT_REFRESH_S = 3600.0
BRANCH_REFRESH_S = 60.0       # a Settings visit may fetch again this often
# Branches of the agent repository that are not lines agents should follow
# (the demo branch carries synthetic data for the public dashboard).
HIDDEN_BRANCHES = ("demo",)
REPOS = ("host", "agent")

_cache: dict[str, dict[str, Any]] = {}
_agent_fetched_at = 0.0
_agent_branch: str | None = None   # the branch the cached agent parse describes
_lock = threading.Lock()


def _git(args: list[str], cwd: Any = ROOT, timeout: float = 15) -> tuple[str | None, str]:
    """(stdout, reason): stdout is None when git could not answer."""
    try:
        done = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True,
                              text=True, timeout=timeout, errors="replace")
    except FileNotFoundError:
        return None, "git is not installed on the host"
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"git failed: {exc}"
    if done.returncode != 0:
        err = done.stderr.strip().splitlines()
        return None, (err[-1] if err else f"git exited {done.returncode}")
    return done.stdout, ""


def _bumps(cwd: Any, ref: str) -> dict[str, tuple[str | None, str | None]]:
    """sha -> (version before, version after) for every commit that changed
    version.json. Empty when the file has no history yet."""
    out, _ = _git(["log", "--no-color", "-p", f"--format={_SEP_RECORD}%H", ref, "--", "version.json"], cwd)
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


def _parse(raw: str, bumps: dict[str, tuple[str | None, str | None]],
           tip_version: str | None) -> list[dict[str, Any]]:
    commits: list[dict[str, Any]] = []
    # Newest first: the version a commit belongs to is the one version.json
    # held after it, which is the tip's version until we pass the commit
    # that set it; from there on, the version that commit replaced.
    version: str | None = tip_version
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


def _build(cwd: Any, ref: str, tip_version: str | None) -> dict[str, Any]:
    fmt = _SEP_FIELD.join(["%H", "%h", "%at", "%s", "%b"]) + _SEP_RECORD
    raw, reason = _git(["log", "--no-color", f"-n{LIMIT}", f"--format={fmt}", ref], cwd)
    if raw is None:
        if "not a git repository" in reason.lower():
            reason = "this host is not running from a git checkout, so it has no commit history"
        return {"available": False, "reason": reason, "current": tip_version, "commits": []}
    commits = _parse(raw, _bumps(cwd, ref), tip_version)
    return {
        "available": True,
        "reason": None,
        "current": tip_version,
        "limit": LIMIT,
        "commits": commits,
    }


def _build_host() -> dict[str, Any]:
    out = _build(ROOT, "HEAD", __version__ if __version__ != "unknown" else None)
    out["repo"] = "host"
    if out["available"]:
        branch, _ = _git(["rev-parse", "--abbrev-ref", "HEAD"])
        out["branch"] = (branch or "").strip() or None
    return out


def _sync_agent_mirror() -> str:
    """Clone the agent repository as a bare mirror on first use, then fetch
    it again when AGENT_REFRESH_S has passed. Returns "" or the reason the
    mirror could not be brought up to date (an existing mirror is still
    served then -- stale beats blank, and the payload says when it was
    fetched)."""
    global _agent_fetched_at
    if not (AGENT_MIRROR / "HEAD").exists():
        AGENT_MIRROR.parent.mkdir(parents=True, exist_ok=True)
        out, reason = _git(["clone", "--mirror", "--quiet", AGENT_REPO_URL, str(AGENT_MIRROR)],
                           ROOT, timeout=90)
        if out is None:
            return f"could not fetch the agent repository ({AGENT_REPO_URL}): {reason}"
        _agent_fetched_at = time.time()
        return ""
    if time.time() - _agent_fetched_at < AGENT_REFRESH_S:
        return ""
    _agent_fetched_at = time.time()   # one attempt per window, success or not
    out, reason = _git(["fetch", "--quiet", "--prune"], AGENT_MIRROR, timeout=60)
    if out is None:
        return f"could not refresh the agent repository: {reason}"
    return ""


def branches(refresh: bool = False) -> dict[str, Any]:
    """The agent repository's branches from the mirror, HIDDEN_BRANCHES left
    out, for the Settings picker. `refresh` fetches first when the mirror is
    older than BRANCH_REFRESH_S, so a branch pushed a minute ago shows up
    without waiting for the hourly sync. Unavailable (with the reason) when
    there is no mirror; the picker then falls back to a typed name."""
    global _agent_fetched_at
    with _lock:
        problem = _sync_agent_mirror()
        if not (AGENT_MIRROR / "HEAD").exists():
            return {"available": False, "reason": problem or "no mirror of the agent repository yet",
                    "branches": [], "hidden": list(HIDDEN_BRANCHES), "fetched_at": None}
        if refresh and not problem and time.time() - _agent_fetched_at >= BRANCH_REFRESH_S:
            _agent_fetched_at = time.time()
            out, reason = _git(["fetch", "--quiet", "--prune"], AGENT_MIRROR, timeout=60)
            problem = "" if out is not None else f"could not refresh the agent repository: {reason}"
        out, reason = _git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], AGENT_MIRROR)
        if out is None:
            return {"available": False, "reason": f"could not list branches: {reason}",
                    "branches": [], "hidden": list(HIDDEN_BRANCHES), "fetched_at": _agent_fetched_at or None}
        names = sorted({line.strip() for line in out.splitlines() if line.strip()} - set(HIDDEN_BRANCHES),
                       key=lambda b: (b != "main", b != "dev", b))
        return {"available": True, "reason": None, "branches": names, "hidden": list(HIDDEN_BRANCHES),
                "fetched_at": _agent_fetched_at or None, "stale_reason": problem or None}


def _build_agent(branch: str) -> dict[str, Any]:
    out = _build_agent_inner(branch)
    # The version picker warns before a downgrade below the first build whose
    # updater works: from there the host cannot bring the agent back.
    from .nodes import MIN_SELF_UPDATE_VERSION
    out["min_self_update_version"] = MIN_SELF_UPDATE_VERSION
    return out


def _build_agent_inner(branch: str) -> dict[str, Any]:
    problem = _sync_agent_mirror()
    if problem and not (AGENT_MIRROR / "HEAD").exists():
        return {"available": False, "reason": problem, "repo": "agent", "current": None,
                "branch": branch, "commits": []}
    exists, _ = _git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], AGENT_MIRROR)
    if exists is None:
        return {"available": False, "repo": "agent", "current": None, "branch": branch, "commits": [],
                "reason": f"the agent repository has no branch '{branch}' (Settings > Automatic agent updates)"}
    tip, _ = _git(["show", f"{branch}:version.json"], AGENT_MIRROR)
    match = re.search(r'"version"\s*:\s*"([^"]+)"', tip or "")
    out = _build(AGENT_MIRROR, branch, match.group(1) if match else None)
    out["repo"] = "agent"
    out["branch"] = branch
    out["source"] = AGENT_REPO_URL
    out["fetched_at"] = _agent_fetched_at or None
    out["stale_reason"] = problem or None
    return out


def load(repo: str = "host") -> dict[str, Any]:
    """The parsed log for `repo` ("host": this checkout, parsed once per
    process; "agent": the mirror on the configured branch, re-parsed after
    each successful fetch or when the branch setting changes). Safe to call
    from a thread."""
    if repo not in REPOS:
        raise ValueError(f"unknown repo {repo!r}")
    with _lock:
        cached = _cache.get(repo)
        if repo == "host":
            if cached is None:
                cached = _cache[repo] = _build_host()
        else:
            global _agent_branch
            branch = config_module.get().agent_update_branch or "main"
            due = cached is None or branch != _agent_branch \
                or time.time() - _agent_fetched_at >= AGENT_REFRESH_S
            if due:
                fresh = _build_agent(branch)
                _agent_branch = branch
                # A mirror that could not be refreshed still parses; only a
                # mirror that never existed is unavailable, and even then a
                # previous good answer is kept.
                if fresh["available"] or cached is None or cached.get("branch") != branch:
                    cached = _cache[repo] = fresh
                else:
                    cached["stale_reason"] = fresh["reason"]
        if not cached["available"]:
            log.info("changelog (%s) unavailable: %s", repo, cached["reason"])
        return cached
