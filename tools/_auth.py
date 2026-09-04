"""Saved credentials for the live tools: `tools_auth.json` at the repo root.

The live checks (check_contract, check_security, check_ingest, scan_unauth)
all need the same three things -- where the host is, a dashboard user's
password, and for the ingest check an agent token -- and typing them on every
run is how they stop being run. So, like the agent's `agent.json`, they can
be saved once (`--save-auth` on any tool) and are then the defaults; anything
given on the command line still wins for that run.

    {"url": "http://127.0.0.1:8787", "user": "ola", "password": "...",
     "token": "<name>.<secret>", "node": "web-01", "insecure": false}

It holds a password and a token in the clear, so it is written mode 600, is
gitignored, and the security audit fails if it is ever tracked or readable by
other users. `--no-auth-file` ignores it for one run.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "tools_auth.json"
FIELDS = ("url", "user", "password", "token", "node", "insecure")


def load() -> dict:
    """The saved values, or {} (a missing or unreadable file is not an error)."""
    try:
        raw = json.loads(PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: raw[k] for k in FIELDS if k in raw and raw[k] not in (None, "")}


def save(values: dict) -> Path:
    """Merge `values` (only the known fields, only those set) into the file."""
    merged = load()
    for key in FIELDS:
        value = values.get(key)
        if value not in (None, "", False):
            merged[key] = value
    PATH.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    os.chmod(PATH, 0o600)
    return PATH


def add_arguments(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group(
        "saved credentials",
        f"defaults come from {PATH.name} at the repo root (url, user, password, "
        "token, node, insecure); the command line wins for the run")
    group.add_argument("--save-auth", action="store_true",
                       help=f"save the url/user/password/token/node given on this "
                            f"command line to {PATH.name} (mode 600) for next time")
    group.add_argument("--no-auth-file", action="store_true",
                       help=f"ignore {PATH.name} for this run")


def apply(args: argparse.Namespace, uses: tuple[str, ...] = FIELDS) -> str | None:
    """Fill the unset fields of `args` from the file; save first when asked.

    Returns a one-line note saying what was taken from the file (None when
    nothing was), for the tool to print so the source of a credential is
    never a mystery. Tools that take --host/--port instead of --url get them
    derived from the saved url.
    """
    if getattr(args, "save_auth", False):
        given = {key: getattr(args, key, None) for key in FIELDS}
        if "url" not in given or not given["url"]:
            host, port = getattr(args, "host", None), getattr(args, "port", None)
            if host and port and (host != "127.0.0.1" or port != 8787):
                given["url"] = f"http://{host}:{port}"
        save(given)
        print(f"saved credentials to {PATH}")
    if getattr(args, "no_auth_file", False):
        return None
    saved = load()
    if not saved:
        return None
    taken = []
    for key in uses:
        if key not in saved:
            continue
        current = getattr(args, key, None)
        if current in (None, "", False):
            setattr(args, key, saved[key])
            taken.append(key)
    if "url" in saved and "url" not in uses and hasattr(args, "host") and hasattr(args, "port"):
        # --host/--port style tools: only when both are still at their defaults.
        if args.host == "127.0.0.1" and args.port == 8787:
            parts = urlsplit(str(saved["url"]))
            if parts.hostname:
                args.host = parts.hostname
                args.port = parts.port or (443 if parts.scheme == "https" else 80)
                taken.append("url")
    if not taken:
        return None
    shown = []
    for key in taken:
        if key == "password":
            shown.append("password")
        elif key == "token":
            shown.append(f"token for {str(saved['token']).partition('.')[0]}")
        else:
            shown.append(f"{key}={saved[key]}")
    return f"using {PATH.name}: {', '.join(shown)}"
