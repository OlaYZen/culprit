"""Hit every route with a viewer session, an operator session, and an admin
session -- find any route a role reaches that it shouldn't.

`scan_unauth.py` asks one question of every route: does it reject a total
stranger? This asks a second one: does it reject a session that exists but
isn't privileged *enough*? A route's minimum role is not a hand-maintained
list here either -- it is `main.require_role(...)`, declared as
`dependencies=[Depends(require_role("operator"))]` on the route itself and
tagged with `.minimum_role`, so this tool reads it straight off `app.routes`
exactly the way `scan_unauth.py` reads the public allowlist off `auth.py`. A
route added tomorrow without that dependency defaults to `viewer` (any
session at all) -- the same default every gated route already had before
roles existed -- and is tested against that default, not silently skipped.

What gets sent, and why nothing here mutates real state:

* For a role *below* a route's minimum, the request goes out on every method
  the route declares, with harmless path-parameter fill and no body. A
  correctly-declared `require_role` dependency raises its 403 before the
  handler -- before body parsing, before the path parameter is even looked
  up in the database -- so this is true regardless of method: a role that
  should be refused can be sent a POST or a DELETE with total safety, because
  a working gate never lets it reach anything that touches state.  (Confirmed
  empirically, not just asserted: an unprivileged session sending no body to
  `POST /api/agents` or `PUT /api/settings` gets 403, never a body-shape
  error -- the dependency wins the race every time.)
* For a role *at or above* a route's minimum, only GET is sent (read-only,
  nothing to clean up); write methods for an already-cleared role are
  skipped rather than actually run, so this tool never enrols a real agent,
  creates a real expectation, or changes real settings. The positive path
  for a write route -- that operator/admin really can complete the action --
  is `check_security.py --active`'s job (`check_role_gate`), which runs the
  two representative flows end to end and cleans up after itself.

So this tool is exhaustive for the dangerous direction (nobody under-
protected) and exhaustive-for-GETs in the other (nobody over-protected);
write-route over-protection would show as a real user complaint before it
would show here, and is the one gap `check_role_gate` cannot see instead
(it only checks two routes) -- read the two together, not either alone.

Needs an existing admin (`--user`/`--password`) to bootstrap: it creates one
throwaway viewer and one throwaway operator account through `/api/users`,
signs in as each, runs the matrix, and deletes both -- so it shares the
`tools_auth.json` convention with the other live tools (`--save-auth` once,
then no arguments).

    .venv/bin/python tools/check_role_matrix.py --user admin --password admin
    .venv/bin/python tools/check_role_matrix.py --url https://hub:8787 --insecure

Exit status is 1 if any role reached a route it should have been refused, or
(with --strict) if a GET wrongly blocked a role that should have passed.
"""

from __future__ import annotations

import argparse
import http.client
import json
import re
import secrets
import ssl
import sys
from pathlib import Path
from urllib.parse import urlsplit

import _auth  # noqa: E402 -- tools/ is sys.path[0] when run as a script

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

GREEN, RED, YELLOW, BLUE, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[34m", "\033[90m", "\033[1m",
    "\033[0m",
)

ROLES = ("viewer", "operator", "admin")


class Resp:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):  # type: ignore[no-untyped-def]
        try:
            return json.loads(self.body)
        except ValueError:
            return None

    def text(self, n: int = 160) -> str:
        return self.body[:n].decode("utf-8", "replace").replace("\n", " ")


class Http:
    def __init__(self, url: str, insecure: bool, timeout: float) -> None:
        parts = urlsplit(url)
        self.scheme = parts.scheme or "http"
        self.host = parts.hostname or "127.0.0.1"
        self.port = parts.port or (443 if self.scheme == "https" else 80)
        self.timeout = timeout
        self.context: ssl.SSLContext | None = None
        if self.scheme == "https":
            self.context = ssl.create_default_context()
            if insecure:
                self.context.check_hostname = False
                self.context.verify_mode = ssl.CERT_NONE

    def _conn(self) -> http.client.HTTPConnection:
        if self.scheme == "https":
            return http.client.HTTPSConnection(self.host, self.port,
                                               timeout=self.timeout,
                                               context=self.context)
        return http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)

    def req(self, method: str, target: str, *, cookie: str | None = None,
            json_body: object = None) -> Resp:
        conn = self._conn()
        try:
            hdrs = {"User-Agent": "culprit-role-matrix/1"}
            body: bytes | None = None
            if json_body is not None:
                body = json.dumps(json_body).encode()
                hdrs["Content-Type"] = "application/json"
            if cookie is not None:
                hdrs["Cookie"] = f"culprit_session={cookie}"
            conn.putrequest(method, target, skip_accept_encoding=True)
            for k, v in hdrs.items():
                conn.putheader(k, v)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders(body)
            raw = conn.getresponse()
            data = raw.read(65536)
            return Resp(raw.status, {k.lower(): v for k, v in raw.getheaders()}, data)
        finally:
            conn.close()


