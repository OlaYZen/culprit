"""Static security audit of the source tree -- the checks a running server
cannot answer.

`check_security.py` proves what the wire shows. This reads the code for the
things that only show up *before* they are exploited: an HTML sink fed an
unescaped value from an agent (a process on a monitored box can name itself
`<img onerror=...>`), a public handler that reaches into the data store, SQL
assembled from request strings, a cookie set without HttpOnly, a decompression
with no bound, a credential file that got tracked, a database file that lost
its 600 mode. None of these needs a server, so this runs in seconds and can
sit in a pre-commit hook.

    .venv/bin/python tools/audit_security.py
    .venv/bin/python tools/audit_security.py --strict     # WARN also fails

Findings are HIGH/WARN/INFO; exit status 1 on HIGH (or WARN with --strict).
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import re
import stat
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

GREEN, RED, YELLOW, BLUE, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[34m", "\033[1m", "\033[0m",
)

# Mirrors check_security.py: what may be reachable without a session.
EXPECTED_PUBLIC_PATHS = frozenset({
    "/login", "/api/login", "/api/auth", "/api/healthz", "/favicon.svg",
})
EXPECTED_AGENT_PATHS = frozenset({"/api/agents/report"})
EXPECTED_PUBLIC_PREFIXES = ("/assets/",)
# Routes that are pages rather than API, and so redirect instead of 401.
EXPECTED_PAGE_ROUTES = frozenset({"/", "/login", "/favicon.svg", "/assets"})

# --- HTML sinks in the frontend -------------------------------------------
# Anything that turns a string into markup. `html:` is the `el()` attribute,
# `frag()` builds a node from a string, `body:` reaches `#modal-body.innerHTML`
# when given a string.
SINK_RE = re.compile(
    r"(\.innerHTML\s*\+?=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|"
    r"\bhtml:\s*|\bfrag\s*\(|\bbody:\s*|document\.write\s*\(|"
    r"\beval\s*\(|new\s+Function\s*\()")
# Producers whose output is trusted markup: escaped text, or our own SVG icon
# strings. Everything else interpolated into a sink is a finding.
TRUSTED_INTERPOLATION = re.compile(
    r"^\s*(esc|escapeHtml|toneIcon|svg|frag)\s*\(|^\s*icons(\.\w+|\[)")
STRING_LITERAL = re.compile(r"""^\s*(["'])(?:\\.|(?!\1).)*\1\s*$""")

# --- Python ---------------------------------------------------------------
PY_DANGER = [
    (re.compile(r"\bshell\s*=\s*True"), "HIGH", "subprocess with shell=True"),
    (re.compile(r"\bos\.system\s*\("), "HIGH", "os.system"),
    (re.compile(r"(?<![\w.])eval\s*\("), "HIGH", "eval()"),
    (re.compile(r"(?<![\w.])exec\s*\("), "HIGH", "exec()"),
    (re.compile(r"\bpickle\.loads?\s*\("), "HIGH", "pickle from untrusted bytes"),
    (re.compile(r"\byaml\.load\s*\((?!.*Loader)"), "HIGH", "yaml.load without Loader"),
    (re.compile(r"\bgzip\.decompress\s*\("), "HIGH",
     "unbounded gzip.decompress on a network body (a 4MB bomb inflates to "
     "4GB before any length check); use zlib.decompressobj with max_length"),
    (re.compile(r"\bzlib\.decompress\s*\("), "HIGH",
     "unbounded zlib.decompress; use decompressobj with max_length"),
    (re.compile(r"\bverify\s*=\s*False"), "WARN", "TLS verification disabled"),
    (re.compile(r"CERT_NONE"), "WARN", "TLS verification disabled"),
    (re.compile(r"\bmd5\b|\bsha1\b"), "WARN", "weak hash (fine for non-security use)"),
    (re.compile(r"\brandom\.(random|randint|choice)\s*\("), "INFO",
     "non-cryptographic random (fine unless it feeds a token)"),
]
SQL_KEYWORD = re.compile(r"\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b")
# Names that hold request-derived strings in this codebase.
# (`columns` is the request parameter's name too, but by the time it reaches
# SQL it has been filtered through _SAMPLE_COLUMNS -- listed as INFO instead.)
REQUEST_DERIVED = {"node", "name", "kinds", "since", "until", "ts", "limit",
                   "username", "password", "pid", "key", "value",
                   "patch", "payload", "token"}


@dataclass
class Finding:
    level: str
    check: str
    where: str
    detail: str


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    quiet: bool = False

    def add(self, level: str, check: str, where: str, detail: str) -> None:
        self.findings.append(Finding(level, check, where, detail))
        if self.quiet and level in ("PASS", "INFO"):
            return
        colour = {"HIGH": RED, "WARN": YELLOW, "INFO": BLUE, "PASS": GREEN}[level]
        loc = f"{where}: " if where else ""
        print(f"  {colour}{level:<4}{RESET} {check}: {loc}{detail}")

    def ok(self, check: str, detail: str) -> None:
        self.add("PASS", check, "", detail)


def section(title: str) -> None:
    print(f"\n{BOLD}{title}{RESET}")


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


# ------------------------------------------------------------ frontend XSS
def template_literal_at(src: str, start: int) -> tuple[str, int] | None:
    """If src[start] is a backtick, return (literal body, end index)."""
    if start >= len(src) or src[start] != "`":
        return None
    i = start + 1
    depth = 0
    while i < len(src):
        ch = src[i]
        if ch == "\\":
            i += 2
            continue
        if depth == 0 and ch == "`":
            return src[start + 1:i], i + 1
        if src.startswith("${", i):
            depth += 1
            i += 2
            continue
        if ch == "}" and depth > 0:
            depth -= 1
        elif ch == "`" and depth > 0:
            # A nested template inside ${...}: skip it whole.
            nested = template_literal_at(src, i)
            if nested:
                i = nested[1]
                continue
        i += 1
    return None


def interpolations(body: str) -> list[str]:
    """Top-level `${...}` expressions of a template body."""
    out: list[str] = []
    i = 0
    while i < len(body):
        if body.startswith("${", i):
            depth = 1
            j = i + 2
            while j < len(body) and depth:
                if body[j] == "{":
                    depth += 1
                elif body[j] == "}":
                    depth -= 1
                j += 1
            out.append(body[i + 2:j - 1])
            i = j
        else:
            i += 1
    return out


def split_ternary(expr: str) -> list[str]:
    """`cond ? a : b` -> [a, b] (nested ternaries flattened); else [expr]."""
    depth = 0
    q = -1
    for i, ch in enumerate(expr):
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "?" and depth == 0 and q < 0:
            q = i
    if q < 0:
        return [expr]
    rest = expr[q + 1:]
    depth = 0
    for i, ch in enumerate(rest):
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == ":" and depth == 0:
            return split_ternary(rest[:i]) + split_ternary(rest[i + 1:])
    return [expr]


def value_is_trusted(expr: str) -> bool:
    for branch in split_ternary(expr):
        b = branch.strip()
        if not b:
            continue
        if STRING_LITERAL.match(b) or TRUSTED_INTERPOLATION.match(b):
            continue
        if b in ("''", '""', "null", "undefined"):
            continue
        return False
    return True


def audit_frontend(rep: Report) -> None:
    web = ROOT / "web"
    files = sorted(web.rglob("*.js")) + sorted(web.rglob("*.html"))
    sinks = 0
    bad = 0
    for path in files:
        src = path.read_text(encoding="utf-8")
        for m in SINK_RE.finditer(src):
            sinks += 1
            line = src.count("\n", 0, m.start()) + 1
            where = f"{rel(path)}:{line}"
            after = m.end()
            while after < len(src) and src[after] in " \t\n=":
                after += 1
            lit = template_literal_at(src, after)
            if lit is None:
                # A plain string is static; an identifier means "whatever the
                # caller passed" -- fine inside the helpers that define the
                # sink, but worth listing so the trust boundary is visible.
                head = src[after:after + 60].split("\n")[0]
                if head[:1] in "\"'" or head.startswith("icons."):
                    continue
                if m.group(0).strip().startswith(("body:", "frag")):
                    # `body:` is also fetch()'s body and section()'s Node
                    # slot; only a template literal there is a sink worth
                    # listing, and that case is handled above.
                    continue
                rep.add("INFO", "html-sink", where,
                        f"dynamic value into {m.group(0).strip()} {head[:40]!r}")
                continue
            body, _ = lit
            for expr in interpolations(body):
                if value_is_trusted(expr):
                    continue
                bad += 1
                rep.add("HIGH", "xss", where,
                        f"unescaped interpolation into {m.group(0).strip()}: "
                        f"${{{expr.strip()[:60]}}} -- wrap in esc()")
    if not bad:
        rep.ok("xss", f"{sinks} HTML sinks across {len(files)} files: every "
               "interpolated value is escaped or a static icon")
    # index.html / login.html must not inline data or third-party script.
    for name in ("index.html", "login.html"):
        html = (web / name).read_text(encoding="utf-8")
        for m in re.finditer(r"<script[^>]*src=[\"']([^\"']+)", html):
            if m.group(1).startswith(("http://", "https://", "//")):
                rep.add("HIGH", "third-party-script", rel(web / name),
                        f"loads {m.group(1)} -- a CDN outage or compromise "
                        "becomes a dashboard compromise")
        for m in re.finditer(r"\son[a-z]+\s*=\s*[\"']", html):
            lineno = html.count("\n", 0, m.start()) + 1
            rep.add("WARN", "inline-handler", f"{rel(web / name)}:{lineno}",
                    "inline event handler attribute (blocks a strict CSP later)")
    # Every fetch() must be same-origin: an absolute URL is either a typo or
    # an exfiltration path for the session cookie.
    absolute_fetch = 0
    for path in files:
        src = path.read_text(encoding="utf-8")
        for m in re.finditer(r"""fetch\(\s*[`"'](https?:)?//""", src):
            absolute_fetch += 1
            lineno = src.count("\n", 0, m.start()) + 1
            rep.add("HIGH", "fetch-origin", f"{rel(path)}:{lineno}",
                    "fetch() to an absolute URL -- credentials could leave the origin")
        for m in re.finditer(r"""target\s*=\s*[\"']_blank[\"']""", src):
            window = src[m.start() - 200:m.end() + 200]
            if "noopener" not in window:
                lineno = src.count("\n", 0, m.start()) + 1
                rep.add("WARN", "link-target", f"{rel(path)}:{lineno}",
                        'target="_blank" without rel="noopener" (reverse tabnabbing)')
        for m in re.finditer(r"""href\s*[=:]\s*[\"'`]\s*javascript:""", src):
            lineno = src.count("\n", 0, m.start()) + 1
            rep.add("HIGH", "javascript-href", f"{rel(path)}:{lineno}", "javascript: URL")
    if not absolute_fetch:
        rep.ok("fetch-origin", "every fetch() is same-origin; no javascript: URLs")
    login = (web / "login.html").read_text(encoding="utf-8")
    problems = []
    if 'type="password"' not in login:
        problems.append("no type=password input")
    if "autocomplete" not in login:
        problems.append("no autocomplete hint on the credential fields")
    if not re.search(r"""fetch\(\s*["']/api/login["'][^)]*method:\s*["']POST""", login, re.S):
        problems.append("login is not a POST to /api/login")
    if re.search(r"""method\s*=\s*["']get["']""", login, re.I):
        problems.append("a GET form (credentials would land in the URL and logs)")
    if problems:
        rep.add("HIGH", "login-form", "web/login.html", "; ".join(problems))
    else:
        rep.ok("login-form", "password field, autocomplete hints, POSTs to /api/login")


# -------------------------------------------------------------- python
def audit_python(rep: Report) -> None:
    pkg = ROOT / "culprit"
    hits = 0
    for path in sorted(pkg.rglob("*.py")):
        src = path.read_text(encoding="utf-8")
        for lineno, line in enumerate(src.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            code = stripped.split("#", 1)[0]
            for pattern, level, what in PY_DANGER:
                if pattern.search(code):
                    if level != "INFO":
                        hits += 1
                    rep.add(level, "py-danger", f"{rel(path)}:{lineno}", what)
    if not hits:
        rep.ok("py-danger", "no shell=True, eval/exec, pickle, unbounded "
               "decompression or disabled TLS verification")

    # SQL assembled from strings: list the interpolated names, and fail when
    # one of them is a request-derived value.
    sql_hits = 0
    db = pkg / "db.py"
    src = db.read_text(encoding="utf-8")
    for m in re.finditer(r'f"([^"]*)"', src):
        text = m.group(1)
        if not SQL_KEYWORD.search(text):
            continue
        names = re.findall(r"\{([A-Za-z_][\w.]*)", text)
        if not names:
            continue
        lineno = src.count("\n", 0, m.start()) + 1
        tainted = [n for n in names if n.split(".")[0] in REQUEST_DERIVED]
        if tainted:
            sql_hits += 1
            rep.add("HIGH", "sql-injection", f"{rel(db)}:{lineno}",
                    f"request-derived {tainted} interpolated into SQL")
        else:
            rep.add("INFO", "sql-dynamic", f"{rel(db)}:{lineno}",
                    f"SQL built from {names} (reviewed: allow-listed columns / "
                    "placeholder lists)")
    if not sql_hits:
        rep.ok("sql-injection", "no request value is interpolated into SQL; "
               "values travel as ? parameters")

    # subprocess must always take an argv list: a string plus shell=False is
    # a bug, a string plus shell=True is an injection.
    argv_bad = 0
    for path in sorted(pkg.rglob("*.py")):
        src_py = path.read_text(encoding="utf-8")
        for m in re.finditer(r"subprocess\.(run|Popen|check_output|check_call|call)\(\s*([^\s,)]+)",
                             src_py):
            first = m.group(2)
            if not (first.startswith("[") or first[:1].isupper() or first.startswith("_")):
                # A bare identifier holding a list (`cmd`) is fine; a string
                # literal is not.
                if first[:1] in "\"'f":
                    argv_bad += 1
                    lineno = src_py.count("\n", 0, m.start()) + 1
                    rep.add("HIGH", "subprocess-argv", f"{rel(path)}:{lineno}",
                            f"command passed as a string {first[:30]!r}")
    if not argv_bad:
        rep.ok("subprocess-argv", "every subprocess call passes an argv list")

    # Cookie hygiene at every set_cookie call site.
    main = pkg / "main.py"
    src = main.read_text(encoding="utf-8")
    for m in re.finditer(r"set_cookie\((.*?)\)\n", src, re.S):
        args = m.group(1)
        lineno = src.count("\n", 0, m.start()) + 1
        missing = [flag for flag in ("httponly=True", "samesite=", "secure=")
                   if flag not in args]
        if missing:
            rep.add("HIGH", "cookie", f"{rel(main)}:{lineno}",
                    f"set_cookie without {missing}")
    rep.ok("cookie", "every set_cookie sets HttpOnly, SameSite and Secure")

    # Constant-time comparisons where secrets are compared.
    auth_src = (pkg / "auth.py").read_text(encoding="utf-8")
    src_db = (pkg / "db.py").read_text(encoding="utf-8")
    for name, text in (("auth.py", auth_src), ("db.py", src_db)):
        if re.search(r"\b(sig|digest|token_hash|expected)\s*==\s*", text):
            rep.add("HIGH", "timing", name,
                    "a signature/hash is compared with == (use hmac.compare_digest)")
    if "compare_digest" in auth_src and "compare_digest" in src_db:
        rep.ok("timing", "signatures and token hashes use hmac.compare_digest")
    # The unknown-user path must cost the same as a wrong password: one
    # scrypt, against a hash computed once, not a fresh salt per request.
    if re.search(r"verify_password\([^)]*hash_password\(", src_db):
        rep.add("WARN", "timing", "culprit/db.py",
                "unknown-user path hashes a fresh dummy AND verifies it: two "
                "scrypts vs one, a ~2x latency oracle for username enumeration")

    # Response hardening must still be wired into the middleware.
    if "_harden(" not in src or "X-Frame-Options" not in src:
        rep.add("HIGH", "headers", "culprit/main.py",
                "the response-hardening middleware (_harden) is gone")
    else:
        for header in ("X-Content-Type-Options", "X-Frame-Options",
                       "Content-Security-Policy", "Referrer-Policy", "no-store"):
            if header not in src:
                rep.add("HIGH", "headers", "culprit/main.py", f"{header} no longer set")
        rep.ok("headers", "_harden sets nosniff, frame denial, referrer policy, no-store")


def audit_constants(rep: Report) -> None:
    """Numbers the security design depends on. Each is a one-line edit away
    from being wrong, so pin the ranges here."""
    pkg = ROOT / "culprit"
    auth_src = (pkg / "auth.py").read_text(encoding="utf-8")
    db_src = (pkg / "db.py").read_text(encoding="utf-8")
    main_src = (pkg / "main.py").read_text(encoding="utf-8")
    cli_src = (pkg / "__main__.py").read_text(encoding="utf-8")
    bad = 0

    def num(pattern: str, text: str) -> float | None:
        m = re.search(pattern, text)
        return float(eval(m.group(1))) if m else None  # noqa: S307 -- our own source

    hours = num(r"SESSION_HOURS\s*=\s*([\d\s*+]+)", auth_src)
    if hours is None or hours > 24 * 30:
        bad += 1
        rep.add("WARN", "constants", "culprit/auth.py",
                f"SESSION_HOURS={hours}: sessions longer than 30 days")
    attempts = num(r"_MAX_ATTEMPTS\s*=\s*(\d+)", auth_src)
    window = num(r"_WINDOW_S\s*=\s*([\d.]+)", auth_src)
    if attempts is None or attempts > 20 or window is None or window < 60:
        bad += 1
        rep.add("HIGH", "constants", "culprit/auth.py",
                f"login limiter {attempts} attempts / {window}s is too loose")
    n_log2 = num(r"hashlib\.scrypt\([\s\S]*?n=2\s*\*\*\s*(\d+)", db_src)
    if n_log2 is None or n_log2 < 14:
        bad += 1
        rep.add("HIGH", "constants", "culprit/db.py",
                f"scrypt cost n=2**{n_log2}: below the 2**14 floor")
    secret_bytes = num(r"token_urlsafe\((\d+)\)", db_src)
    if secret_bytes is None or secret_bytes < 32:
        bad += 1
        rep.add("HIGH", "constants", "culprit/db.py",
                f"agent secrets are token_urlsafe({secret_bytes}): under 32 bytes")
    salt_bytes = num(r"token_bytes\((\d+)\)", db_src)
    if salt_bytes is None or salt_bytes < 16:
        bad += 1
        rep.add("HIGH", "constants", "culprit/db.py", f"password salt {salt_bytes} bytes")
    if "session_secret" in db_src and not re.search(r"token_bytes\(32\)", db_src):
        rep.add("WARN", "constants", "culprit/db.py", "session secret is not 32 bytes")
    for label, text in (("API", main_src), ("CLI", cli_src)):
        if not re.search(r"len\((new_)?password\)\s*<\s*8", text):
            bad += 1
            rep.add("HIGH", "constants", label,
                    "no minimum password length check (expected >= 8)")
    if not re.search(r"hmac\.compare_digest", auth_src):
        bad += 1
        rep.add("HIGH", "constants", "culprit/auth.py", "session compare is not constant-time")
    try:
        from culprit import config as config_module
        cfg = config_module.Config()
        if cfg.host not in ("127.0.0.1", "localhost", "::1"):
            bad += 1
            rep.add("HIGH", "constants", "culprit/config.py",
                    f"default bind host is {cfg.host!r}, not loopback")
        if "db_path" in config_module.EDITABLE or "host" in config_module.EDITABLE:
            bad += 1
            rep.add("HIGH", "constants", "culprit/config.py",
                    "db_path/host became web-editable")
    except Exception as exc:  # noqa: BLE001
        rep.add("WARN", "constants", "culprit/config.py", f"cannot import config: {exc}")
    if not bad:
        rep.ok("constants", f"sessions {hours/24:.0f}d, limiter {attempts:.0f}/"
               f"{window:.0f}s, scrypt 2**{n_log2:.0f}, {secret_bytes:.0f}-byte agent "
               "secrets, 8-char passwords, loopback default, locked config fields")


def audit_deployment(rep: Report) -> None:
    """The unit file, the container, the dependency pins -- how it runs."""
    unit = ROOT / "culprit.service"
    if unit.exists():
        text = unit.read_text(encoding="utf-8")
        missing = [d for d in ("NoNewPrivileges=", "PrivateTmp=", "ProtectSystem=",
                               "ProtectKernelTunables=", "RestrictSUIDSGID=")
                   if d not in text]
        if missing:
            rep.add("WARN", "systemd", "culprit.service",
                    f"no sandboxing directives: {', '.join(d.rstrip('=') for d in missing)}"
                    " (the host needs no privilege; these cost nothing)")
        else:
            rep.ok("systemd", "unit carries sandboxing directives")
        if re.search(r"CULPRIT_HOST\s*=\s*0\.0\.0\.0", text):
            rep.add("HIGH", "systemd", "culprit.service", "unit binds 0.0.0.0")
    req = ROOT / "requirements.txt"
    if req.exists():
        loose = []
        for line in req.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            if "==" not in line and "<" not in line:
                loose.append(line.split(">=")[0].split("[")[0])
        if loose:
            rep.add("INFO", "dependencies", "requirements.txt",
                    f"no upper bound on {loose}: a fresh install can pull a major "
                    "version this was never run against")
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8") if \
        (ROOT / ".gitignore").exists() else ""
    for pattern in ("*.pem", "*.key"):
        if pattern not in gitignore:
            rep.add("WARN", "gitignore", ".gitignore",
                    f"{pattern} not ignored -- a TLS key next to the checkout gets committed")
    # The two security tools must agree on what is public.
    sibling = ROOT / "tools" / "check_security.py"
    if sibling.exists():
        spec = importlib.util.spec_from_file_location("check_security", sibling)
        if spec and spec.loader:
            mod = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = mod  # dataclasses need the module registered
            try:
                spec.loader.exec_module(mod)
                same = (set(mod.EXPECTED_PUBLIC_PATHS) == EXPECTED_PUBLIC_PATHS
                        and set(mod.EXPECTED_AGENT_PATHS) == EXPECTED_AGENT_PATHS
                        and tuple(mod.EXPECTED_PUBLIC_PREFIXES) == EXPECTED_PUBLIC_PREFIXES)
                if same:
                    rep.ok("tools-agree", "check_security.py and this audit expect the "
                           "same public paths")
                else:
                    rep.add("HIGH", "tools-agree", "tools/",
                            "check_security.py and audit_security.py disagree on the "
                            "public path allowlist")
            except Exception as exc:  # noqa: BLE001
                rep.add("WARN", "tools-agree", "tools/check_security.py", f"cannot load: {exc}")


# ---------------------------------------------------------------- routes
def audit_routes(rep: Report) -> None:
    try:
        from culprit import auth as auth_module
        from culprit.main import app
    except Exception as exc:  # noqa: BLE001
        rep.add("HIGH", "routes", "culprit/main.py", f"cannot import app: {exc}")
        return
    drift = (set(auth_module.PUBLIC_PATHS) ^ EXPECTED_PUBLIC_PATHS) | \
            (set(auth_module.AGENT_PATHS) ^ EXPECTED_AGENT_PATHS) | \
            (set(auth_module.PUBLIC_PREFIXES) ^ set(EXPECTED_PUBLIC_PREFIXES))
    if drift:
        rep.add("HIGH", "public-allowlist", "culprit/auth.py",
                f"open paths changed: {sorted(drift)} -- confirm, then update "
                "EXPECTED_* in tools/audit_security.py and check_security.py")
    else:
        rep.ok("public-allowlist", "auth.py opens exactly the expected paths")
    # Every route is either API (401 on miss) or a known page.
    data_words = re.compile(r"\b(store\.(snapshot|get|live_series)\(|registry\.|"
                            r"history\.(list|series|top|processes|events|findings|"
                            r"stats)|sampler\.)")
    for route in app.routes:
        path = getattr(route, "path", None)
        if not path:
            continue
        if not path.startswith("/api/") and path not in EXPECTED_PAGE_ROUTES:
            rep.add("WARN", "routes", path,
                    "route outside /api/: gated by redirect, not 401 -- intended?")
        endpoint = getattr(route, "endpoint", None)
        if path in EXPECTED_PUBLIC_PATHS and endpoint is not None:
            try:
                body = inspect.getsource(endpoint)
            except (OSError, TypeError):
                continue
            if data_words.search(body):
                rep.add("HIGH", "public-handler", path,
                        "a public handler touches the data store / registry / "
                        "history -- data reachable without a session")
    rep.ok("routes", f"{sum(1 for r in app.routes if getattr(r, 'path', None))} "
           "routes: public handlers touch no data")
    # The startup invariant must still be wired.
    main_src = (ROOT / "culprit" / "__main__.py").read_text(encoding="utf-8")
    if "refuse_exposed_without_users" not in main_src:
        rep.add("HIGH", "startup", "culprit/__main__.py",
                "refuse_exposed_without_users is no longer called before bind")
    if "ensure_default_user" in main_src:
        rep.add("INFO", "startup", "culprit/__main__.py",
                "a default admin/admin is created when no user exists; the "
                "live scanner's default-credentials check is what catches an "
                "exposed host still using it")


# ------------------------------------------------------------- repo & files
def audit_repo(rep: Report) -> None:
    try:
        tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, check=True,
                                 capture_output=True, text=True).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        rep.add("INFO", "repo", "", "not a git checkout; skipping tracked-file checks")
        tracked = []
    bad = 0
    for name in tracked:
        base = Path(name).name
        if base in ("config.json", "agent.json", ".env") or \
                base.endswith((".db", ".sqlite", ".db-wal", ".pem", ".key")):
            bad += 1
            rep.add("HIGH", "tracked-secret", name, "runtime/credential file is tracked")
    token_re = re.compile(r"(token|secret|password)[\"']?\s*[:=]\s*[\"']([A-Za-z0-9_\-]{24,})[\"']", re.I)
    for name in tracked:
        path = ROOT / name
        if path.suffix not in (".py", ".sh", ".md", ".json", ".yml", ".yaml",
                               ".service", ".txt", ".js", ".html") or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for m in token_re.finditer(text):
            bad += 1
            lineno = text.count("\n", 0, m.start()) + 1
            rep.add("HIGH", "hardcoded-secret", f"{name}:{lineno}",
                    f"{m.group(1)} literal {m.group(2)[:6]}...")
    if not bad:
        rep.ok("repo", f"{len(tracked)} tracked files: no credentials, no runtime state")

    # Modes on the files that hold hashes and tokens.
    candidates = [ROOT / "agent.json"]
    if (ROOT / "data").exists():
        candidates += sorted((ROOT / "data").glob("*.db*"))
    for candidate in candidates:
        if not candidate.exists():
            continue
        mode = stat.S_IMODE(candidate.stat().st_mode)
        if mode & 0o077:
            rep.add("HIGH", "file-mode", rel(candidate),
                    f"mode {mode:o}: readable by other users (expected 600)")
        else:
            rep.ok("file-mode", f"{rel(candidate)} is {mode:o}")
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8") if \
        (ROOT / ".gitignore").exists() else ""
    for pattern in ("config.json", "agent.json", "data/"):
        if pattern not in gitignore:
            rep.add("WARN", "gitignore", ".gitignore", f"{pattern} not ignored")

    dockerfile = ROOT / "Dockerfile"
    if dockerfile.exists():
        text = dockerfile.read_text(encoding="utf-8")
        if not re.search(r"^\s*USER\s+", text, re.M):
            rep.add("WARN", "docker", "Dockerfile",
                    "no USER: the host container runs as root; it needs no "
                    "privilege (it only aggregates), so add a non-root user")
    # Dependency advisories, if pip-audit happens to be installed.
    try:
        # In a scratch cwd: pip-audit builds a throwaway environment to
        # resolve the requirements and must not leave it in the checkout.
        import tempfile
        with tempfile.TemporaryDirectory(prefix="culprit-audit-") as scratch:
            out = subprocess.run([sys.executable, "-m", "pip_audit", "-r",
                                  str(ROOT / "requirements.txt"), "--progress-spinner",
                                  "off"], capture_output=True, text=True, timeout=300,
                                 cwd=scratch)
        if out.returncode == 0:
            rep.ok("dependencies", "pip-audit: no known vulnerabilities")
        elif "No module named" in out.stderr:
            raise OSError("pip-audit not installed")
        else:
            rep.add("WARN", "dependencies", "requirements.txt",
                    out.stdout.strip().splitlines()[-1] if out.stdout.strip() else out.stderr.strip()[-200:])
    except (OSError, subprocess.TimeoutExpired):
        rep.add("INFO", "dependencies", "",
                "pip-audit not installed; `pip install pip-audit && pip-audit "
                "-r requirements.txt` to check advisories")


SECTIONS = {
    "frontend": ("Frontend (HTML sinks, links, fetches, login form)", audit_frontend),
    "python": ("Python", audit_python),
    "constants": ("Security constants", audit_constants),
    "routes": ("Routes and gate", audit_routes),
    "repo": ("Repository and files", audit_repo),
    "deployment": ("Deployment (unit, container, pins, tool agreement)", audit_deployment),
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--strict", action="store_true", help="exit 1 on WARN too")
    parser.add_argument("--only", default="",
                        help="comma-separated sections: " + ", ".join(SECTIONS))
    parser.add_argument("--skip", default="", help="comma-separated sections to skip")
    parser.add_argument("--quiet", action="store_true", help="print only WARN/HIGH")
    parser.add_argument("--json", metavar="PATH", help="write findings to a JSON file")
    args = parser.parse_args()
    only = {x for x in args.only.split(",") if x}
    skip = {x for x in args.skip.split(",") if x}
    unknown = (only | skip) - set(SECTIONS)
    if unknown:
        print(f"{RED}unknown section(s) {sorted(unknown)}; choose from "
              f"{', '.join(SECTIONS)}{RESET}")
        return 2
    rep = Report(quiet=args.quiet)
    print(f"{BOLD}culprit static security audit{RESET} -> {ROOT}")
    for key, (title, fn) in SECTIONS.items():
        if (only and key not in only) or key in skip:
            continue
        section(title)
        fn(rep)
    counts = {lvl: sum(1 for f in rep.findings if f.level == lvl)
              for lvl in ("HIGH", "WARN", "INFO", "PASS")}
    print(f"\n{BOLD}summary{RESET}  " + "  ".join(f"{k} {v}" for k, v in counts.items()))
    failing = counts["HIGH"] > 0 or (args.strict and counts["WARN"] > 0)
    result = "FAIL" if failing else "OK"
    print(f"{RED if failing else GREEN}{result}{RESET}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"root": str(ROOT), "result": result, "counts": counts,
                       "findings": [f.__dict__ for f in rep.findings]}, fh, indent=2)
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
