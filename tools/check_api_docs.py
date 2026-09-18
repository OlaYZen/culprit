"""docs/API.md describes every route the host serves -- and says so, which
makes it a claim worth checking.

Offline (~1 s): imports the FastAPI app, walks `app.routes`, and compares
with the `### METHOD /path` headings in docs/API.md and the `**Access:**`
line under each:

* a route with no heading is a finding (the endpoint nobody documented);
* a heading with no route is a finding (the endpoint that was removed or
  renamed while its documentation lived on);
* the access written down must be the access enforced: `public` and `agent
  token` from auth.py's path sets, the role from the route's `require_role`
  dependency (viewer when it has none), and `session only` exactly where
  the route carries `require_session` -- the same tags
  tools/check_role_matrix.py and tools/check_auth.py read, so the three
  cannot disagree about a route without one of them failing.

    .venv/bin/python tools/check_api_docs.py        # exit 1 on any drift
"""

from __future__ import annotations

import logging
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
DOC = ROOT / "docs" / "API.md"

GREEN, RED, DIM, BOLD, RESET = "\033[32m", "\033[31m", "\033[90m", "\033[1m", "\033[0m"

HEADING = re.compile(r"^### (GET|POST|PUT|DELETE|PATCH) (/\S*)\s*$")
ACCESS = re.compile(r"^\*\*Access:\*\* (public|agent token|viewer|operator|admin)( · session only)?\s*$")


def enforced() -> dict[tuple[str, str], tuple[str, bool]]:
    """(method, path) -> (access, session_only), from the app itself."""
    os.environ["CULPRIT_NO_BROWSER"] = "1"
    logging.disable(logging.CRITICAL)
    from starlette.routing import Mount

    from culprit.auth import AGENT_PATHS, PUBLIC_PATHS, PUBLIC_PREFIXES
    from culprit.main import app

    out: dict[tuple[str, str], tuple[str, bool]] = {}
    for route in app.routes:
        if isinstance(route, Mount):
            # The static mount: one documented line stands for the tree.
            public = (route.path + "/").startswith(PUBLIC_PREFIXES)
            out[("GET", route.path + "/{path}")] = ("public" if public else "viewer", False)
            continue
        deps = getattr(getattr(route, "dependant", None), "dependencies", None) or []
        role = next((d.call.minimum_role for d in deps
                     if getattr(d.call, "minimum_role", None)), "viewer")
        session_only = any(getattr(d.call, "session_only", False) for d in deps)
        if route.path in PUBLIC_PATHS:
            access = "public"
        elif route.path in AGENT_PATHS:
            access = "agent token"
        else:
            access = role
        for method in sorted((route.methods or set()) - {"HEAD", "OPTIONS"}):
            out[(method, route.path)] = (access, session_only)
    return out


def documented() -> tuple[dict[tuple[str, str], tuple[str, bool] | None], list[str]]:
    """(method, path) -> what the doc says (None when the heading has no
    Access line before the next heading), plus duplicate headings."""
    found: dict[tuple[str, str], tuple[str, bool] | None] = {}
    duplicates: list[str] = []
    current: tuple[str, str] | None = None
    fenced = False
    for line in DOC.read_text(encoding="utf-8").splitlines():
        if line.startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        heading = HEADING.match(line)
        if heading:
            current = (heading.group(1), heading.group(2))
            if current in found:
                duplicates.append(f"{current[0]} {current[1]}")
            found[current] = None
            continue
        if line.startswith("#"):
            current = None
            continue
        access = ACCESS.match(line)
        if access and current and found.get(current) is None:
            found[current] = (access.group(1), bool(access.group(2)))
    return found, duplicates


def main() -> int:
    print(f"{BOLD}culprit API documentation check{RESET}  {DIM}{DOC.relative_to(ROOT)}{RESET}")
    if not DOC.exists():
        print(f"{RED}FAIL{RESET} {DOC} does not exist")
        return 1
    real = enforced()
    doc, duplicates = documented()
    problems: list[str] = []
    for method, path in sorted(set(real) - set(doc), key=lambda k: (k[1], k[0])):
        problems.append(f"undocumented route: {method} {path}")
    for method, path in sorted(set(doc) - set(real), key=lambda k: (k[1], k[0])):
        problems.append(f"documented, but no such route: {method} {path}")
    for name in duplicates:
        problems.append(f"documented twice: {name}")
    for key in sorted(set(real) & set(doc), key=lambda k: (k[1], k[0])):
        said, is_ = doc[key], real[key]
        label = f"{key[0]} {key[1]}"
        if said is None:
            problems.append(f"{label}: no '**Access:** ...' line under its heading")
        elif said != is_:
            def words(v: tuple[str, bool]) -> str:
                return v[0] + (" · session only" if v[1] else "")
            problems.append(f"{label}: documented as '{words(said)}', enforced as '{words(is_)}'")
    for problem in problems:
        print(f"  {RED}FAIL{RESET} {problem}")
    print(f"\n{BOLD}summary{RESET}  {len(real)} routes, {len(doc)} documented, "
          f"{len(problems)} problem(s)")
    print(f"{RED}FAIL{RESET}" if problems else
          f"{GREEN}OK{RESET} -- every route is documented with the access it enforces.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
