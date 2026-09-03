"""Probe a running Culprit host for the ways it could leak a machine's state.

`check_contract.py` proves the data the views read is there. This proves the
data is *not* there for anyone who should not have it: every route sits behind
the session gate, the gate cannot be walked around with path tricks, sessions
cannot be forged, logins cannot be enumerated or brute-forced, the agent ingest
rejects bad tokens and oversized bodies, and no response carries a credential,
a filesystem path or a header that would let a hostile page frame or read the
dashboard. The checks are black-box on purpose: they exercise the same wire a
stranger on the network would, so a regression in the middleware, a new route
that forgot the gate, or a reverse proxy that strips a header all show up here
and nowhere else.

Route coverage is not a hand-written list. The tool imports the FastAPI app and
walks `app.routes`, so a route added tomorrow is probed today -- the point is
to catch the endpoint nobody remembered to think about.

    .venv/bin/python tools/check_security.py                     # safe probes only
    .venv/bin/python tools/check_security.py --user u --password p   # + authenticated checks
    .venv/bin/python tools/check_security.py --active --user u --password p
    .venv/bin/python tools/check_security.py --url https://hub:8787 --insecure

Safe mode never changes server state and spends at most five of the eight login
failures the host allows per source address per five minutes, so a dashboard
user on the same address is never locked out by a scan. `--active` adds the
checks that do mutate: enrolling (and deleting) a throwaway agent to prove the
token lifecycle end to end, and deliberately exhausting the login rate limit,
which locks the scanner's own address out for five minutes.

`--throwaway-user` creates a temporary dashboard user through the CLI (so the
server must share this checkout's database), which also unlocks the one check
that must change a password: that changing it revokes every other session.
`--only`/`--skip` select groups (surface, gate, browser, credentials,
robustness, authenticated, active); `--json` writes the findings for CI.

Exit status is 1 when any CRIT or HIGH finding exists (`--strict` promotes
WARN), so it can gate a deploy.
"""

from __future__ import annotations

import argparse
import gzip
import http.client
import json
import re
import secrets
import socket
import ssl
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

