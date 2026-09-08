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

Either side can be read at any branch, not only the one that is running or
configured: the view offers the branches the checkout / the mirror has, so a
host on dev can read what main ships and the other way round. For the host
that means its own remote-tracking refs, fetched (refs only, never the
working tree) at most once an hour like the mirror; the running branch is
always read from HEAD, since that is the code that is actually serving.
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
from typing import Any

import time
from pathlib import Path

from . import __version__
from . import config as config_module
from .config import ROOT

log = logging.getLogger("culprit.changelog")

LIMIT = 400          # newest commits served; the view lists them all
_SEP_FIELD = "\x1f"
_SEP_RECORD = "\x1e"
_SUBJECT = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?: (?P<summary>.+)$")
# Either layout of version.json: the key on its own line, or the whole
# object on one line ('+{"version": "0.44.1-b"}'), which a shell one-liner
# once wrote and which silently dropped five versions from the grouping.
_VERSION_LINE = re.compile(r'^([-+])\s*\{?\s*"version"\s*:\s*"([^"]+)"', re.M)

AGENT_REPO_URL = "https://github.com/OlaYZen/culprit-agent.git"
AGENT_MIRROR = ROOT / "data" / "culprit-agent.git"
# The Windows agent is its own repository with its own version line; its
# notes come from a second bare mirror kept the same way.
AGENT_REPOS: dict[str, tuple[str, Path]] = {
    "agent": (AGENT_REPO_URL, AGENT_MIRROR),
    "agent-windows": ("https://github.com/OlaYZen/culprit-agent-windows.git",
                      ROOT / "data" / "culprit-agent-windows.git"),
}
AGENT_REFRESH_S = 3600.0
BRANCH_REFRESH_S = 60.0       # a Settings visit may fetch again this often
# Branches of the agent repository that are not lines agents should follow
# (the demo branch carries synthetic data for the public dashboard).
HIDDEN_BRANCHES = ("demo",)
REPOS = ("host", "agent", "agent-windows")

HOST_REFRESH_S = AGENT_REFRESH_S

_cache: dict[tuple[str, str], dict[str, Any]] = {}   # (repo, branch) -> parsed payload
_agent_fetched: dict[str, float] = {name: 0.0 for name in AGENT_REPOS}
_host_fetched_at = 0.0
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


def _running_branch() -> str | None:
    """The branch HEAD is on, None when detached (or when there is no git)."""
    out, _ = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    name = (out or "").strip()
    return name if name and name != "HEAD" else None


def _sync_host_remote() -> str:
    """Fetch the host checkout's own origin (remote-tracking refs only; the
    working tree and HEAD are never touched) at most once an hour, so a
    branch other than the running one is read as it is published. "" or the
    reason it could not be fetched -- the refs already there are served then,
    and the payload says when they were last fetched."""
    global _host_fetched_at
    if time.time() - _host_fetched_at < HOST_REFRESH_S:
        return ""
    _host_fetched_at = time.time()   # one attempt per window, success or not
    out, reason = _git(["fetch", "--quiet", "--prune", "origin"], ROOT, timeout=60)
    if out is None:
        return f"could not fetch the host repository: {reason}"
    return ""


def _host_branch_names() -> tuple[list[str] | None, str]:
    """Local heads and origin's remote-tracking heads, merged by name,
    HIDDEN_BRANCHES left out."""
    out, reason = _git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"])
    if out is None:
        return None, reason
    names: set[str] = set()
    for line in out.splitlines():
        name = line.strip()
        if name.startswith("origin/"):
            name = name[len("origin/"):]
        if name in ("", "origin", "HEAD") or name in HIDDEN_BRANCHES:
            continue
        names.add(name)
    return _sorted_branches(names), ""


def _sorted_branches(names: set[str]) -> list[str]:
    return sorted(names, key=lambda b: (b != "main", b != "dev", b))


def _tip_version(cwd: Any, ref: str) -> str | None:
    tip, _ = _git(["show", f"{ref}:version.json"], cwd)
    match = re.search(r'"version"\s*:\s*"([^"]+)"', tip or "")
    return match.group(1) if match else None