# ------------------------------------------------------------------ routes
def fill(path: str) -> str:
    """Concrete, harmless values for every path parameter this app declares
    (`grep -oP '@app\\.(get|post|put|delete|patch)\\("\\K[^"]+' culprit/main.py`
    is how to find a new one) -- numeric where the type is `int` so path
    coercion never gets a chance to answer before the role dependency does."""
    return (path.replace("{name}", "role-matrix-nope")
            .replace("{pid}", "1")
            .replace("{action_id}", "1")
            .replace("{death_id}", "1")
            .replace("{expectation_id}", "1"))


def route_minimum_role(route) -> str:  # type: ignore[no-untyped-def]
    """The role `require_role(...)` tagged onto this route's dependencies,
    or 'viewer' (any session) for a route with no such dependency -- the
    same default every gated route had before roles existed."""
    dependant = getattr(route, "dependant", None)
    for dep in getattr(dependant, "dependencies", None) or []:
        minimum = getattr(dep.call, "minimum_role", None)
        if minimum:
            return minimum
    return "viewer"


def enumerate_role_routes():  # type: ignore[no-untyped-def]
    """(path, method, minimum_role, is_public, is_agent) for every route --
    one entry per method, since two methods on the same path can carry
    different dependencies (and so a different minimum role)."""
    from culprit.auth import AGENT_PATHS, PUBLIC_PATHS, PUBLIC_PREFIXES
    from culprit.main import app  # module-level app; lifespan never runs
    public = set(PUBLIC_PATHS)
    prefixes = tuple(PUBLIC_PREFIXES)
    agent = set(AGENT_PATHS)
    out = []
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue  # a Mount (the /assets static files): no role to test
        is_public = path in public or path.startswith(prefixes)
        is_agent = path in agent
        minimum = route_minimum_role(route)
        for method in sorted(m for m in methods if m != "HEAD"):
            out.append((path, method, minimum, is_public, is_agent))
    return sorted(set(out))


# --------------------------------------------------------------- bootstrap
def login(http: Http, username: str, password: str) -> str | None:
    r = http.req("POST", "/api/login",
                 json_body={"username": username, "password": password})
    if r.status != 200:
        return None
    m = re.search(r"culprit_session=([^;]+)", r.headers.get("set-cookie") or "")
    return m.group(1) if m else None