GREEN, RED, YELLOW, BLUE, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[34m", "\033[90m", "\033[1m",
    "\033[0m",
)

# What is *meant* to be reachable without a session. If auth.py grows a new
# public path this check fails until the list here is updated -- deliberately,
# because "open" is the one property a route should never acquire by accident.
EXPECTED_PUBLIC_PATHS = frozenset({
    "/login", "/api/login", "/api/auth", "/api/healthz", "/favicon.svg",
})
EXPECTED_AGENT_PATHS = frozenset({"/api/agents/report"})
EXPECTED_PUBLIC_PREFIXES = ("/assets/",)

# Keys whose presence in any response body a signed-in user can fetch would
# mean a credential (or its hash) escaped the database.
SECRET_KEY_RE = re.compile(
    r"(token_hash|password|passwd|secret|private_key|session_secret)", re.I)
# Exceptions: settings that merely *mention* a credential-shaped word.
SECRET_KEY_ALLOW = frozenset({"allow_process_actions"})

LOGIN_FAILURE_BUDGET = 8       # auth.Auth._MAX_ATTEMPTS
SAFE_LOGIN_FAILURES = 5        # what safe mode may spend of that budget

UNAUTH_API_BODY = {"detail": "authentication required"}
GROUPS = ("surface", "gate", "browser", "credentials", "robustness",
          "authenticated", "active")
# Strings that mean an exception or an internal path escaped into a response.
LEAK_HIGH = ("Traceback (most recent call last)", 'File "/', "Exception:")
LEAK_WARN = ("sqlite3.", "psutil.", "uvicorn", "starlette", str(ROOT))
# What a leaked credential row actually looks like (the *name* password_hash
# appears legitimately when a probe string is echoed back).
HASH_VALUE_RE = re.compile(r"scrypt\$[0-9a-f]{16,}\$[0-9a-f]{32,}")
NUL = chr(0)


# ------------------------------------------------------------------ plumbing
@dataclass
class Resp:
    status: int
    headers: dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def json(self) -> Any:
        try:
            return json.loads(self.body)
        except ValueError:
            return None

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())


class Http:
    """Raw HTTP so request targets go on the wire exactly as written
    (`//api/x`, `/assets/../x`, `%2e%2e`): urllib would tidy some of them."""

    def __init__(self, url: str, insecure: bool, timeout: float = 8.0) -> None:
        parts = urlsplit(url)
        self.scheme = parts.scheme or "http"
        self.host = parts.hostname or "127.0.0.1"
        self.port = parts.port or (443 if self.scheme == "https" else 80)
        self.timeout = timeout
        # Called with (method, target, Resp) for every response, so one place
        # can scan every body for a leaked traceback or path.
        self.observer = None
        self.context: ssl.SSLContext | None = None
        if self.scheme == "https":
            self.context = ssl.create_default_context()
            if insecure:
                self.context.check_hostname = False
                self.context.verify_mode = ssl.CERT_NONE

    def _conn(self, timeout: float | None = None) -> http.client.HTTPConnection:
        t = timeout or self.timeout
        if self.scheme == "https":
            return http.client.HTTPSConnection(self.host, self.port, timeout=t,
                                               context=self.context)
        return http.client.HTTPConnection(self.host, self.port, timeout=t)

    def req(self, method: str, target: str, *, body: bytes | str | None = None,
            headers: dict[str, str] | None = None, cookie: str | None = None,
            json_body: Any = None, max_read: int = 4 * 1024 * 1024,
            timeout: float | None = None) -> Resp:
        hdrs = {"User-Agent": "culprit-check-security/1"}
        if json_body is not None:
            body = json.dumps(json_body).encode()
            hdrs["Content-Type"] = "application/json"
        if isinstance(body, str):
            body = body.encode()
        if headers:
            hdrs.update(headers)
        if cookie is not None:
            hdrs["Cookie"] = f"culprit_session={cookie}"
        conn = self._conn(timeout)
        try:
            conn.putrequest(method, target, skip_accept_encoding=True)
            for k, v in hdrs.items():
                conn.putheader(k, v)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders(body)
            raw = conn.getresponse()
            # Streaming responses (SSE) never end: read a bounded slice.
            data = raw.read(max_read)
            resp = Resp(raw.status, {k.lower(): v for k, v in raw.getheaders()},
                        data)
            if self.observer is not None:
                self.observer(method, target, resp)
            return resp
        finally:
            conn.close()

    def raw(self, data: bytes, timeout: float = 6.0) -> tuple[int | None, bytes]:
        """Send bytes verbatim -- HTTP/1.0, a smuggling-shaped request, a
        header the client library would refuse to build -- and return the
        status (None if the server just closed the connection) and body."""
        sock = socket.create_connection((self.host, self.port), timeout=timeout)
        try:
            if self.context is not None:
                sock = self.context.wrap_socket(sock, server_hostname=self.host)
            sock.sendall(data)
            chunks: list[bytes] = []
            total = 0
            try:
                while total < 65536:
                    part = sock.recv(16384)
                    if not part:
                        break
                    chunks.append(part)
                    total += len(part)
            except (socket.timeout, OSError):
                pass
        finally:
            sock.close()
        body = b"".join(chunks)
        m = re.match(rb"HTTP/\d\.\d (\d{3})", body)
        return (int(m.group(1)) if m else None), body


@dataclass
class Finding:
    level: str          # CRIT | HIGH | WARN | INFO | PASS
    check: str
    detail: str


LEVEL_ORDER = ["PASS", "INFO", "WARN", "HIGH", "CRIT"]


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    login_failures: int = 0
    quiet: bool = False

    def add(self, level: str, check: str, detail: str) -> None:
        self.findings.append(Finding(level, check, detail))
        if self.quiet and level == "PASS":
            return
        colour = {"CRIT": RED + BOLD, "HIGH": RED, "WARN": YELLOW,
                  "INFO": BLUE, "PASS": GREEN}[level]
        print(f"  {colour}{level:<4}{RESET} {check}: {detail}")

    def ok(self, check: str, detail: str) -> None:
        self.add("PASS", check, detail)

    def worst(self) -> str:
        return max((f.level for f in self.findings), key=LEVEL_ORDER.index,
                   default="PASS")


@dataclass
class Ctx:
    http: Http
    report: Report
    args: argparse.Namespace
    cookie: str | None = None
    auth_enabled: bool | None = None
    routes: list[tuple[str, frozenset[str]]] = field(default_factory=list)
    agent_names: list[str] = field(default_factory=list)
    # (name, password) of the user --throwaway-user created; only that user
    # is subjected to the checks that change a password.
    throwaway: tuple[str, str] | None = None


def section(title: str) -> None:
    print(f"\n{BOLD}{title}{RESET}")


def fill_path(path: str) -> str:
    return (path.replace("{name}", "sectest-nope").replace("{pid}", "1")
            .replace("{path:path}", "x"))


def is_public(path: str) -> bool:
    return (path in EXPECTED_PUBLIC_PATHS or path in EXPECTED_AGENT_PATHS
            or path.startswith(EXPECTED_PUBLIC_PREFIXES))


def walk_keys(value: Any, prefix: str = "") -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    if isinstance(value, dict):
        for k, v in value.items():
            out.append((f"{prefix}{k}", v))
            out.extend(walk_keys(v, f"{prefix}{k}."))
    elif isinstance(value, list):
        for i, v in enumerate(value[:50]):
            out.extend(walk_keys(v, f"{prefix}[{i}]."))
    return out


def safe_req(ctx: Ctx, method: str, target: str, **kw: Any) -> Resp | None:
    """A request whose transport failure is itself an acceptable answer
    (uvicorn refuses some malformed targets outright)."""
    try:
        return ctx.http.req(method, target, **kw)
    except (OSError, http.client.HTTPException, ValueError):
        return None


# -------------------------------------------------------------------- checks
def load_routes(ctx: Ctx) -> None:
    """Import the app (lifespan never runs) and list every route with its
    methods, plus the static mount, so coverage follows the code."""
    try:
        from culprit import auth as auth_module
        from culprit.main import app
    except Exception as exc:  # noqa: BLE001
        ctx.report.add("HIGH", "routes",
                       f"cannot import culprit.main to enumerate routes: {exc}")
        return
    drift = (set(auth_module.PUBLIC_PATHS) ^ EXPECTED_PUBLIC_PATHS) | \
            (set(auth_module.AGENT_PATHS) ^ EXPECTED_AGENT_PATHS) | \
            (set(auth_module.PUBLIC_PREFIXES) ^ set(EXPECTED_PUBLIC_PREFIXES))
    if drift:
        ctx.report.add("HIGH", "public-allowlist",
                       f"auth.py's open paths differ from this tool's expectation: "
                       f"{sorted(drift)} -- confirm each is meant to be reachable "
                       "without a session, then update EXPECTED_* here")
    else:
        ctx.report.ok("public-allowlist",
                      f"{len(EXPECTED_PUBLIC_PATHS)} public paths, "
                      f"{len(EXPECTED_AGENT_PATHS)} agent path, "
                      f"{len(EXPECTED_PUBLIC_PREFIXES)} public prefix -- as expected")
    for route in app.routes:
        path = getattr(route, "path", None)
        if not path:
            continue
        methods = getattr(route, "methods", None)
        if methods is None:  # Mount
            ctx.routes.append((path.rstrip("/") + "/", frozenset({"GET"})))
        else:
            ctx.routes.append((path, frozenset(m for m in methods
                                               if m != "HEAD")))
    ctx.report.ok("routes", f"{len(ctx.routes)} routes enumerated from the app")


def check_transport(ctx: Ctx) -> None:
    h = ctx.http
    loopback = h.host in ("127.0.0.1", "::1", "localhost")
    if h.scheme != "https" and not loopback:
        ctx.report.add("WARN", "transport",
                       f"plain http to {h.host}: passwords, session cookies and "
                       "agent tokens cross the network readable. Use "
                       "--ssl-certfile/--ssl-keyfile or a TLS proxy")
    else:
        ctx.report.ok("transport", "https" if h.scheme == "https"
                      else "http on loopback only")


def check_auth_state(ctx: Ctx) -> None:
    r = ctx.http.req("GET", "/api/auth")
    data = r.json()
    if r.status != 200 or not isinstance(data, dict):
        ctx.report.add("HIGH", "auth-state",
                       f"/api/auth answered {r.status}: {r.text[:120]!r}")
        return
    ctx.auth_enabled = bool(data.get("enabled"))
    extra = set(data) - {"enabled", "username"}
    if extra:
        ctx.report.add("WARN", "auth-state",
                       f"/api/auth (public) exposes extra keys: {sorted(extra)}")
    if data.get("username"):
        ctx.report.add("HIGH", "auth-state",
                       "/api/auth reports a username with no cookie sent")
    if not ctx.auth_enabled:
        loopback = ctx.http.host in ("127.0.0.1", "::1", "localhost")
        ctx.report.add("WARN" if loopback else "CRIT", "auth-state",
                       "authentication is OFF: every endpoint, including "
                       "process termination on agents, is open to whoever can "
                       "reach this port")
    else:
        ctx.report.ok("auth-state", "authentication is on")
    h = ctx.http.req("GET", "/api/healthz").json()
    if isinstance(h, dict) and set(h) - {"ok", "warm", "stage"}:
        ctx.report.add("WARN", "healthz",
                       f"/api/healthz (public) exposes extra keys: "
                       f"{sorted(set(h) - {'ok', 'warm', 'stage'})}")
    else:
        ctx.report.ok("healthz", "public health probe carries no data")


def expect_gated(ctx: Ctx, method: str, target: str, check: str,
                 note: str = "") -> bool:
    """One unauthenticated request that must bounce. Returns True if gated."""
    r = safe_req(ctx, method, target, timeout=4.0, max_read=65536)
    if r is None:
        return True
    label = f"{method} {target}{(' ' + note) if note else ''}"
    if 200 <= r.status < 300:
        ctx.report.add("CRIT", check,
                       f"{label} -> {r.status} WITHOUT a session "
                       f"({len(r.body)} bytes: {r.text[:80]!r})")
        return False
    # A redirect to the login page is gated, whatever the spelling: the
    # middleware picks 401 vs 303 by whether the path *starts* with /api/, so
    # `//api/x` gets the page treatment. Both leak nothing.
    if r.status == 303 and (r.header("location") or "").startswith("/login"):
        return True
    if "/api/" in target:
        if r.status == 401 and r.json() == UNAUTH_API_BODY:
            return True
        if r.status in (400, 401, 404, 405, 422):
            # 404/405 are fine: the point is no data left the server.
            return True
        ctx.report.add("WARN", check, f"{label} -> {r.status} (expected 401)")
        return True
    if r.status in (400, 401, 404, 405):
        return True
    ctx.report.add("WARN", check,
                   f"{label} -> {r.status} (expected 303 to /login)")
    return True


def check_route_gate(ctx: Ctx) -> None:
    """Every non-public route, every method: no session -> no data."""
    if not ctx.auth_enabled:
        ctx.report.add("INFO", "route-gate", "skipped: auth is off")
        return
    extra_methods = {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
    probed = 0
    failed = 0
    for path, methods in ctx.routes:
        if is_public(path):
            continue
        target = fill_path(path)
        for method in sorted(methods | extra_methods):
            probed += 1
            if not expect_gated(ctx, method, target, "route-gate",
                                "" if method in methods else "(undeclared method)"):
                failed += 1
    if not failed:
        ctx.report.ok("route-gate",
                      f"{probed} method/route combinations bounced without a session")


def check_public_routes(ctx: Ctx) -> None:
    """Public paths must be exactly as narrow as advertised."""
    for path in sorted(EXPECTED_PUBLIC_PATHS):
        if path == "/api/login":
            r = ctx.http.req("GET", path)
            if r.status == 200:
                ctx.report.add("HIGH", "public-routes", "GET /api/login returns 200")
            continue
        r = ctx.http.req("GET", path)
        if r.status != 200:
            ctx.report.add("WARN", "public-routes", f"GET {path} -> {r.status} "
                           "(expected 200; the login page would break)")
    # The docs and schema are gated (they list every route and parameter).
    for path in ("/api/docs", "/api/openapi.json", "/api/redoc", "/docs",
                 "/openapi.json", "/redoc"):
        expect_gated(ctx, "GET", path, "api-docs")
    ctx.report.ok("public-routes", "login page, health, favicon reachable; "
                  "API docs and schema gated")


def check_path_bypass(ctx: Ctx) -> None:
    """Path spellings that a naive `path in PUBLIC_PATHS` check might let
    through, all aimed at a route that serves the whole machine state."""
    if not ctx.auth_enabled:
        return
    victims = ["/api/snapshot", "/api/settings", "/api/nodes"]
    spellings = [
        "{p}/", "/{p}", "{p}//", "{p}?", "{p}#x", "{p}%20", "{p}%00",
        "/API/{s}", "/Api/{s}", "{p};x", "{p}.json", "{p}/..",
        "/api/./{s}", "/api//{s}", "/api/auth/../{s}", "/api/login/../{s}",
        "/api/healthz/../{s}", "/api/agents/report/../{s}",
        "/api/agents/report/../../{s}", "/login/../{s}", "/assets/../{s}",
        "/assets/..%2f{s}", "/assets/%2e%2e/{s}", "/favicon.svg/../{s}",
        "/api/auth%2f..%2f{s}", "/api/%2e%2e/{s}", "{p}%2f", "{p}%3f",
        "/\\api/{s}", "/api\\{s}",
    ]
    tried = 0
    bad = 0
    for victim in victims:
        short = victim[len("/api/"):]
        for pattern in spellings:
            target = pattern.format(p=victim, s=short)
            tried += 1
            if not expect_gated(ctx, "GET", target, "path-bypass"):
                bad += 1
    # Header tricks: proxies sometimes honour these; the app must not.
    for headers in ({"X-Original-URL": "/api/auth"},
                    {"X-Rewrite-URL": "/api/auth"},
                    {"X-Forwarded-Prefix": "/assets"},
                    {"X-HTTP-Method-Override": "GET"},
                    {"Host": "localhost"}, {"Host": "evil.example"},
                    {"X-Forwarded-For": "127.0.0.1"},
                    {"Referer": ctx.http.host + "/login"}):
        tried += 1
        r = safe_req(ctx, "GET", "/api/snapshot", headers=headers, max_read=65536)
        if r is not None and 200 <= r.status < 300:
            bad += 1
            ctx.report.add("CRIT", "path-bypass",
                           f"GET /api/snapshot with {headers} -> {r.status}")
    if not bad:
        ctx.report.ok("path-bypass",
                      f"{tried} alternative spellings/headers all bounced")


# What a reverse proxy sets and a client can forge. Mirrors culprit.trust.
FORWARDING_PROBES = (
    ("X-Forwarded-For", "10.9.9.9"), ("Forwarded", "for=10.9.9.9;proto=https"),
    ("X-Real-IP", "10.9.9.9"), ("X-Forwarded-Host", "evil.example"),
    ("X-Forwarded-Proto", "https"), ("X-Forwarded-Port", "443"),
    ("X-Forwarded-Prefix", "/x"), ("X-Forwarded-Server", "evil.example"),
    ("X-Client-IP", "10.9.9.9"), ("True-Client-IP", "10.9.9.9"),
    ("CF-Connecting-IP", "10.9.9.9"),
)


def scan_access(ctx: Ctx) -> dict[str, Any] | None:
    """How the host sees this scanner (peer, via_proxy, Host) -- needs a
    session; None without one."""
    if not ctx.cookie:
        return None
    r = safe_req(ctx, "GET", "/api/settings", cookie=ctx.cookie)
    if r is None or r.status != 200:
        return None
    return (r.json() or {}).get("access") or None


def check_proxy_trust(ctx: Ctx) -> None:
    """A forwarding header from an undeclared peer must be refused outright
    (400, reason `untrusted_proxy`) -- never honoured (the client would pick
    the address the login limiter keys on) and never quietly ignored (that
    hides an undeclared proxy, behind which every visitor shares one limiter
    bucket). Against the open health route, so no session is needed."""
    access = scan_access(ctx)
    if access and access.get("via_proxy"):
        ctx.report.add("INFO", "proxy-trust",
                       f"this scan reaches the host through declared proxy "
                       f"{access.get('peer')}; a forged header from here is "
                       "rewritten by the proxy, so refusal is not provable from "
                       "this side -- scan the host directly to prove it")
        return
    tried = bad = 0
    for name, value in FORWARDING_PROBES:
        r = safe_req(ctx, "GET", "/api/healthz", headers={name: value})
        if r is None:
            continue
        tried += 1
        if r.status == 400 and (r.json() or {}).get("reason") == "untrusted_proxy":
            continue
        bad += 1
        if 200 <= r.status < 300:
            ctx.report.add("HIGH", "proxy-trust",
                           f"GET /api/healthz with {name}: {value} -> {r.status}: a "
                           "forwarding header from an undeclared peer was accepted "
                           "(reverse proxies must be refused until declared in "
                           "Settings > Network trust)")
        else:
            ctx.report.add("WARN", "proxy-trust",
                           f"{name} -> {r.status} (expected 400 untrusted_proxy)")
    if tried and not bad:
        ctx.report.ok("proxy-trust",
                      f"{tried} forwarding headers refused with 400 from this "
                      "undeclared address")


def check_host_trust(ctx: Ctx) -> None:
    """The Host allow-list. When set, a foreign Host is refused (400
    `untrusted_host`) and a loopback name still passes; when empty the host
    accepts any Host, which is the default -- INFO on loopback, WARN on a
    network address, where DNS rebinding is the thing it would stop."""
    r = safe_req(ctx, "GET", "/api/healthz", headers={"Host": "rebind.evil.example"})
    if r is None:
        return
    reason = (r.json() or {}).get("reason") if r.status == 400 else None
    if reason == "untrusted_host":
        back = safe_req(ctx, "GET", "/api/healthz", headers={"Host": "localhost"})
        if back is not None and back.status != 200:
            ctx.report.add("HIGH", "host-trust",
                           f"Host: localhost -> {back.status}: loopback names must "
                           "always pass or the list cannot be corrected from the host")
        else:
            ctx.report.ok("host-trust", "foreign Host refused; loopback Host still accepted")
        return
    if 200 <= r.status < 300:
        loopback = ctx.http.host in ("127.0.0.1", "localhost", "::1")
        ctx.report.add("INFO" if loopback else "WARN", "host-trust",
                       "any Host header is accepted (Settings > Network trust > "
                       "Trusted hosts is empty)"
                       + ("" if loopback else "; on a network-reachable host list the "
                          "names it is reached at to shut DNS rebinding"))
        return
    ctx.report.add("WARN", "host-trust", f"Host: rebind.evil.example -> {r.status} "
                   f"{r.text[:80]!r} (expected 200 or 400 untrusted_host)")


def check_static(ctx: Ctx) -> None:
    """The static mount is public; it must serve web/ and nothing above it."""
    probes = [
        "/assets/../config.json", "/assets/../data/culprit.db",
        "/assets/../culprit/db.py", "/assets/../.git/HEAD",
        "/assets/../agent.json", "/assets/../../etc/passwd",
        "/assets/..%2fconfig.json", "/assets/%2e%2e/config.json",
        "/assets/%2e%2e%2fconfig.json", "/assets/..%5cconfig.json",
        "/assets/js/../../config.json", "/assets/./../config.json",
        "/assets/%00/../config.json", "/assets/config.json",
        "/assets/../culprit/../config.json",
    ]
    leaks = 0
    for target in probes:
        r = safe_req(ctx, "GET", target, max_read=65536)
        if r is None:
            continue
        body = r.text
        looks_like_secret = ('"host"' in body and '"port"' in body) or \
            "SQLite format" in body or "scrypt" in body or "ref: refs/" in body \
            or "root:x:" in body or "import sqlite3" in body
        if r.status == 200 or looks_like_secret:
            leaks += 1
            ctx.report.add("CRIT", "static-traversal",
                           f"GET {target} -> {r.status} ({len(r.body)} bytes)")
    for target in ("/assets/", "/assets", "/assets/js/", "/assets/css/"):
        r = ctx.http.req("GET", target, max_read=65536)
        if r.status == 200 and ("<a href" in r.text or "Index of" in r.text):
            leaks += 1
            ctx.report.add("HIGH", "static-listing", f"GET {target} lists the directory")
    web = ROOT / "web"
    allowed = {".html", ".js", ".css", ".svg", ".png", ".ico", ".woff2",
               ".woff", ".webmanifest", ".map", ".txt", ".md"}
    odd = sorted(str(p.relative_to(web)) for p in web.rglob("*")
                 if p.is_file() and p.suffix.lower() not in allowed)
    if odd:
        ctx.report.add("HIGH", "static-inventory",
                       f"files under web/ (served publicly at /assets/) with "
                       f"unexpected types: {odd[:8]}")
    for name in ("config.json", "agent.json", "culprit.db", ".env"):
        if (web / name).exists():
            leaks += 1
            ctx.report.add("CRIT", "static-inventory",
                           f"web/{name} exists and is served publicly")
    if not leaks:
        ctx.report.ok("static", f"{len(probes)} traversal probes bounced; "
                      "no listing; web/ holds only page assets")


def check_headers(ctx: Ctx) -> None:
    """Defensive headers on the pages and the API. A missing one is a WARN
    rather than a failure because a TLS proxy often adds them -- but then this
    should be run through that proxy to prove it."""
    page = ctx.http.req("GET", "/login")
    api = ctx.http.req("GET", "/api/auth")
    missing = []
    for name, want in (("x-content-type-options", "nosniff"),
                       ("referrer-policy", None)):
        value = (page.header(name) or "").lower()
        if not value or (want and want not in value):
            missing.append(name)
    frame = (page.header("x-frame-options") or "").upper()
    csp = page.header("content-security-policy") or ""
    if frame not in ("DENY", "SAMEORIGIN") and "frame-ancestors" not in csp:
        missing.append("x-frame-options / CSP frame-ancestors (clickjacking "
                       "of the End-task button)")
    if missing:
        ctx.report.add("WARN", "headers", f"missing on /login: {missing}")
    else:
        ctx.report.ok("headers", "nosniff, frame-ancestors and referrer policy set")
    cache = (api.header("cache-control") or "").lower()
    if "no-store" not in cache:
        ctx.report.add("WARN", "headers",
                       f"/api/* responses lack Cache-Control: no-store "
                       f"(got {cache or 'nothing'!r}) -- a shared browser can "
                       "replay the process table from cache")
    else:
        ctx.report.ok("headers", "API responses are no-store")
    server = api.header("server") or ""
    if server:
        ctx.report.add("INFO", "headers",
                       f"Server header discloses {server!r}; harmless, "
                       "removable with uvicorn --no-server-header")
    if ctx.http.scheme == "https" and not page.header("strict-transport-security"):
        ctx.report.add("WARN", "headers", "https without Strict-Transport-Security")


def check_cors(ctx: Ctx) -> None:
    evil = "https://evil.example"
    r = ctx.http.req("GET", "/api/auth", headers={"Origin": evil})
    acao = r.header("access-control-allow-origin")
    pre = ctx.http.req("OPTIONS", "/api/settings", headers={
        "Origin": evil, "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type"})
    pre_acao = pre.header("access-control-allow-origin")
    if acao in ("*", evil) or pre_acao in ("*", evil):
        ctx.report.add("CRIT", "cors",
                       f"cross-origin reads allowed: ACAO={acao!r} "
                       f"preflight={pre_acao!r}")
    else:
        ctx.report.ok("cors", "no Access-Control-Allow-Origin for a foreign origin")


def login(ctx: Ctx, username: str, password: str, count: bool = True) -> Resp:
    r = ctx.http.req("POST", "/api/login",
                     json_body={"username": username, "password": password})
    if count and r.status == 401:
        ctx.report.login_failures += 1
    elif r.status == 200:
        # Mirror the server: a successful login clears the address's count.
        ctx.report.login_failures = 0
    return r


def check_login(ctx: Ctx) -> None:
    """Enumeration, default credentials, malformed bodies. Spends at most
    five login failures so the scan cannot lock out a real user on the same
    address."""
    if not ctx.auth_enabled:
        return
    rep = ctx.report
    # Malformed bodies never reach the password check (FastAPI validation)
    # so they do not count as attempts -- but they must not 500 either.
    json_ct = {"Content-Type": "application/json"}
    for label, body, headers in (
        ("empty", b"", json_ct),
        ("not json", b"username=admin&password=admin", json_ct),
        ("array", b"[]", json_ct),
        ("wrong types", b'{"username": 1, "password": null}', json_ct),
        ("200KB junk", b"{" + b"x" * 200_000, json_ct),
        ("form encoded", b"username=admin&password=admin",
         {"Content-Type": "application/x-www-form-urlencoded"}),
    ):
        r = ctx.http.req("POST", "/api/login", body=body, headers=headers)
        if r.status >= 500:
            rep.add("HIGH", "login-input", f"{label} body -> {r.status}")
        elif r.status == 200:
            rep.add("CRIT", "login-input", f"{label} body -> 200: {r.text[:100]!r}")
    rep.ok("login-input", "malformed bodies rejected with 4xx")

    # Default credentials: the one finding that is a real breach on a
    # reachable host. Counts as one failure when it fails, as it should.
    r = login(ctx, "admin", "admin")
    if r.status == 200 and (r.json() or {}).get("ok"):
        rep.add("CRIT", "default-credentials",
                "admin/admin signs in. Change it now: Settings > Account, or "
                "`python -m culprit users add admin`")
    else:
        rep.ok("default-credentials", "admin/admin rejected")

    # Enumeration: unknown user and wrong password must be indistinguishable
    # in status, body and (roughly) latency. Two samples each = 4 failures.
    known = ctx.args.user or "admin"
    unknown = f"nobody-{secrets.token_hex(4)}"
    pw = "definitely-not-the-password-" + secrets.token_hex(4)
    samples: dict[str, list[float]] = {"unknown": [], "known": []}
    bodies: dict[str, tuple[int, str]] = {}
    for _ in range(2):
        for label, user in (("unknown", unknown), ("known", known)):
            t0 = time.perf_counter()
            r = login(ctx, user, pw)
            samples[label].append(time.perf_counter() - t0)
            bodies[label] = (r.status, r.text)
    if bodies["unknown"] != bodies["known"]:
        rep.add("HIGH", "user-enumeration",
                f"responses differ: unknown={bodies['unknown']} "
                f"known={bodies['known']}")
    else:
        rep.ok("user-enumeration", "unknown user and wrong password answer identically")
    # Minimum, not median: the floor is the server's real cost, the rest is
    # noise. One scrypt is ~45ms here, so a 2x gap is a second scrypt.
    mu, mk = (min(samples["unknown"]), min(samples["known"]))
    ratio = max(mu, mk) / max(min(mu, mk), 1e-6)
    if ratio > 1.5 and abs(mu - mk) > 0.015:
        rep.add("WARN", "user-enumeration",
                f"timing differs: unknown {mu*1000:.0f}ms vs known {mk*1000:.0f}ms "
                "(username existence may be inferable)")
    else:
        rep.ok("timing", f"login latency unknown {mu*1000:.0f}ms / known "
               f"{mk*1000:.0f}ms -- no usable oracle")
    rep.add("INFO", "rate-limit",
            f"spent {rep.login_failures} of {LOGIN_FAILURE_BUDGET} login "
            "failures allowed for this address per 5 minutes")


def check_session_forgery(ctx: Ctx) -> None:
    if not ctx.auth_enabled:
        return
    far = int(time.time()) + 10 ** 6
    zeros = "0" * 64
    cookies = [
        f"admin:{far}:{zeros}", f"admin:{far}:", f"admin:{far}", "admin",
        f"admin:{far}:{zeros}:{zeros}", f":{far}:{zeros}", "::", "",
        f"admin:{far}:{'f' * 64}", f"admin:{10 ** 30}:{zeros}",
        f"admin:-1:{zeros}", f"admin:{far}:{zeros.upper()}",
        f"admin:{far}:{zeros}{NUL}", f"admin :{far}:{zeros}",
        "eyJhbGciOiJub25lIn0.eyJ1c2VyIjoiYWRtaW4ifQ.",  # JWT alg=none shape
        "a" * 4096,
    ]
    bad = 0
    for cookie in cookies:
        r = safe_req(ctx, "GET", "/api/auth", cookie=cookie)
        if r is None:
            continue
        data = r.json() if r.status == 200 else None
        if isinstance(data, dict) and data.get("username"):
            bad += 1
            ctx.report.add("CRIT", "session-forgery",
                           f"cookie {cookie[:40]!r} accepted as {data['username']!r}")
        elif r.status >= 500:
            ctx.report.add("HIGH", "session-forgery",
                           f"cookie {cookie[:40]!r} -> {r.status}")
    if ctx.cookie:
        # A real cookie with one signature character flipped, its expiry
        # rewritten, or its username swapped -- the signature must cover all.
        head, sig = ctx.cookie.rsplit(":", 1)
        flipped = head + ":" + ("0" if sig[0] != "0" else "1") + sig[1:]
        user_part, _, _ = head.rpartition(":")
        stale = f"{user_part}:{int(time.time()) - 10}:{sig}"
        swapped = "root:" + ctx.cookie.split(":", 1)[1]
        for name, cookie in (("flipped signature", flipped),
                             ("expiry rewritten", stale),
                             ("username rewritten", swapped)):
            r = ctx.http.req("GET", "/api/auth", cookie=cookie)
            data = r.json() or {}
            if data.get("username"):
                bad += 1
                ctx.report.add("CRIT", "session-forgery", f"{name} accepted")
    if not bad:
        ctx.report.ok("session-forgery", f"{len(cookies)} forged cookies rejected")


def do_login(ctx: Ctx) -> None:
    """Sign in for the authenticated block, and audit the cookie itself."""
    if not (ctx.args.user and ctx.args.password) or not ctx.auth_enabled:
        return
    r = login(ctx, ctx.args.user, ctx.args.password, count=False)
    if r.status != 200:
        ctx.report.add("WARN", "login",
                       f"could not sign in as {ctx.args.user!r} ({r.status}): "
                       "authenticated checks skipped")
        return
    if ctx.args.password in r.text:
        ctx.report.add("HIGH", "login", "the login response echoes the password")
    raw = r.header("set-cookie") or ""
    m = re.search(r"culprit_session=([^;]+)", raw)
    if not m:
        ctx.report.add("HIGH", "login", f"no session cookie set: {raw!r}")
        return
    ctx.cookie = m.group(1)
    flags = raw.lower()
    problems = []
    if "httponly" not in flags:
        problems.append("HttpOnly missing (script-readable)")
    if "samesite=lax" not in flags and "samesite=strict" not in flags:
        problems.append("SameSite missing (CSRF against End task)")
    if "path=/" not in flags:
        problems.append("Path missing")
    if ctx.http.scheme == "https" and "secure" not in flags:
        problems.append("Secure missing on https")
    if "max-age=" not in flags and "expires=" not in flags:
        problems.append("no Max-Age (a session cookie that never expires "
                        "client-side)")
    if problems:
        ctx.report.add("HIGH", "cookie", "; ".join(problems))
    else:
        ctx.report.ok("cookie", "HttpOnly, SameSite, Path set"
                      + ("; Secure" if "secure" in flags else
                         "; Secure not set (plain http)"))
    nodes = ctx.http.req("GET", "/api/nodes", cookie=ctx.cookie).json() or {}
    ctx.agent_names = [n["name"] for n in nodes.get("nodes", [])
                       if isinstance(n, dict) and n.get("name")]


def check_authenticated_reads(ctx: Ctx) -> None:
    """With a session, every GET must answer without a 5xx and without a
    credential or a filesystem path in the body."""
    if not ctx.cookie:
        return
    errors = 0
    leaks = 0
    probed = 0
    for path, methods in ctx.routes:
        if "GET" not in methods or is_public(path) or path.endswith("/"):
            continue
        target = fill_path(path)
        if ctx.agent_names:
            target = path.replace("{name}", ctx.agent_names[0]).replace("{pid}", "1")
        probed += 1
        if path == "/api/stream":
            r = ctx.http.req("GET", target, cookie=ctx.cookie, max_read=2048,
                             timeout=5.0)
            if r.status != 200 or "event-stream" not in (r.header("content-type") or ""):
                ctx.report.add("WARN", "auth-reads", f"/api/stream -> {r.status}")
            continue
        r = safe_req(ctx, "GET", target, cookie=ctx.cookie, timeout=20.0)
        if r is None:
            ctx.report.add("WARN", "auth-reads", f"GET {target}: no answer")
            continue
        if r.status == 500:
            errors += 1
            ctx.report.add("HIGH", "auth-reads", f"GET {target} -> 500 "
                           f"(unhandled exception): {r.text[:100]!r}")
            continue
        if r.status >= 500:
            ctx.report.add("INFO", "auth-reads",
                           f"GET {target} -> {r.status}: {r.text[:80]!r}")
            continue
        data = r.json()
        for key, value in walk_keys(data):
            leaf = key.rsplit(".", 1)[-1]
            if leaf in SECRET_KEY_ALLOW:
                continue
            if SECRET_KEY_RE.search(leaf) and isinstance(value, str) and value:
                leaks += 1
                ctx.report.add("HIGH", "secret-in-body",
                               f"GET {target}: key {key!r} carries a value")
            if leaf == "db_path":
                leaks += 1
                ctx.report.add("WARN", "path-in-body",
                               f"GET {target}: {key!r} exposes the database path")
    if not errors and not leaks:
        ctx.report.ok("auth-reads", f"{probed} GET routes answered without 5xx, "
                      "credentials or filesystem paths")
    r = ctx.http.req("GET", "/api/openapi.json", cookie=ctx.cookie)
    if r.status == 200:
        ctx.report.add("INFO", "api-docs", "schema readable with a session (by design)")


def check_injection(ctx: Ctx) -> None:
    """Query and path parameters that reach SQLite or the filesystem."""
    if not ctx.cookie:
        return
    rep = ctx.report
    payloads = [
        "local' OR '1'='1", "local\" OR \"1\"=\"1", "local' OR 1=1--",
        "local' UNION SELECT username, password_hash FROM users--",
        "' OR node LIKE '%", "%", "*", "local;--", "local" + NUL,
        "../../etc/passwd", "'; DROP TABLE users; --",
    ]
    routes = [
        "/api/history/series?node={q}", "/api/history/top?node={q}",
        "/api/history/findings?node={q}",
        "/api/history/events?node={q}&kinds={q}",
        "/api/history/processes?ts=0&node={q}",
        "/api/history/series?columns={q}", "/api/nodes/{q}/snapshot",
        "/api/live?keys={q}",
    ]
    bad = 0
    for payload in payloads:
        q = quote(payload, safe="")
        for pattern in routes:
            target = pattern.format(q=q)
            r = safe_req(ctx, "GET", target, cookie=ctx.cookie)
            if r is None:
                continue
            if r.status >= 500:
                bad += 1
                rep.add("HIGH", "injection", f"GET {target} -> {r.status}")
                continue
            data = r.json()
            if isinstance(data, dict) and "series" in data and "node=" in target:
                if int(data.get("count") or 0) > 0:
                    bad += 1
                    rep.add("CRIT", "injection",
                            f"GET {target} returned {data.get('count')} rows for "
                            "a node that does not exist")
            if HASH_VALUE_RE.search(r.text):
                bad += 1
                rep.add("CRIT", "injection", f"GET {target} leaked password hashes")
    if not bad:
        rep.ok("injection", f"{len(payloads)} payloads across {len(routes)} "
               "parameterised routes: no 5xx, no foreign rows")


def check_authenticated_writes(ctx: Ctx) -> None:
    """Writes with a session -- only ones the server must reject, so a passing
    run leaves no trace. A 2xx here is a validation hole."""
    if not ctx.cookie:
        return
    rep = ctx.report
    c = ctx.cookie
    bad = 0

    def expect(method: str, target: str, body: Any, want: tuple[int, ...],
               label: str) -> None:
        nonlocal bad
        r = ctx.http.req(method, target, json_body=body, cookie=c)
        if r.status not in want:
            bad += 1
            level = "HIGH" if 200 <= r.status < 300 or r.status >= 500 else "WARN"
            rep.add(level, "write-validation",
                    f"{label}: {method} {target} -> {r.status} (expected {want})")

    # Settings: locked fields and out-of-range values.
    expect("PUT", "/api/settings", {"db_path": "/tmp/pwned.db"}, (422,), "db_path via web")
    expect("PUT", "/api/settings", {"host": "0.0.0.0"}, (422,), "bind host via web")
    expect("PUT", "/api/settings", {"port": 1}, (422,), "port via web")
    expect("PUT", "/api/settings", {"interval_fast": -1}, (422,), "negative interval")
    expect("PUT", "/api/settings", {"interval_fast": "1; rm -rf /"}, (422,), "string interval")
    expect("PUT", "/api/settings", {}, (400,), "empty patch")
    expect("PUT", "/api/settings", [], (400, 422), "array patch")
    expect("PUT", "/api/settings", {"retention_days": 10 ** 9}, (422,), "absurd retention")
    # Node settings: unknown node, non-settable key.
    expect("PUT", "/api/nodes/sectest-nope/settings", {"interval_fast": 1},
           (404,), "settings for unknown node")
    if ctx.agent_names:
        expect("PUT", f"/api/nodes/{ctx.agent_names[0]}/settings",
               {"allow_process_actions": False}, (422,), "non-settable node key")
        expect("PUT", f"/api/nodes/{ctx.agent_names[0]}/settings",
               {"interval_fast": 0.0001}, (422,), "node interval below floor")
    # Agent enrolment: names that would break the token format or paths.
    for name in ("../evil", "a.b", "local", "x" * 49, " ", "", "<script>",
                 "a/b", "a" + NUL + "b", "sectest ok"):
        expect("POST", "/api/agents", {"name": name}, (422,),
               f"enrol agent named {name!r}")
    after = ctx.http.req("GET", "/api/nodes", cookie=c).json() or {}
    created = [n.get("name") for n in after.get("nodes", [])
               if isinstance(n, dict) and n.get("name") not in ctx.agent_names]
    if created:
        bad += 1
        rep.add("HIGH", "write-validation",
                f"agents were created from invalid names: {created} -- delete them")
    # Process actions on the host itself are gone, and unknown agents 404.
    expect("POST", "/api/processes/1/terminate", {"confirm": True}, (410,),
           "terminate on host")
    expect("POST", "/api/processes/1/priority", {"level": "low"}, (410,),
           "renice on host")
    expect("POST", "/api/nodes/sectest-nope/processes/1/terminate", {},
           (400,), "terminate without confirm")
    expect("POST", "/api/nodes/sectest-nope/processes/1/terminate",
           {"confirm": True}, (404,), "terminate on unknown agent")
    expect("POST", "/api/nodes/sectest-nope/processes/1/priority",
           {"level": "low"}, (404,), "renice on unknown agent")
    expect("GET", "/api/nodes/sectest-nope/processes/1", None, (404,),
           "detail on unknown agent")
    expect("POST", "/api/agents/sectest-nope/revoke", None, (404,), "revoke unknown")
    expect("POST", "/api/agents/sectest-nope/token", None, (404,), "rotate unknown")
    expect("DELETE", "/api/agents/sectest-nope", None, (404,), "delete unknown")
    # Account: a stolen session must re-prove the password to change it.
    expect("POST", "/api/account/password",
           {"current_password": "wrong-" + secrets.token_hex(4),
            "new_password": "longenough123"}, (403,), "password change, wrong current")
    expect("POST", "/api/account/username",
           {"current_password": "wrong", "new_username": "../x"}, (422,),
           "rename to invalid name")
    expect("POST", "/api/account/username",
           {"current_password": "wrong-" + secrets.token_hex(4),
            "new_username": "sectest"}, (403,), "rename, wrong current password")
    if not bad:
        rep.ok("write-validation", "every invalid write rejected; nothing changed")


def check_logout(ctx: Ctx) -> None:
    if not ctx.cookie:
        return
    r = ctx.http.req("POST", "/api/logout", cookie=ctx.cookie)
    set_cookie = (r.header("set-cookie") or "").lower()
    cleared = "max-age=0" in set_cookie or "expires=" in set_cookie
    again = ctx.http.req("GET", "/api/auth", cookie=ctx.cookie).json() or {}
    if again.get("username"):
        ctx.report.add("INFO", "logout",
                       "sessions are stateless: logout clears the browser cookie "
                       "but a copied cookie stays valid until it expires. "
                       "Changing the password is the way to revoke sessions")
    else:
        ctx.report.ok("logout", "session invalid after logout")
    if not cleared:
        ctx.report.add("WARN", "logout", "logout response does not clear the cookie")


def check_agent_ingest_unauth(ctx: Ctx) -> None:
    """The one path open to the network without a session."""
    rep = ctx.report
    snapshot = json.dumps({"agent": {"report_interval": 1}, "snapshot": {}}).encode()
    cases = [
        ("no token", {}),
        ("empty bearer", {"Authorization": "Bearer "}),
        ("basic auth", {"Authorization": "Basic YWRtaW46YWRtaW4="}),
        ("garbage", {"Authorization": "Bearer " + secrets.token_urlsafe(40)}),
        ("no dot", {"Authorization": "Bearer nodot"}),
        ("empty secret", {"Authorization": "Bearer sectest-nope."}),
        ("empty name", {"Authorization": "Bearer .secret"}),
        ("unknown agent", {"Authorization": "Bearer sectest-nope." + secrets.token_urlsafe(32)}),
        ("sql in name", {"Authorization": "Bearer x' OR '1'='1." + secrets.token_urlsafe(32)}),
        ("token as query", {}),
    ]
    for name in ctx.agent_names[:3]:
        cases.append((f"real name {name!r}, wrong secret",
                      {"Authorization": f"Bearer {name}." + secrets.token_urlsafe(32)}))
    bad = 0
    for label, headers in cases:
        target = "/api/agents/report"
        if label == "token as query":
            target += "?token=sectest-nope." + secrets.token_urlsafe(32)
        r = ctx.http.req("POST", target, body=snapshot,
                         headers={"Content-Type": "application/json", **headers})
        if r.status != 401:
            bad += 1
            rep.add("CRIT" if r.status < 300 else "HIGH", "agent-ingest",
                    f"{label} -> {r.status}: {r.text[:100]!r}")
    # A session cookie must NOT stand in for an agent token.
    if ctx.cookie:
        r = ctx.http.req("POST", "/api/agents/report", body=snapshot,
                         headers={"Content-Type": "application/json"},
                         cookie=ctx.cookie)
        if r.status != 401:
            bad += 1
            rep.add("HIGH", "agent-ingest", f"session cookie accepted as agent -> {r.status}")
    # Oversize with no token must not be buffered into a 413 -- 401 first.
    r = ctx.http.req("POST", "/api/agents/report", body=b" " * (9 * 1024 * 1024),
                     headers={"Content-Type": "application/json"}, timeout=20.0)
    if r.status != 401:
        rep.add("WARN", "agent-ingest", f"9MB body without a token -> {r.status} "
                "(expected 401 before the body is read)")
    if not bad:
        rep.ok("agent-ingest", f"{len(cases) + 1} bad-credential reports rejected with 401")


def check_agent_lifecycle(ctx: Ctx) -> None:
    """--active: enrol a throwaway agent and prove the token really is the
    only key: works once, dies on revoke, dies on rotate, dies on delete.
    Cleans up after itself."""
    if not (ctx.args.active and ctx.cookie):
        return
    rep = ctx.report
    c = ctx.cookie
    name = f"sectest-{secrets.token_hex(3)}"
    r = ctx.http.req("POST", "/api/agents", json_body={"name": name}, cookie=c)
    data = r.json() or {}
    token = data.get("token")
    if r.status != 200 or not token:
        rep.add("HIGH", "agent-lifecycle", f"enrol -> {r.status}: {r.text[:120]!r}")
        return
    try:
        bad = 0
        tname, _, secret = token.partition(".")
        if tname != name or len(secret) < 32:
            bad += 1
            rep.add("HIGH", "agent-lifecycle",
                    f"token shape {tname!r}.<{len(secret)} chars>: expected "
                    f"{name!r}.<>=32 chars>")
        body = json.dumps({"agent": {"report_interval": 1, "version": "sectest"},
                           "snapshot": {"system": {"hostname": "sectest"}}}).encode()
        hdr = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}

        def report(payload: bytes, extra: dict[str, str] | None = None) -> Resp:
            return ctx.http.req("POST", "/api/agents/report", body=payload,
                                headers={**hdr, **(extra or {})}, timeout=30.0)

        r = report(body)
        if r.status != 200 or not (r.json() or {}).get("ok"):
            bad += 1
            rep.add("HIGH", "agent-lifecycle", f"fresh token report -> {r.status}")
        # The reply is the downlink: it must not carry anything but the
        # agreed fields.
        extra = set(r.json() or {}) - {"ok", "known", "settings", "commands"}
        if extra:
            rep.add("WARN", "agent-lifecycle", f"report reply has extra keys {sorted(extra)}")
        # Body limits, with a real token.
        r = report(b" " * (8 * 1024 * 1024 + 1))
        if r.status != 413:
            bad += 1
            rep.add("HIGH", "agent-ingest", f"8MB+1 raw body -> {r.status} (expected 413)")
        r = report(b"\x1f\x8b\x08garbage", {"Content-Encoding": "gzip"})
        if r.status != 400:
            rep.add("WARN", "agent-ingest", f"corrupt gzip -> {r.status} (expected 400)")
        bomb = gzip.compress(b" " * (40 * 1024 * 1024), compresslevel=9)
        r = report(bomb, {"Content-Encoding": "gzip"})
        if r.status != 413:
            bad += 1
            rep.add("HIGH", "agent-ingest",
                    f"{len(bomb)//1024}KB gzip inflating to 40MB -> {r.status} "
                    "(expected 413)")
        r = report(b"[1,2,3]")
        if r.status != 400:
            rep.add("WARN", "agent-ingest", f"JSON array report -> {r.status}")
        r = report(b"not json")
        if r.status != 400:
            rep.add("WARN", "agent-ingest", f"non-JSON report -> {r.status}")
        # Revoke: the token must die immediately.
        ctx.http.req("POST", f"/api/agents/{name}/revoke", cookie=c)
        if report(body).status != 401:
            bad += 1
            rep.add("CRIT", "agent-lifecycle", "revoked token still accepted")
        # Rotate: old dead, new alive.
        r = ctx.http.req("POST", f"/api/agents/{name}/token", cookie=c)
        new_token = (r.json() or {}).get("token")
        if not new_token:
            bad += 1
            rep.add("HIGH", "agent-lifecycle", f"rotate -> {r.status}")
        else:
            if report(body).status != 401:
                bad += 1
                rep.add("CRIT", "agent-lifecycle", "pre-rotation token still accepted")
            hdr["Authorization"] = f"Bearer {new_token}"
            if report(body).status != 200:
                bad += 1
                rep.add("HIGH", "agent-lifecycle", "rotated token rejected")
        # Delete: gone from the list, token dead.
        ctx.http.req("DELETE", f"/api/agents/{name}", cookie=c)
        if report(body).status != 401:
            bad += 1
            rep.add("CRIT", "agent-lifecycle", "deleted agent's token still accepted")
        names = [n.get("name") for n in
                 (ctx.http.req("GET", "/api/nodes", cookie=c).json() or {}).get("nodes", [])]
        if name in names:
            bad += 1
            rep.add("HIGH", "agent-lifecycle", "deleted agent still listed")
        if not bad:
            rep.ok("agent-lifecycle", "enrol/report/revoke/rotate/delete behave; "
                   "size limits hold with a real token")
    finally:
        ctx.http.req("DELETE", f"/api/agents/{name}", cookie=c)


def check_rate_limit(ctx: Ctx) -> None:
    """--active: burn the remaining budget and prove the lockout, including
    against the CORRECT password. Locks this address out for five minutes."""
    if not ctx.args.active or not ctx.auth_enabled:
        return
    rep = ctx.report
    user = ctx.args.user or "admin"
    # The budget accounting above is best-effort (any successful login in
    # between reset it); spend the whole budget again to be sure.
    for _ in range(LOGIN_FAILURE_BUDGET):
        login(ctx, user, "wrong-" + secrets.token_hex(4))
    r = login(ctx, user, "wrong-" + secrets.token_hex(4))
    if r.status != 401:
        rep.add("HIGH", "rate-limit", f"attempt {rep.login_failures} -> {r.status}")
    if ctx.args.password:
        r = login(ctx, user, ctx.args.password, count=False)
        if r.status == 200:
            rep.add("HIGH", "rate-limit",
                    f"correct password accepted after {rep.login_failures} "
                    "failures: the limiter does not lock the address")
        else:
            rep.ok("rate-limit", f"locked out after {LOGIN_FAILURE_BUDGET} failures, "
                   "even with the right password (this address for 5 min)")
    else:
        rep.add("INFO", "rate-limit", "limiter exhausted; pass --password to "
                "prove it also blocks the correct one")


def install_leak_observer(ctx: Ctx) -> None:
    """Every response the scan receives is scanned for an escaped exception
    or an internal path -- the one class of leak that can appear anywhere."""
    seen: set[tuple[str, str]] = set()

    def observe(method: str, target: str, resp: Resp) -> None:
        if len(resp.body) > 1_000_000:
            return
        text = resp.text
        for marker in LEAK_HIGH:
            if marker in text and (target, marker) not in seen:
                seen.add((target, marker))
                ctx.report.add("HIGH", "error-leak",
                               f"{method} {target} -> {resp.status}: body contains "
                               f"{marker!r} (an exception escaped to the client)")
        if resp.status >= 400:
            for marker in LEAK_WARN:
                if marker in text and (target, marker) not in seen:
                    seen.add((target, marker))
                    ctx.report.add("WARN", "error-leak",
                                   f"{method} {target} -> {resp.status}: error "
                                   f"body mentions {marker!r}")
    ctx.http.observer = observe


def check_robustness(ctx: Ctx) -> None:
    """Malformed and abusive requests must get a 4xx (or a closed socket),
    never a 500, and the server must still answer afterwards. A 500 here is
    an unhandled exception, which is where tracebacks and denial of service
    both start."""
    rep = ctx.report
    bad = 0
    probes = 0

    def judge(label: str, status: int | None, ok: tuple[int, ...] = (),
              authed: bool = False) -> None:
        nonlocal bad, probes
        probes += 1
        if status is None:
            return  # connection closed: a fine answer to garbage
        if status >= 500 or (not authed and 200 <= status < 300):
            bad += 1
            rep.add("HIGH", "robustness", f"{label} -> {status}")
        elif ok and status not in ok:
            rep.add("INFO", "robustness", f"{label} -> {status}")

    for method in ("TRACE", "CONNECT", "PROPFIND", "PURGE", "BREW", "get"):
        r = safe_req(ctx, method, "/api/snapshot", max_read=65536)
        judge(f"{method} /api/snapshot", r.status if r else None)
    status, _ = ctx.http.raw(b"GET /api/snapshot HTTP/1.0\r\n\r\n")
    judge("HTTP/1.0 without Host", status)
    status, _ = ctx.http.raw(b"GET /api/snapshot HTTP/1.1\r\n\r\n")
    judge("HTTP/1.1 without Host", status)
    status, _ = ctx.http.raw(
        b"POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
        b"Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
    judge("Content-Length + Transfer-Encoding (smuggling shape)", status, (400,))
    status, _ = ctx.http.raw(
        b"POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n")
    judge("negative Content-Length", status, (400,))
    status, _ = ctx.http.raw(b"GET /api/snapshot HTTP/9.9\r\nHost: x\r\n\r\n")
    judge("HTTP/9.9", status)
    status, _ = ctx.http.raw(b"\x16\x03\x01\x00\x00garbage\r\n\r\n")
    judge("TLS bytes on a plain socket" if ctx.http.scheme == "http"
          else "binary garbage", status)
    r = safe_req(ctx, "GET", "/api/snapshot?" + "a" * 16384, max_read=65536)
    judge("16KB query string", r.status if r else None)
    r = safe_req(ctx, "GET", "/api/" + "a" * 8192, max_read=65536)
    judge("8KB path", r.status if r else None)
    r = safe_req(ctx, "GET", "/api/snapshot",
                 headers={"Cookie": "culprit_session=" + "a" * 65536}, max_read=65536)
    judge("64KB cookie", r.status if r else None)
    r = safe_req(ctx, "GET", "/api/snapshot",
                 headers={f"X-Filler-{i}": "v" * 100 for i in range(300)}, max_read=65536)
    judge("300 headers", r.status if r else None)
    for target in ("/api/snap%00shot", "/api/%c0%ae%c0%ae/snapshot", "/api/snapshot%ff",
                   "/%e2%80%ae/api/snapshot", "/api/snapshot/%2e%2e/%2e%2e/etc/passwd",
                   "/api/history/series?since=1e999", "/api/history/series?since=NaN",
                   "/api/history/top?limit=-1", "/api/history/top?limit=99999999999999999999",
                   "/api/history/processes?ts=abc", "/api/nodes/%ff/snapshot",
                   "/api/nodes/" + "n" * 4096 + "/snapshot", "/api/processes/-1",
                   "/api/processes/99999999999999999999", "/api/live?keys=" + "x," * 5000):
        r = safe_req(ctx, "GET", target, cookie=ctx.cookie, max_read=65536)
        judge(f"GET {target[:60]}", r.status if r else None, authed=bool(ctx.cookie))
    # Parser abuse on the one public JSON endpoint. Deep nesting is the
    # classic: Python's json raises RecursionError, which is not a
    # ValueError, so an unguarded handler answers 500; a float that JSON
    # cannot represent (1e400 -> inf, NaN) breaks the 422 serializer when
    # the error echoes the input. Every body here omits the password field,
    # so even a fully parsed one stops at validation and never spends a
    # login attempt.
    json_ct = {"Content-Type": "application/json"}
    for label, body in (
        ("100k-deep JSON array", b"[" * 100_000 + b"]" * 100_000),
        ("100k-deep JSON object", b'{"a":' * 100_000 + b"1" + b"}" * 100_000),
        ("1e400 number", b'{"username": 1e400}'),
        ("NaN literal", b'{"username": NaN}'),
        ("Infinity literal", b'{"username": -Infinity}'),
        ("invalid UTF-8", b'{"username": "\xff\xfe"}'),
        ("BOM prefix", b'\xef\xbb\xbf{"username": "a"}'),
        ("duplicate keys", b'{"username": "a", "username": "b"}'),
        ("2MB string", b'{"username": "' + b"a" * 2_000_000 + b'"}'),
        ("null byte in string", b'{"username": "a\\u0000b"}'),
        ("surrogate escape", b'{"username": "\\ud800"}'),
    ):
        r = safe_req(ctx, "POST", "/api/login", body=body, headers=json_ct,
                     max_read=65536, timeout=20.0)
        if r is not None and r.status == 401:
            rep.login_failures += 1
        judge(f"login with {label}", r.status if r else None)
    for encoding in ("gzip", "br", "deflate", "chunked, gzip"):
        r = safe_req(ctx, "POST", "/api/login", body=b'{"username":"a"}',
                     headers={**json_ct, "Content-Encoding": encoding}, max_read=65536)
        if r is not None and r.status == 401:
            rep.login_failures += 1
        judge(f"login with Content-Encoding {encoding}", r.status if r else None)
    # A 422 must describe the problem without echoing what was sent: the
    # default FastAPI body repeats the input, which for this endpoint is a
    # password.
    marker = "sectest-" + secrets.token_hex(4)
    r = safe_req(ctx, "POST", "/api/login", headers=json_ct,
                 body=json.dumps({"username": 5, "password": marker}).encode())
    if r is not None and marker in r.text:
        bad += 1
        rep.add("WARN", "robustness", "the 422 validation response echoes the "
                "submitted password back (it ends up in proxy and browser logs)")

    # A burst of concurrent requests: nothing may 500 and nothing may be
    # answered to the wrong client (a snapshot leaking through a shared
    # response object would show as a 200 on an unauthenticated request).
    n = max(1, int(ctx.args.concurrency))
    statuses: list[int | None] = []
    lock = threading.Lock()

    def worker(i: int) -> None:
        pick = i % 3
        try:
            if pick == 0:
                r = ctx.http.req("GET", "/api/snapshot", max_read=65536)
            elif pick == 1:
                r = ctx.http.req("GET", "/api/auth", max_read=65536)
            else:
                r = ctx.http.req("POST", "/api/login", body=b"{", headers=json_ct,
                                 max_read=65536)
            status: int | None = r.status
            if pick == 0 and 200 <= r.status < 300:
                status = 299  # marker: data without a session
        except (OSError, http.client.HTTPException):
            status = None
        with lock:
            statuses.append(status)

    threads = [threading.Thread(target=worker, args=(i,), daemon=True)
               for i in range(n * 3)]
    started = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    took = time.perf_counter() - started
    dropped = statuses.count(None)
    errors = sum(1 for st in statuses if st and st >= 500)
    leaked = statuses.count(299)
    if leaked:
        bad += 1
        rep.add("CRIT", "robustness", f"{leaked} unauthenticated requests got data during a burst")
    if errors:
        bad += 1
        rep.add("HIGH", "robustness", f"{errors} responses >= 500 during a {len(threads)}-way burst")
    if dropped:
        rep.add("WARN", "robustness", f"{dropped} of {len(threads)} connections dropped "
                f"during the burst ({took:.1f}s)")
    probes += len(threads)
    try:
        alive = ctx.http.req("GET", "/api/healthz", timeout=4.0).status == 200
    except OSError:
        alive = False
    if not alive:
        bad += 1
        rep.add("CRIT", "robustness", "server stopped answering after the probes")
    if not bad:
        rep.ok("robustness", f"{probes} malformed/abusive requests: no 5xx, no data, "
               f"still answering ({len(threads)}-way burst in {took:.1f}s)")


def check_session_hygiene(ctx: Ctx) -> None:
    """The cookie is the only credential a browser holds; how it is handled
    on ordinary requests matters as much as how it is issued."""
    if not ctx.cookie:
        return
    rep = ctx.report
    bad = 0
    r = ctx.http.req("GET", "/api/auth", cookie=ctx.cookie)
    if r.header("set-cookie"):
        bad += 1
        rep.add("WARN", "session", "cookie re-issued on a plain GET: every request "
                "extends the session, so an idle stolen cookie never expires")
    try:
        expiry = int(ctx.cookie.rsplit(":", 2)[1])
        days = (expiry - time.time()) / 86400
        if days > 30:
            bad += 1
            rep.add("WARN", "session", f"session lifetime is {days:.0f} days")
        else:
            rep.add("INFO", "session", f"session lifetime {days:.1f} days, "
                    "stateless (revoked by a password change)")
    except (ValueError, IndexError):
        pass
    # The cookie must be accepted only as a cookie.
    for label, target, headers in (
        ("query parameter", "/api/auth?culprit_session=" + quote(ctx.cookie, safe=""), {}),
        ("bearer header", "/api/auth", {"Authorization": "Bearer " + ctx.cookie}),
        ("custom header", "/api/auth", {"X-Session": ctx.cookie}),
        ("basic auth", "/api/auth", {"Authorization": "Basic " + __import__("base64").b64encode(
            f"{ctx.args.user or 'x'}:{ctx.args.password or 'x'}".encode()).decode()}),
    ):
        r = ctx.http.req("GET", target, headers=headers)
        if (r.json() or {}).get("username"):
            bad += 1
            rep.add("HIGH", "session", f"session accepted via {label}")
    # Two cookies in one header: the first must win deterministically and a
    # forged second must not be consulted.
    r = ctx.http.req("GET", "/api/auth", headers={
        "Cookie": f"culprit_session=forged; culprit_session={ctx.cookie}"})
    r2 = ctx.http.req("GET", "/api/auth", headers={
        "Cookie": f"culprit_session={ctx.cookie}; culprit_session=forged"})
    if (r.json() or {}).get("username") and (r2.json() or {}).get("username"):
        rep.add("INFO", "session", "duplicate cookie names: either wins "
                "(harmless -- both are checked against the HMAC)")
    if not bad:
        rep.ok("session", "cookie not re-issued per request, bounded lifetime, "
               "accepted only as a cookie")


def check_password_revocation(ctx: Ctx) -> None:
    """--throwaway-user only: change the password and prove that every other
    session for the account dies at once, while the changing session is
    re-issued."""
    if not (ctx.throwaway and ctx.cookie):
        return
    rep = ctx.report
    user, old_pw = ctx.throwaway
    second = login(ctx, user, old_pw, count=False)
    m = re.search(r"culprit_session=([^;]+)", second.header("set-cookie") or "")
    if not m:
        rep.add("WARN", "revocation", "could not open a second session; skipped")
        return
    cookie2 = m.group(1)
    new_pw = "sectest-" + secrets.token_urlsafe(12)
    r = ctx.http.req("POST", "/api/account/password",
                     json_body={"current_password": old_pw, "new_password": new_pw},
                     cookie=ctx.cookie)
    if r.status != 200:
        rep.add("WARN", "revocation", f"password change -> {r.status}; skipped")
        return
    m = re.search(r"culprit_session=([^;]+)", r.header("set-cookie") or "")
    reissued = m.group(1) if m else None
    bad = 0
    for label, cookie in (("the changing session's old cookie", ctx.cookie),
                          ("a second session", cookie2)):
        if (ctx.http.req("GET", "/api/auth", cookie=cookie).json() or {}).get("username"):
            bad += 1
            rep.add("HIGH", "revocation", f"{label} still valid after a password change")
    if not reissued:
        bad += 1
        rep.add("HIGH", "revocation", "no fresh cookie issued with the password change "
                "(the user who changed it is logged out)")
    elif (ctx.http.req("GET", "/api/auth", cookie=reissued).json() or {}).get("username") != user:
        bad += 1
        rep.add("HIGH", "revocation", "the re-issued cookie does not verify")
    if login(ctx, user, old_pw).status == 200:
        bad += 1
        rep.add("CRIT", "revocation", "the OLD password still signs in")
    if login(ctx, user, new_pw, count=False).status != 200:
        bad += 1
        rep.add("HIGH", "revocation", "the new password does not sign in")
    ctx.cookie = reissued or ctx.cookie
    ctx.throwaway = (user, new_pw)
    ctx.args.password = new_pw
    if not bad:
        rep.ok("revocation", "password change killed both other sessions and the "
               "old password; the changing session was re-issued")


def check_limiter_bypass(ctx: Ctx) -> None:
    """--active, after the lockout: forwarding headers must not give an
    attacker a fresh address. From an undeclared peer they are refused
    outright (check_proxy_trust); this proves the refusal also covers the
    login route while a lockout is in force."""
    if not (ctx.args.active and ctx.args.password and ctx.auth_enabled):
        return
    user = ctx.args.user or "admin"
    plain = login(ctx, user, ctx.args.password, count=False)
    if plain.status == 200:
        ctx.report.add("INFO", "rate-limit", "no lockout in effect; bypass check skipped")
        return
    bad = 0
    for headers in ({"X-Forwarded-For": "10.9.9.9"}, {"X-Real-IP": "10.9.9.9"},
                    {"Forwarded": "for=10.9.9.9"},
                    {"X-Forwarded-For": "127.0.0.1, 10.9.9.9"},
                    {"X-Client-IP": "10.9.9.9"}, {"True-Client-IP": "10.9.9.9"},
                    {"CF-Connecting-IP": "10.9.9.9"}):
        r = ctx.http.req("POST", "/api/login", headers=headers,
                         json_body={"username": user, "password": ctx.args.password})
        if r.status == 200:
            bad += 1
            ctx.report.add("HIGH", "rate-limit",
                           f"lockout bypassed with {headers} -- the server honours "
                           "forwarding headers from this address; only a declared "
                           "proxy may be trusted (Settings > Network trust)")
    if not bad:
        ctx.report.ok("rate-limit", "lockout holds against 7 forwarding-header spoofs")


def check_agent_isolation(ctx: Ctx) -> None:
    """--active: two throwaway agents. One must not be able to write the
    other's snapshot or answer the other's pending command -- the properties
    that keep one compromised machine from lying about the rest."""
    if not (ctx.args.active and ctx.cookie):
        return
    rep = ctx.report
    c = ctx.cookie
    names = [f"sectest-a-{secrets.token_hex(2)}", f"sectest-b-{secrets.token_hex(2)}"]
    tokens: dict[str, str] = {}
    try:
        for name in names:
            r = ctx.http.req("POST", "/api/agents", json_body={"name": name}, cookie=c)
            token = (r.json() or {}).get("token")
            if not token:
                rep.add("WARN", "agent-isolation", f"could not enrol {name}: {r.status}")
                return
            tokens[name] = token
        a, b = names

        def report(name: str, payload: dict[str, Any]) -> Resp:
            body = json.dumps({"agent": {"report_interval": 1, "version": "sectest"},
                               "snapshot": {"system": {"hostname": name}}, **payload})
            return ctx.http.req("POST", "/api/agents/report", body=body.encode(),
                                headers={"Content-Type": "application/json",
                                         "Authorization": f"Bearer {tokens[name]}"},
                                timeout=30.0)
        report(a, {})
        report(b, {})
        bad = 0
        # 1. A claims to be B in its payload.
        report(a, {"agent": {"name": b, "report_interval": 1},
                   "snapshot": {"system": {"hostname": "spoofed-by-a"}}})
        snap_b = ctx.http.req("GET", f"/api/nodes/{b}/snapshot", cookie=c).json() or {}
        if ((snap_b.get("system") or {}).get("hostname")) == "spoofed-by-a":
            bad += 1
            rep.add("CRIT", "agent-isolation", "an agent overwrote another node's "
                    "snapshot by naming it in the payload")
        # 2. Command results: A answers a command queued for B.
        results: dict[str, Resp | None] = {}

        def fetch(node: str, key: str) -> None:
            results[key] = safe_req(ctx, "GET", f"/api/nodes/{node}/processes/1",
                                    cookie=c, timeout=40.0)
        ta = threading.Thread(target=fetch, args=(a, "a"), daemon=True)
        ta.start()
        time.sleep(0.6)
        reply = report(a, {}).json() or {}
        cmds = [cmd for cmd in reply.get("commands") or [] if cmd.get("action") == "process_detail"]
        if not cmds:
            rep.add("WARN", "agent-isolation", "the queued command never reached the "
                    "agent; cannot test result scoping")
            ta.join(45)
            return
        own_id = str(cmds[0]["id"])
        seq = int(own_id.rsplit(":", 1)[1])
        report(a, {"command_results": [{"id": own_id, "ok": True,
                                        "result": {"pid": 1, "name": "sectest-own"}}]})
        ta.join(45)
        ra = results.get("a")
        if not (ra and ra.status == 200 and "sectest-own" in ra.text):
            rep.add("WARN", "agent-isolation", "the legitimate command path did not "
                    f"round-trip ({ra.status if ra else 'no answer'}); scoping test "
                    "is inconclusive")
        tb = threading.Thread(target=fetch, args=(b, "b"), daemon=True)
        tb.start()
        time.sleep(0.6)
        fake = [{"id": f"{b}:{n}", "ok": True,
                 "result": {"pid": 1, "name": "spoofed-by-a"}}
                for n in range(max(1, seq - 5), seq + 80)]
        report(a, {"command_results": fake})
        time.sleep(0.4)
        if results.get("b") is not None:
            bad += 1
            rep.add("CRIT", "agent-isolation", "agent A resolved a command queued "
                    "for agent B with a fabricated result")
        reply_b = report(b, {}).json() or {}
        report(b, {"command_results": [{"id": cmd["id"], "ok": False, "status": 404,
                                        "error": "sectest"} for cmd in
                                       reply_b.get("commands") or []]})
        tb.join(45)
        rb = results.get("b")
        if rb and rb.status == 200 and "spoofed-by-a" in rb.text:
            bad += 1
            rep.add("CRIT", "agent-isolation", "the dashboard showed A's fabricated "
                    "detail as B's")
        elif not (rb and rb.status == 404):
            rep.add("INFO", "agent-isolation",
                    f"B's own answer arrived as {rb.status if rb else 'no answer'}")
        if not bad:
            rep.ok("agent-isolation", "payload node names ignored; command results "
                   "accepted only from the node they were queued for")
    finally:
        for name in names:
            ctx.http.req("DELETE", f"/api/agents/{name}", cookie=c)


# ------------------------------------------------------------ throwaway user
def create_throwaway_user(ctx: Ctx) -> tuple[str, str] | None:
    """Make a temporary dashboard user through the CLI (same machine, same
    database as the server), wait for the server's 5s auth cache, and hand
    back the credentials. Removed again by remove_throwaway_user()."""
    name = f"sectest-{secrets.token_hex(3)}"
    password = secrets.token_urlsafe(16)
    try:
        subprocess.run([sys.executable, "-m", "culprit", "users", "add", name],
                       input=f"{password}\n{password}\n", text=True,
                       capture_output=True, cwd=ROOT, check=True, timeout=30)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        ctx.report.add("WARN", "throwaway-user", f"could not create a user via the CLI: "
                       f"{getattr(exc, 'stderr', exc)!s:.120}")
        return None
    deadline = time.time() + 12
    while time.time() < deadline:
        r = login(ctx, name, password, count=False)
        if r.status == 200:
            ctx.report.add("INFO", "throwaway-user",
                           f"created {name!r} for this scan (removed at the end)")
            return name, password
        time.sleep(1.0)
    ctx.report.add("WARN", "throwaway-user", f"{name!r} was created but cannot sign in "
                   "-- is the server using the same database as this checkout?")
    remove_throwaway_user(name)
    return None


def remove_throwaway_user(name: str) -> None:
    subprocess.run([sys.executable, "-m", "culprit", "users", "remove", name],
                   capture_output=True, cwd=ROOT, timeout=30)


def write_json(path: str, url: str, args: argparse.Namespace, report: Report,
               result: str) -> None:
    payload = {
        "url": url, "mode": "active" if args.active else "safe",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "result": result,
        "counts": {lvl: sum(1 for f in report.findings if f.level == lvl)
                   for lvl in ("CRIT", "HIGH", "WARN", "INFO", "PASS")},
        "login_failures_spent": report.login_failures,
        "findings": [{"level": f.level, "check": f.check, "detail": f.detail}
                     for f in report.findings],
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)


# ---------------------------------------------------------------------- main
def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0],
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    parser.add_argument("--url", default=None,
                        help="base URL (default http://127.0.0.1:<port>)")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--user", help="dashboard user for authenticated checks")
    parser.add_argument("--password")
    parser.add_argument("--active", action="store_true",
                        help="also run state-changing checks: throwaway agent "
                             "lifecycle, and exhausting the login limiter "
                             "(locks this address out for 5 minutes)")
    parser.add_argument("--throwaway-user", action="store_true",
                        help="create a temporary dashboard user via the CLI for "
                             "the authenticated checks (server must share this "
                             "checkout's database); enables the password-change "
                             "revocation check; the user is removed afterwards")
    parser.add_argument("--insecure", action="store_true",
                        help="accept a self-signed certificate")
    parser.add_argument("--strict", action="store_true",
                        help="exit 1 on WARN as well as HIGH/CRIT")
    parser.add_argument("--only", default="",
                        help="comma-separated groups to run: " + ", ".join(GROUPS))
    parser.add_argument("--skip", default="",
                        help="comma-separated groups to skip")
    parser.add_argument("--timeout", type=float, default=8.0,
                        help="per-request timeout in seconds (default 8)")
    parser.add_argument("--concurrency", type=int, default=8,
                        help="parallel clients per kind in the burst probe "
                             "(default 8 -> 24 requests); 0 disables")
    parser.add_argument("--quiet", action="store_true",
                        help="print only non-PASS findings")
    parser.add_argument("--json", metavar="PATH",
                        help="also write every finding to a JSON file")
    args = parser.parse_args()
    url = args.url or f"http://127.0.0.1:{args.port}"

    only = {g for g in args.only.split(",") if g}
    skip = {g for g in args.skip.split(",") if g}
    unknown = (only | skip) - set(GROUPS)
    if unknown:
        print(f"{RED}unknown group(s) {sorted(unknown)}; choose from "
              f"{', '.join(GROUPS)}{RESET}")
        return 2

    def want(group: str) -> bool:
        return (not only or group in only) and group not in skip

    http_ = Http(url, args.insecure, timeout=args.timeout)
    report = Report(quiet=args.quiet)
    ctx = Ctx(http_, report, args)
    install_leak_observer(ctx)
    print(f"{BOLD}culprit security check{RESET} -> {url}"
          f"{'  [active]' if args.active else '  [safe: read-only probes]'}")
    try:
        probe = ctx.http.req("GET", "/api/healthz", timeout=4.0)
    except OSError as exc:
        print(f"{RED}cannot reach {url}: {exc}{RESET}")
        return 2
    if probe.status == 400 and (probe.json() or {}).get("reason"):
        # The host refuses this scanner's network path (Host not in the
        # trusted list, or the scanner sits behind an undeclared proxy).
        # Nothing below could tell a refusal from a gate, so stop here.
        print(f"{RED}{url} refuses this scanner: "
              f"{(probe.json() or {}).get('detail')}{RESET}")
        return 2

    section("Surface")
    load_routes(ctx)
    check_transport(ctx)
    check_auth_state(ctx)
    if args.throwaway_user and ctx.auth_enabled:
        ctx.throwaway = create_throwaway_user(ctx)
        if ctx.throwaway:
            args.user, args.password = ctx.throwaway
    try:
        # Sign in first: a successful login clears this address's failure
        # count, so the unauthenticated probes below start with the full
        # budget.
        do_login(ctx)

        if want("gate"):
            section("Gate")
            check_route_gate(ctx)
            check_public_routes(ctx)
            check_path_bypass(ctx)
            check_proxy_trust(ctx)
            check_host_trust(ctx)
            check_static(ctx)

        if want("browser"):
            section("Browser-facing")
            check_headers(ctx)
            check_cors(ctx)

        if want("credentials"):
            section("Credentials")
            check_login(ctx)
            check_session_forgery(ctx)
            check_agent_ingest_unauth(ctx)

        if want("robustness"):
            section("Robustness")
            check_robustness(ctx)

        if ctx.cookie and want("authenticated"):
            section("Authenticated")
            check_session_hygiene(ctx)
            check_authenticated_reads(ctx)
            check_injection(ctx)
            check_authenticated_writes(ctx)
            check_password_revocation(ctx)
            if want("active"):
                check_agent_lifecycle(ctx)
                check_agent_isolation(ctx)
            check_logout(ctx)
        elif not ctx.cookie:
            print(f"\n{DIM}(pass --user/--password or --throwaway-user for the "
                  f"authenticated checks: secret leakage, injection, write "
                  f"validation, revocation){RESET}")

        if args.active and want("active"):
            section("Active")
            check_rate_limit(ctx)
            check_limiter_bypass(ctx)
    finally:
        if ctx.throwaway:
            remove_throwaway_user(ctx.throwaway[0])
            report.add("INFO", "throwaway-user", f"removed {ctx.throwaway[0]!r}")

    counts = {level: sum(1 for f in report.findings if f.level == level)
              for level in ("CRIT", "HIGH", "WARN", "INFO", "PASS")}
    print(f"\n{BOLD}summary{RESET}  " + "  ".join(
        f"{lvl} {n}" for lvl, n in counts.items() if n or lvl in ("CRIT", "HIGH")))
    worst = report.worst()
    failing = worst in ("CRIT", "HIGH") or (args.strict and worst == "WARN")
    result = "FAIL" if failing else "OK"
    print(f"{RED if failing else GREEN}{result}{RESET}")
    if args.json:
        write_json(args.json, url, args, report, result)
        print(f"{DIM}findings written to {args.json}{RESET}")
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
