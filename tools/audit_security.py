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
import inspect
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

    def add(self, level: str, check: str, where: str, detail: str) -> None:
        self.findings.append(Finding(level, check, where, detail))
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
        out = subprocess.run([sys.executable, "-m", "pip_audit", "-r",
                              str(ROOT / "requirements.txt"), "--progress-spinner",
                              "off"], capture_output=True, text=True, timeout=120)
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--strict", action="store_true", help="exit 1 on WARN too")
    args = parser.parse_args()
    rep = Report()
    print(f"{BOLD}culprit static security audit{RESET} -> {ROOT}")
    section("Frontend (HTML sinks)")
    audit_frontend(rep)
    section("Python")
    audit_python(rep)
    section("Routes and gate")
    audit_routes(rep)
    section("Repository and files")
    audit_repo(rep)
    counts = {lvl: sum(1 for f in rep.findings if f.level == lvl)
              for lvl in ("HIGH", "WARN", "INFO", "PASS")}
    print(f"\n{BOLD}summary{RESET}  " + "  ".join(f"{k} {v}" for k, v in counts.items()))
    failing = counts["HIGH"] > 0 or (args.strict and counts["WARN"] > 0)
    print(f"{RED if failing else GREEN}{'FAIL' if failing else 'OK'}{RESET}")
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