def create_throwaway(http: Http, admin_cookie: str, role: str) -> tuple[str, str] | None:
    name = f"rolematrix-{role}-{secrets.token_hex(3)}"
    password = secrets.token_urlsafe(16)
    r = http.req("POST", "/api/users", cookie=admin_cookie,
                json_body={"username": name, "password": password, "role": role})
    if r.status != 200:
        return None
    return name, password


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--url", default=None)
    p.add_argument("--user", default=None, help="an existing admin username")
    p.add_argument("--password", default=None)
    p.add_argument("--insecure", action="store_true")
    p.add_argument("--timeout", type=float, default=8.0)
    p.add_argument("--strict", action="store_true",
                   help="exit 1 on an over-protected GET too, not just an "
                        "under-protected route")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="print every passing probe, not just findings")
    _auth.add_arguments(p)
    args = p.parse_args()
    note = _auth.apply(args, uses=("url", "user", "password", "insecure"))
    if note:
        print(f"{DIM}{note}{RESET}")
    if not (args.user and args.password):
        print("error: --user/--password (an existing admin) is required to "
              "bootstrap the throwaway viewer/operator accounts", file=sys.stderr)
        return 2

    url = args.url or "http://127.0.0.1:8787"
    http = Http(url, args.insecure, args.timeout)
    print(f"{BOLD}culprit role matrix{RESET}  {DIM}{url}{RESET}")

    admin_cookie = login(http, args.user, args.password)
    if not admin_cookie:
        print(f"  {RED}could not sign in as {args.user!r}{RESET}", file=sys.stderr)
        return 2

    try:
        routes = enumerate_role_routes()
    except Exception as exc:  # noqa: BLE001
        print(f"  {RED}could not import the app to list routes:{RESET} {exc}")
        return 2

    created: list[str] = []
    cookies: dict[str, str] = {"admin": admin_cookie}
    try:
        for role in ("viewer", "operator"):
            creds = create_throwaway(http, admin_cookie, role)
            if not creds:
                print(f"  {RED}could not create a throwaway {role}{RESET}")
                return 2
            name, password = creds
            created.append(name)
            cookie = login(http, name, password)
            if not cookie:
                print(f"  {RED}throwaway {role} {name!r} could not sign in{RESET}")
                return 2
            cookies[role] = cookie

        from culprit.auth import ROLE_RANK

        tested = under = over = 0
        print(f"\n{BOLD}{len(routes)} route/method pairs, {len(ROLES)} roles{RESET}")
        for path, method, minimum, is_public, is_agent in routes:
            if is_public or is_agent or path == "/api/stream":
                continue  # nothing here for a role to be checked against
            target = fill(path)
            for role in ROLES:
                expect_forbidden = ROLE_RANK[role] < ROLE_RANK[minimum]
                if not expect_forbidden and method != "GET":
                    continue  # would-succeed write: skip, don't actually run it
                tested += 1
                try:
                    r = http.req(method, target, cookie=cookies[role])
                except OSError as exc:
                    print(f"  {YELLOW}WARN{RESET} {method:6} {path} as {role}: "
                          f"no response ({exc})")
                    continue
                if expect_forbidden:
                    if r.status == 403:
                        if args.verbose:
                            print(f"  {GREEN}ok{RESET}   {method:6} {path} "
                                  f"[{minimum}] refuses {role}")
                    else:
                        under += 1
                        print(f"  {RED}CRIT{RESET} {method:6} {path} [{minimum}] "
                              f"-- {role} got {r.status}, not 403: "
                              f"{(r.json() or {}).get('detail', r.text(80))!r}")
                else:
                    if r.status != 403:
                        if args.verbose:
                            print(f"  {GREEN}ok{RESET}   {method:6} {path} "
                                  f"[{minimum}] lets {role} through ({r.status})")
                    else:
                        over += 1
                        print(f"  {YELLOW}WARN{RESET} {method:6} {path} [{minimum}] "
                              f"-- {role} wrongly refused (403)")
    finally:
        for name in created:
            http.req("DELETE", f"/api/users/{name}", cookie=admin_cookie)

    print(f"\n{BOLD}summary{RESET}  {tested} probes  "
          f"{RED if under else GREEN}{under} under-protected{RESET}  "
          f"{YELLOW if over else GREEN}{over} over-protected{RESET}")
    if under:
        print(f"{RED}{BOLD}VULNERABLE{RESET} -- a role reached a route above its rank.")
    elif over and args.strict:
        print(f"{YELLOW}FAIL (strict){RESET} -- a role was wrongly refused a route it should reach.")
    else:
        print(f"{GREEN}OK{RESET}")
    if under or (over and args.strict):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
