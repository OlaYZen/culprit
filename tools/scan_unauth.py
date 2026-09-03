"""Hit every route with no session and no token -- find anything that answers.

`check_security.py` is the thorough black-box scan (path tricks, forged
cookies, header bypasses, timing, injection). This is the blunt version of one
question it asks, pulled out so it can be run on its own and read at a glance:

    for every route the app declares, send the request a total stranger would
    -- no `culprit_session` cookie, no `Authorization` header -- and see what
    comes back.

A properly gated route answers a stranger with 401 (the JSON API) or a 303 to
/login (an HTML page). Anything else on a route that is *meant* to need a
session is the finding: a 2xx means the endpoint served its data to nobody, a
5xx means it ran far enough to crash. The route list is not hand-written -- the
tool imports the app and walks `app.routes`, so a route added tomorrow (and the
one nobody remembered to gate) is scanned today.

    .venv/bin/python tools/scan_unauth.py                 # against a live host
    .venv/bin/python tools/scan_unauth.py --url https://hub:8787 --insecure
    .venv/bin/python tools/scan_unauth.py --port 8890 --json out.json

The public allowlist (`/login`, `/api/login`, `/api/auth`, `/api/healthz`,
`favicon`, `/assets/*`) is expected to answer without a session, so an open
response there is reported as OK, not a leak. The agent ingest
(`/api/agents/report`) is expected to *reject* an anonymous caller, so it is
held to the same 401 bar as the gated routes.

Write methods (POST/PUT/PATCH/DELETE) are sent only when auth is enabled: the
gate rejects them before they run, so nothing mutates. If the host has auth
disabled (the loopback, zero-users default) every route is open by design and
there is no gate to test -- the tool says so and does not send writes into an
unauthenticated server. Exit status is 1 if any gated route leaked.
"""

from __future__ import annotations

import argparse
import http.client
import json
import ssl
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