def _build_host(branch: str | None, running: str | None, problem: str) -> dict[str, Any]:
    """The host's notes at `branch`: HEAD when it is the running branch (or
    when there is none to name), otherwise origin's copy of the branch,
    falling back to a local head of that name."""
    version = __version__ if __version__ != "unknown" else None
    is_running = branch is None or branch == running
    base = {"repo": "host", "branch": branch or running, "running": is_running,
            "running_branch": running, "current": version if is_running else None,
            "fetched_at": _host_fetched_at or None, "stale_reason": None}
    if is_running:
        out = _build(ROOT, "HEAD", version)
        out.update(base)
        out["tip"] = version
        return out
    ref = None
    for candidate in (f"refs/remotes/origin/{branch}", f"refs/heads/{branch}"):
        exists, _ = _git(["rev-parse", "--verify", "--quiet", candidate])
        if exists is not None:
            ref = candidate
            break
    if ref is None:
        return {**base, "available": False, "commits": [], "tip": None,
                "reason": f"this checkout has no branch '{branch}'"
                          + (f" ({problem})" if problem else "")}
    tip = _tip_version(ROOT, ref)
    out = _build(ROOT, ref, tip)
    out.update(base)
    out["tip"] = tip
    out["stale_reason"] = problem or None
    return out


def _sync_agent_mirror(repo: str = "agent") -> str:
    """Clone the agent repository as a bare mirror on first use, then fetch
    it again when AGENT_REFRESH_S has passed. Returns "" or the reason the
    mirror could not be brought up to date (an existing mirror is still
    served then -- stale beats blank, and the payload says when it was
    fetched)."""
    url, mirror = AGENT_REPOS[repo]
    if not (mirror / "HEAD").exists():
        mirror.parent.mkdir(parents=True, exist_ok=True)
        out, reason = _git(["clone", "--mirror", "--quiet", url, str(mirror)],
                           ROOT, timeout=90)
        if out is None:
            return f"could not fetch the agent repository ({url}): {reason}"
        _agent_fetched[repo] = time.time()
        return ""
    if time.time() - _agent_fetched[repo] < AGENT_REFRESH_S:
        return ""
    _agent_fetched[repo] = time.time()   # one attempt per window, success or not
    out, reason = _git(["fetch", "--quiet", "--prune"], mirror, timeout=60)
    if out is None:
        return f"could not refresh the agent repository: {reason}"
    return ""


def branches(repo: str = "agent", refresh: bool = False) -> dict[str, Any]:
    """The branches `repo` has, HIDDEN_BRANCHES left out, for the pickers:
    the agent repository's from the mirror (Settings and Patch notes), the
    host's own from its checkout (local heads and origin's). `refresh`
    fetches first when the last fetch is older than BRANCH_REFRESH_S, so a
    branch pushed a minute ago shows up without waiting for the hourly sync.
    `default` is the branch the view opens on: the running one for the host,
    the configured update branch for the agent. Unavailable (with the
    reason) when there is no mirror / no checkout; the Settings picker then
    falls back to a typed name."""
    if repo not in REPOS:
        raise ValueError(f"unknown repo {repo!r}")
    global _host_fetched_at
    with _lock:
        if repo == "host":
            running = _running_branch()
            problem = _sync_host_remote()
            if refresh and not problem and time.time() - _host_fetched_at >= BRANCH_REFRESH_S:
                _host_fetched_at = time.time()
                out, reason = _git(["fetch", "--quiet", "--prune", "origin"], ROOT, timeout=60)
                problem = "" if out is not None else f"could not fetch the host repository: {reason}"
            names, reason = _host_branch_names()
            if names is None:
                if "not a git repository" in reason.lower():
                    reason = "this host is not running from a git checkout"
                return {"available": False, "reason": reason, "repo": "host", "branches": [],
                        "hidden": list(HIDDEN_BRANCHES), "default": running, "running": running,
                        "fetched_at": _host_fetched_at or None, "stale_reason": problem or None}
            if running and running not in names:
                names = _sorted_branches(set(names) | {running})
            return {"available": True, "reason": None, "repo": "host", "branches": names,
                    "hidden": list(HIDDEN_BRANCHES), "default": running, "running": running,
                    "fetched_at": _host_fetched_at or None, "stale_reason": problem or None}
        configured = config_module.get().agent_update_branch or "main"
        _url, mirror = AGENT_REPOS[repo]
        problem = _sync_agent_mirror(repo)
        if not (mirror / "HEAD").exists():
            return {"available": False, "reason": problem or "no mirror of the agent repository yet",
                    "repo": repo, "branches": [], "hidden": list(HIDDEN_BRANCHES),
                    "default": configured, "configured": configured, "fetched_at": None,
                    "stale_reason": None}
        if refresh and not problem and time.time() - _agent_fetched[repo] >= BRANCH_REFRESH_S:
            _agent_fetched[repo] = time.time()
            out, reason = _git(["fetch", "--quiet", "--prune"], mirror, timeout=60)
            problem = "" if out is not None else f"could not refresh the agent repository: {reason}"
        out, reason = _git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], mirror)
        if out is None:
            return {"available": False, "reason": f"could not list branches: {reason}",
                    "repo": repo, "branches": [], "hidden": list(HIDDEN_BRANCHES),
                    "default": configured, "configured": configured,
                    "fetched_at": _agent_fetched[repo] or None, "stale_reason": problem or None}
        names = _sorted_branches({line.strip() for line in out.splitlines() if line.strip()}
                                 - set(HIDDEN_BRANCHES))
        return {"available": True, "reason": None, "repo": repo, "branches": names,
                "hidden": list(HIDDEN_BRANCHES), "default": configured, "configured": configured,
                "fetched_at": _agent_fetched[repo] or None, "stale_reason": problem or None}


def _build_agent(repo: str, branch: str, problem: str) -> dict[str, Any]:
    out = _build_agent_inner(repo, branch, problem)
    # The version picker warns before a downgrade below the first build whose
    # updater works: from there the host cannot bring the agent back. Only
    # the Linux agent's line has such a build; the Windows one started after.
    from .nodes import MIN_SELF_UPDATE_VERSION
    out["min_self_update_version"] = MIN_SELF_UPDATE_VERSION if repo == "agent" else None
    out["configured_branch"] = config_module.get().agent_update_branch or "main"
    return out


def _build_agent_inner(repo: str, branch: str, problem: str) -> dict[str, Any]:
    url, mirror = AGENT_REPOS[repo]
    if problem and not (mirror / "HEAD").exists():
        return {"available": False, "reason": problem, "repo": repo, "current": None, "tip": None,
                "branch": branch, "commits": []}
    exists, _ = _git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], mirror)
    if exists is None:
        return {"available": False, "repo": repo, "current": None, "tip": None, "branch": branch,
                "commits": [], "reason": f"the agent repository has no branch '{branch}'"}
    tip = _tip_version(mirror, branch)
    out = _build(mirror, branch, tip)
    out["repo"] = repo
    out["branch"] = branch
    out["tip"] = tip
    out["source"] = url
    out["fetched_at"] = _agent_fetched[repo] or None
    out["stale_reason"] = problem or None
    return out


def load(repo: str = "host", branch: str | None = None) -> dict[str, Any]:
    """The parsed log for `repo` at `branch`. "host": this checkout -- the
    running branch (the default) is HEAD, parsed once per process; another
    branch is origin's copy, re-parsed after each fetch. "agent": the mirror
    at `branch`, the configured update branch by default, re-parsed after
    each fetch attempt. Safe to call from a thread."""
    if repo not in REPOS:
        raise ValueError(f"unknown repo {repo!r}")
    with _lock:
        if repo in AGENT_REPOS:
            branch = branch or config_module.get().agent_update_branch or "main"
            problem = _sync_agent_mirror(repo)
            key = (repo, branch)
            cached = _cache.get(key)
            if cached is None or cached.get("_fetched") != _agent_fetched[repo]:
                cached = _cache[key] = _build_agent(repo, branch, problem)
                cached["_fetched"] = _agent_fetched[repo]
        else:
            running = _running_branch()
            if branch is None or branch == running:
                key = (repo, "")
                cached = _cache.get(key)
                if cached is None:
                    cached = _cache[key] = _build_host(None, running, "")
            else:
                problem = _sync_host_remote()
                key = (repo, branch)
                cached = _cache.get(key)
                if cached is None or cached.get("_fetched") != _host_fetched_at:
                    cached = _cache[key] = _build_host(branch, running, problem)
                    cached["_fetched"] = _host_fetched_at
        if not cached["available"]:
            log.info("changelog (%s, %s) unavailable: %s", repo, cached.get("branch"), cached["reason"])
        return {k: v for k, v in cached.items() if not k.startswith("_")}