GREEN, RED, YELLOW, BLUE, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[34m", "\033[90m", "\033[1m",
    "\033[0m",
)

SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")


class Resp:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    @property
    def location(self) -> str:
        return self.headers.get("location", "")

    def text(self, n: int = 160) -> str:
        return self.body[:n].decode("utf-8", "replace").replace("\n", " ")


class Http:
    """Raw http.client so odd targets go on the wire exactly as written."""

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

    def req(self, method: str, target: str) -> Resp:
        """One unauthenticated request: no Cookie, no Authorization, ever."""
        conn = self._conn()
        try:
            conn.putrequest(method, target, skip_accept_encoding=True)
            conn.putheader("User-Agent", "culprit-scan-unauth/1")
            conn.endheaders()
            raw = conn.getresponse()
            body = raw.read(65536)  # SSE never ends; a bounded slice is plenty.
            return Resp(raw.status, {k.lower(): v for k, v in raw.getheaders()}, body)
        finally:
            conn.close()


def enumerate_routes() -> list[tuple[str, frozenset[str]]]:
    """Every (path, methods) the app declares, static mount included."""
    from culprit.main import app  # module-level FastAPI app; lifespan never runs
    routes: list[tuple[str, frozenset[str]]] = []
    for route in app.routes:
        path = getattr(route, "path", None)
        if not path:
            continue
        methods = getattr(route, "methods", None)
        if methods is None:  # a Mount (the /assets static files)
            routes.append((path.rstrip("/") + "/", frozenset({"GET"})))
        else:
            keep = frozenset(m for m in methods if m != "HEAD")
            if keep:
                routes.append((path, keep))
    # Deduplicate, stable by path.
    seen: dict[str, frozenset[str]] = {}
    for path, methods in routes:
        seen[path] = seen.get(path, frozenset()) | methods
    return sorted(seen.items())


def fill(path: str) -> str:
    """Concrete, harmless values for path parameters."""
    return (path.replace("{name}", "scan-unauth-nope")
            .replace("{pid}", "1")
            .replace("{node}", "scan-unauth-nope")
            .replace("{path:path}", "x")
            .replace("{path}", "x"))


def public_matcher():  # type: ignore[no-untyped-def]
    """(is_public, is_agent) predicates straight from auth.py, so this tool
    never drifts from the allowlist it is judging against."""
    import culprit.auth as auth
    public = set(auth.PUBLIC_PATHS)
    agent = set(auth.AGENT_PATHS)
    prefixes = tuple(auth.PUBLIC_PREFIXES)
    return (lambda p: p in public or p.startswith(prefixes)), (lambda p: p in agent)


def auth_enabled(http: Http) -> bool | None:
    """Ask the one public status endpoint whether the gate is armed."""
    try:
        r = http.req("GET", "/api/auth")
    except OSError:
        return None
    try:
        return bool((json.loads(r.body) or {}).get("enabled"))
    except (ValueError, AttributeError):
        return None


# ------------------------------------------------------------------ verdicts
CRIT, HIGH, WARN, OK, INFO = "CRIT", "HIGH", "WARN", "OK", "INFO"
COLOUR = {CRIT: RED + BOLD, HIGH: RED, WARN: YELLOW, OK: GREEN, INFO: BLUE}


def judge(is_api: bool, r: Resp) -> tuple[str, str]:
    """Classify a gated route's response to an anonymous caller."""
    s = r.status
    if is_api:
        if s == 401:
            return OK, "401 -- gate holds"
        if s in (405, 404) and s != 200:
            # Middleware gates before routing, so a gated /api/* should be 401
            # even for an undeclared method; anything else is worth a look.
            return WARN, f"{s} -- not the 401 a gated API should give"
        if 200 <= s < 300:
            return CRIT, f"{s} -- served its body with no session ({len(r.body)}B)"
        if 500 <= s < 600:
            return HIGH, f"{s} -- reached the handler and crashed"
        if s in (301, 302, 303, 307, 308):
            return WARN, f"{s} -> {r.location or '?'}"
        return WARN, f"{s} -- unexpected"
    # HTML page: the gate answers with a redirect to the login screen.
    if s in (302, 303, 307) and "/login" in r.location:
        return OK, f"{s} -> {r.location} -- gate holds"
    if s == 401:
        return OK, "401 -- gate holds"
    if 200 <= s < 300:
        return CRIT, f"{s} -- rendered the page with no session ({len(r.body)}B)"
    if 500 <= s < 600:
        return HIGH, f"{s} -- reached the handler and crashed"
    return WARN, f"{s} -- unexpected"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--url", default=None, help="base URL (default http://127.0.0.1:<port>)")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--insecure", action="store_true", help="skip TLS verification")
    p.add_argument("--timeout", type=float, default=8.0)
    p.add_argument("--force-writes", action="store_true",
                   help="send write methods even when auth is disabled (mutates!)")
    p.add_argument("--json", metavar="PATH", help="write findings as JSON")
    p.add_argument("--strict", action="store_true", help="exit 1 on WARN too")
    args = p.parse_args()

    url = args.url or f"http://127.0.0.1:{args.port}"
    http = Http(url, args.insecure, args.timeout)
    print(f"{BOLD}culprit unauth scan{RESET}  {DIM}{url}{RESET}")

    try:
        routes = enumerate_routes()
    except Exception as exc:  # noqa: BLE001
        print(f"  {RED}could not import the app to list routes:{RESET} {exc}")
        return 2

    is_public, is_agent = public_matcher()
    try:
        http.req("GET", "/api/auth")
    except OSError as exc:
        print(f"  {RED}no server answering at {url}:{RESET} {exc}")
        print(f"  {DIM}start one with ./culprit.sh, then re-run this.{RESET}")
        return 2
    armed = auth_enabled(http)

    if armed is False:
        print(f"\n  {YELLOW}auth is DISABLED on this host{RESET} -- zero users, so the "
              "gate is open by design.")
        print(f"  {DIM}Every route below answers anyone; that is only safe on the "
              f"loopback. Create a user to arm the gate.{RESET}")
    elif armed is None:
        print(f"  {YELLOW}could not tell whether auth is enabled{RESET} -- treating "
              "routes as gated.")
    else:
        print(f"  {DIM}auth is enabled -- every gated route must reject a stranger.{RESET}")

    methods_to_send = SAFE_METHODS + WRITE_METHODS
    if armed is False and not args.force_writes:
        # No gate to stop them: a write would actually run. Don't mutate.
        methods_to_send = SAFE_METHODS

    findings: list[dict[str, object]] = []
    leaks = warns = 0
    print(f"\n{BOLD}{len(routes)} routes{RESET}")
    for path, declared in sorted(routes):
        target = fill(path)
        is_api = path.startswith("/api/")
        agent = is_agent(path)
        public = is_public(path) and not agent
        for method in [m for m in methods_to_send if m in declared] or ["GET"]:
            # Send declared methods; for an undeclared write we still probe GET
            # above. Only send a method the route declares to avoid noise.
            try:
                r = http.req(method, target)
            except OSError as exc:
                print(f"  {YELLOW}{method:6}{RESET} {path}  {DIM}(no response: {exc}){RESET}")
                continue

            if armed is False:
                # Nothing to judge: the gate is deliberately open.
                level, note = INFO, f"{r.status} (auth off)"
            elif public:
                # Meant to be open. Only a 5xx is interesting here.
                if 500 <= r.status < 600:
                    level, note = HIGH, f"{r.status} -- public route crashed"
                else:
                    level, note = OK, f"{r.status} -- public, open as intended"
            else:
                # Gated routes and the agent ingest are both held to the 401 bar.
                level, note = judge(is_api, r)

            if level in (CRIT, HIGH):
                leaks += 1
            elif level == WARN:
                warns += 1
            if level != OK or armed is None:
                col = COLOUR[level]
                tag = " [public]" if public else (" [agent]" if agent else "")
                print(f"  {col}{level:<4}{RESET} {method:6} {path}{DIM}{tag}{RESET}  {note}")
            findings.append({"method": method, "path": path, "status": r.status,
                             "level": level, "note": note,
                             "public": public, "agent": agent})

    # --------------------------------------------------------------- summary
    print(f"\n{BOLD}summary{RESET}  {len(findings)} requests, "
          f"{RED if leaks else GREEN}{leaks} leak(s){RESET}, {warns} warning(s)")
    if armed is False:
        print(f"  {YELLOW}gate disabled{RESET} -- run again once a user exists to test it.")
    elif leaks:
        for f in findings:
            if f["level"] in (CRIT, HIGH):
                print(f"  {COLOUR[str(f['level'])]}{f['level']}{RESET} "
                      f"{f['method']} {f['path']}: {f['note']}")
        print(f"{RED}{BOLD}VULNERABLE{RESET} -- a route answered without a session.")
    else:
        print(f"{GREEN}OK{RESET} -- every gated route refused the anonymous request.")

    if args.json:
        Path(args.json).write_text(json.dumps(
            {"url": url, "auth_enabled": armed, "findings": findings}, indent=2))
        print(f"  {DIM}wrote {args.json}{RESET}")

    if leaks:
        return 1
    if args.strict and warns:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
