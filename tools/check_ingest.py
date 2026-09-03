"""Can a bad, buggy or compromised agent get past the token check, or use a
valid token to corrupt or break the host?

The agent report endpoint is the one door open to the network without a
session, and everything behind it is trusted enough to be shown on the
dashboard, folded into history and fed to every browser over SSE. So this
tool asks two questions the other scanners only touch:

1. **Token bypass.** Every shape a forged, borrowed, mangled or misplaced
   credential can take -- header spellings, the token in the wrong place, a
   real node name with a guessed secret, the stored hash used as the secret,
   whitespace and case tricks, other HTTP methods, the session cookie in
   place of a token -- must be a 401. Nothing else.

2. **Ingest poisoning.** With a *valid* token, every malformed payload a
   hostile agent could send -- sections of the wrong type, NaN/Infinity that
   JSON.parse rejects in the browser, absurd numbers that overflow the
   rollup, deep nesting, huge strings, garbage command results, intervals
   that would make a dashboard request wait forever, unbounded growth from
   made-up section names -- must be rejected or absorbed. After each one the
   endpoints every viewer depends on (`/api/nodes`, `/api/fleet`, the node's
   snapshot, the SSE stream's first frame) must still answer 200 with
   *strict* JSON, and the host must still be healthy. A 5xx on the ingest is
   HIGH (the agent hurt itself); a 5xx or invalid JSON on a read endpoint is
   CRIT (one agent broke the dashboard for everyone).

It also re-runs the two-agent isolation check from check_security.py: a
node must not be able to write another node's snapshot or answer another
node's pending command.

    .venv/bin/python tools/check_ingest.py                          # bypass matrix only
    .venv/bin/python tools/check_ingest.py --throwaway-user         # + enrol a throwaway agent, fuzz it
    .venv/bin/python tools/check_ingest.py --user u --password p    # same, with an existing login
    .venv/bin/python tools/check_ingest.py --token <name.secret> --node <name>   # fuzz an existing agent
                                                                    # (its dashboard view is polluted until
                                                                    # its next full report)

Needs a running host. The throwaway agent (and user) are removed at the end.
Exit 1 on CRIT/HIGH (`--strict` promotes WARN).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import secrets
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from check_security import (BOLD, DIM, GREEN, RED, RESET, Ctx, Http, Report,  # noqa: E402
                            Resp, check_agent_isolation, create_throwaway_user,
                            install_leak_observer, login, remove_throwaway_user,
                            safe_req, section)

REPORT = "/api/agents/report"
JSON_CT = {"Content-Type": "application/json"}


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite number {name} in JSON")


def strict_json(text: str) -> Any:
    """json.loads that refuses NaN/Infinity -- what a browser's JSON.parse
    does, so anything Python would happily emit and the browser would choke
    on shows up here."""
    return json.loads(text, parse_constant=_reject_constant)


def dumps_lenient(payload: Any) -> bytes:
    return json.dumps(payload, allow_nan=True).encode()


# --------------------------------------------------------------- bypasses
def check_token_bypass(ctx: Ctx, known: list[str], real_token: str | None) -> None:
    """Every credential shape except the exact right one must be a 401."""
    rep = ctx.report
    body = dumps_lenient({"agent": {"report_interval": 1}, "snapshot": {}})
    rand = secrets.token_urlsafe(32)
    name = known[0] if known else "sectest-nope"
    cases: list[tuple[str, dict[str, str], str, str]] = []  # label, headers, method, target

    def case(label: str, headers: dict[str, str], method: str = "POST",
             target: str = REPORT) -> None:
        cases.append((label, headers, method, target))

    for scheme in ("bearer", "BEARER", "Bearer:", "Token", "Bearer Bearer", "OAuth",
                   "Bearer\t", "Bearer  "):
        case(f"scheme {scheme!r}", {"Authorization": f"{scheme} {name}.{rand}"})
    case("no space after Bearer", {"Authorization": f"Bearer{name}.{rand}"})
    case("two tokens", {"Authorization": f"Bearer {name}.{rand}, Bearer {name}.{rand}"})
    case("name only", {"Authorization": f"Bearer {name}"})
    case("name with trailing dot", {"Authorization": f"Bearer {name}."})
    case("dot then secret", {"Authorization": f"Bearer .{rand}"})
    case("double dot", {"Authorization": f"Bearer {name}..{rand}"})
    case("secret then name", {"Authorization": f"Bearer {rand}.{name}"})
    case("extra segment", {"Authorization": f"Bearer {name}.{rand}.{rand}"})
    case("name uppercased", {"Authorization": f"Bearer {name.upper()}.{rand}"})
    case("name with NUL", {"Authorization": f"Bearer {name}%00.{rand}"})
    case("name with SQL", {"Authorization": f"Bearer {name}' OR 1=1--.{rand}"})
    case("name with wildcard", {"Authorization": f"Bearer %.{rand}"})
    case("name with unicode dot", {"Authorization": f"Bearer {name}․{rand}"})
    for guess in ("", " ", "null", "None", "undefined", "*", "%", "_", "0", "true",
                  "secret", "password", "changeme", "token", name, name * 2):
        case(f"guessed secret {guess!r}", {"Authorization": f"Bearer {name}.{guess}"})
    for digest in (hashlib.sha256(rand.encode()).hexdigest(),
                   hashlib.sha256(name.encode()).hexdigest(),
                   hashlib.sha256(b"").hexdigest()):
        case("sha256 hex used as the secret", {"Authorization": f"Bearer {name}.{digest}"})
    case("base64 of a token", {"Authorization": "Bearer " + base64.b64encode(
        f"{name}.{rand}".encode()).decode()})
    case("Basic name:secret", {"Authorization": "Basic " + base64.b64encode(
        f"{name}:{rand}".encode()).decode()})
    case("Basic name:name", {"Authorization": "Basic " + base64.b64encode(
        f"{name}:{name}".encode()).decode()})
    case("Digest", {"Authorization": f'Digest username="{name}", response="{rand}"'})
    for header in ("X-Api-Key", "X-Auth-Token", "X-Token", "X-Agent-Token", "Token",
                   "Proxy-Authorization", "X-Authorization", "Api-Key", "Agent"):
        case(f"token in {header}", {header: f"{name}.{rand}"})
        case(f"bearer in {header}", {header: f"Bearer {name}.{rand}"})
    case("token as cookie", {"Cookie": f"culprit_session={name}.{rand}"})
    case("token as agent cookie", {"Cookie": f"token={name}.{rand}"})
    case("token in query", {}, "POST", f"{REPORT}?token={name}.{rand}")
    case("authorization in query", {}, "POST", f"{REPORT}?authorization=Bearer%20{name}.{rand}")
    case("access_token in query", {}, "POST", f"{REPORT}?access_token={name}.{rand}")
    for method in ("GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"):
        case(f"{method} with a bad token", {"Authorization": f"Bearer {name}.{rand}"}, method)
    for target in (REPORT + "/", "/" + REPORT, REPORT + "?", REPORT + "#", REPORT + "%20",
                   "/api/agents/report/../report", "/api/agents/./report",
                   "/api/agents/report/../../agents/report", "/API/agents/report"):
        case(f"path {target}", {"Authorization": f"Bearer {name}.{rand}"}, "POST", target)
    if real_token:
        rname, _, rsecret = real_token.partition(".")
        for label, token in (
            ("name with leading space", f" {rname}.{rsecret}"),
            ("secret truncated by one", f"{rname}.{rsecret[:-1]}"),
            ("secret with one extra char", f"{rname}.{rsecret}x"),
            ("secret case-flipped", f"{rname}.{rsecret.swapcase()}"),
            ("secret reversed", f"{rname}.{rsecret[::-1]}"),
            ("secret with a middle char changed",
             f"{rname}.{rsecret[:10]}{'a' if rsecret[10] != 'a' else 'b'}{rsecret[11:]}"),
            ("name uppercased with the real secret", f"{rname.upper()}.{rsecret}"),
            ("name with trailing space", f"{rname} .{rsecret}"),
            ("real secret under another node's name", f"{name}.{rsecret}" if name != rname
             else f"other.{rsecret}"),
            ("real secret alone", rsecret),
            ("real token sha256", hashlib.sha256(real_token.encode()).hexdigest()),
            ("real token url-encoded", real_token.replace("-", "%2D").replace("_", "%5F")),
        ):
            case(label, {"Authorization": f"Bearer {token}"})

    bad = 0
    for label, headers, method, target in cases:
        r = safe_req(ctx, method, target, body=body, headers={**JSON_CT, **headers},
                     max_read=65536)
        if r is None:
            continue
        if 200 <= r.status < 300:
            if label in ("name with leading space", "real token url-encoded") and real_token:
                # The real secret was still presented; the server merely
                # normalised whitespace. Worth knowing, not a bypass.
                rep.add("INFO", "token-bypass", f"{label}: accepted (whitespace normalised)")
                continue
            bad += 1
            rep.add("CRIT", "token-bypass", f"{label}: {method} {target} -> {r.status} "
                    f"({r.text[:80]!r})")
        elif r.status >= 500:
            bad += 1
            rep.add("HIGH", "token-bypass", f"{label}: {method} {target} -> {r.status}")
    # Two Authorization headers on one request: neither must win if either is bad.
    if real_token:
        conn = ctx.http._conn()
        try:
            conn.putrequest("POST", REPORT, skip_accept_encoding=True)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Authorization", f"Bearer {name}.{rand}")
            conn.putheader("Authorization", f"Bearer {real_token}")
            conn.putheader("Content-Length", str(len(body)))
            conn.endheaders(body)
            raw = conn.getresponse()
            status = raw.status
            raw.read(4096)
        finally:
            conn.close()
        rep.add("INFO", "token-bypass",
                f"two Authorization headers (bad first, real second) -> {status} "
                f"({'the combined value is rejected' if status == 401 else 'one of them was honoured'})")
    # Timing: unknown name vs known name with a wrong secret.
    if known:
        def cost(auth: str) -> float:
            best = 1e9
            for _ in range(4):
                t0 = time.perf_counter()
                ctx.http.req("POST", REPORT, body=body, headers={**JSON_CT, "Authorization": auth})
                best = min(best, time.perf_counter() - t0)
            return best
        unknown = cost(f"Bearer nobody-{secrets.token_hex(3)}.{rand}")
        wrong = cost(f"Bearer {known[0]}.{rand}")
        ratio = max(unknown, wrong) / max(min(unknown, wrong), 1e-9)
        if ratio > 2.0 and abs(unknown - wrong) > 0.01:
            rep.add("WARN", "token-bypass", f"timing tells unknown ({unknown*1000:.1f}ms) from "
                    f"known-name ({wrong*1000:.1f}ms) agents")
    if not bad:
        rep.ok("token-bypass", f"{len(cases)} forged/misplaced/mangled credentials all "
               "refused; nothing 5xx'd")


# ---------------------------------------------------------------- poisoning
def readback(ctx: Ctx, node: str) -> list[str]:
    """What every viewer depends on, after a hostile report."""
    problems: list[str] = []
    r = safe_req(ctx, "GET", "/api/healthz", timeout=6.0)
    if r is None or r.status != 200:
        problems.append(f"/api/healthz -> {r.status if r else 'no answer'}")
    if not ctx.cookie:
        return problems
    for target in ("/api/nodes", "/api/fleet", f"/api/nodes/{node}/snapshot", "/api/snapshot"):
        # A node snapshot may legitimately approach the 8 MB report cap.
        r = safe_req(ctx, "GET", target, cookie=ctx.cookie, timeout=20.0, max_read=12_000_000)
        if r is None or r.status >= 500:
            problems.append(f"{target} -> {r.status if r else 'no answer'}")
            continue
        if r.status == 200:
            try:
                strict_json(r.text)
            except ValueError as exc:
                problems.append(f"{target}: body is not strict JSON ({exc})")
    r = safe_req(ctx, "GET", "/api/stream", cookie=ctx.cookie, max_read=12_000_000, timeout=8.0)
    if r is not None:
        frame = next((line[6:] for line in r.text.split("\n") if line.startswith("data: ")), None)
        if frame is None and r.status == 200:
            problems.append("/api/stream: no snapshot frame")
        elif frame is not None:
            try:
                strict_json(frame)
            except ValueError as exc:
                problems.append(f"/api/stream first frame is not strict JSON ({exc})")
    return problems


def check_poisoning(ctx: Ctx, node: str, token: str) -> None:
    rep = ctx.report
    hdr = {**JSON_CT, "Authorization": f"Bearer {token}"}

    def send(payload: bytes, extra: dict[str, str] | None = None) -> Resp | None:
        return safe_req(ctx, "POST", REPORT, body=payload,
                        headers={**hdr, **(extra or {})}, timeout=40.0)

    def snap(**sections: Any) -> bytes:
        return dumps_lenient({"agent": {"report_interval": 1}, "snapshot": sections})

    big_junk = {f"junk-{secrets.token_hex(4)}": {"x": i} for i in range(2000)}
    cases: list[tuple[str, bytes, dict[str, str] | None]] = [
        ("empty object", b"{}", None),
        ("agent and snapshot as strings", dumps_lenient({"agent": "x", "snapshot": "x"}), None),
        ("agent and snapshot as lists", dumps_lenient({"agent": [], "snapshot": []}), None),
        ("agent and snapshot null", dumps_lenient({"agent": None, "snapshot": None}), None),
        ("agent as number", dumps_lenient({"agent": 5, "snapshot": {}}), None),
        ("cpu as a string", snap(cpu="string"), None),
        ("every section the wrong type", snap(cpu=[1, 2], memory=5, disk=None, network=True,
                                               diagnosis="x", system=[], process_table="x",
                                               events="string", pressures=3.5, gpu=[[]],
                                               volumes="v", services=0), None),
        ("diagnosis fields wrong types", snap(diagnosis={"offenders": "x", "findings": 5,
                                                         "severity": {"a": 1}, "status": []}), None),
        ("offenders list of garbage", snap(diagnosis={"offenders": [None, "x", 5, [],
                                                                    {"name": {"nested": 1},
                                                                     "lag_score": "high"}]}), None),
        ("process_table fields wrong types", snap(process_table={"totals": "x", "processes": "x"}), None),
        ("processes list of garbage", snap(process_table={"processes": [None, 5, "x", [],
                                                                        {"pid": "abc", "name": None,
                                                                         "cpu": "hot"}]}), None),
        ("events sections wrong types", snap(events={"crashes": {"events": "string"},
                                                     "updates": "x", "policy": None}), None),
        ("events list of garbage", snap(events={"updates": {"events": [None, 5, "x", [],
                                                                       {"ts": "abc"},
                                                                       {"ts": None, "kind": [],
                                                                        "title": {"a": 1},
                                                                        "payload": "p"}]}}), None),
        ("event with absurd timestamps", snap(events={"crashes": {"events": [
            {"ts": 1e300, "kind": "crash", "title": "x"}, {"ts": -1, "kind": "crash", "title": "y"},
            {"ts": 10 ** 40, "kind": "crash", "title": "z"}]}}), None),
        ("event title with lone surrogate", snap(events={"crashes": {"events": [
            {"ts": time.time(), "kind": "crash", "title": "\udcff\ud800", "source_key": "\udcff"}]}}), None),
        ("NaN and Infinity in metrics", b'{"agent": {"report_interval": 1}, "snapshot": '
         b'{"cpu": {"total": NaN, "load_1": Infinity, "per_core": [NaN, -Infinity]}, '
         b'"memory": {"percent": NaN}}}', None),
        ("huge ints that overflow float", snap(memory={"total": 10 ** 400, "used": -(10 ** 400),
                                                       "percent": 10 ** 400},
                                               cpu={"total": 10 ** 400}), None),
        ("1e308 everywhere", snap(cpu={"total": 1e308, "load_1": 1e308},
                                  memory={"total": 1e308, "used": 1e308, "percent": 1e308},
                                  disk={"total": {"busy_percent": 1e308, "latency_ms": 1e308}}), None),
        ("negative everything", snap(cpu={"total": -1e6}, memory={"percent": -50, "total": -1}), None),
        ("2MB hostname", snap(system={"hostname": "h" * 2_000_000}), None),
        ("hostname with RTL override and control chars",
         snap(system={"hostname": "".join((chr(0x202E), "evil", chr(0), chr(7), chr(0x2028), "<script>"))}), None),
        ("50k-deep nesting inside a section",
         b'{"agent": {"report_interval": 1}, "snapshot": {"x": ' + b"[" * 50_000 + b"]" * 50_000 + b"}}", None),
        ("100k-deep raw brackets", b'{"snapshot": ' + b"[" * 100_000 + b"]" * 100_000 + b"}", None),
        ("100k-deep objects", b'{"snapshot": ' + b'{"a":' * 100_000 + b"1" + b"}" * 100_000 + b"}", None),
        ("2000 unknown sections (growth probe 1)", snap(**big_junk), None),
        ("2000 more unknown sections (growth probe 2)",
         snap(**{f"junk-{secrets.token_hex(4)}": {"x": i} for i in range(2000)}), None),
        ("weird section names", dumps_lenient({"snapshot": {"": 1, "__proto__": {"polluted": 1},
                                                            "constructor": {"prototype": 1},
                                                            "a\x00b": 1, "k" * 10_000: 1}}), None),
        ("report_interval zero", dumps_lenient({"agent": {"report_interval": 0}, "snapshot": {}}), None),
        ("report_interval negative", dumps_lenient({"agent": {"report_interval": -5}, "snapshot": {}}), None),
        ("report_interval string", dumps_lenient({"agent": {"report_interval": "soon"}, "snapshot": {}}), None),
        ("report_interval 1e300", dumps_lenient({"agent": {"report_interval": 1e300}, "snapshot": {}}), None),
        ("report_interval NaN", b'{"agent": {"report_interval": NaN}, "snapshot": {}}', None),
        ("interval_fast garbage", dumps_lenient({"agent": {"interval_fast": [1]}, "snapshot": {}}), None),
        ("version 1MB", dumps_lenient({"agent": {"version": "v" * 1_000_000}, "snapshot": {}}), None),
        ("version non-string", dumps_lenient({"agent": {"version": {"a": [1]}}, "snapshot": {}}), None),
        ("command_results string", dumps_lenient({"snapshot": {}, "command_results": "x"}), None),
        ("command_results garbage", dumps_lenient({"snapshot": {}, "command_results": [
            None, 5, "x", [], {"id": None}, {"id": {"a": 1}}, {"id": "other:1", "ok": True},
            {"id": f"{node}:999999", "ok": True, "result": "spoof"}]}), None),
        ("plain text content-type", snap(system={"hostname": "sectest"}), {"Content-Type": "text/plain"}),
        ("multipart content-type", snap(system={"hostname": "sectest"}),
         {"Content-Type": "multipart/form-data; boundary=x"}),
        ("gzip header on a plain body", snap(system={"hostname": "sectest"}), {"Content-Encoding": "gzip"}),
        ("br encoding", snap(system={"hostname": "sectest"}), {"Content-Encoding": "br"}),
        ("BOM prefix", b"\xef\xbb\xbf" + snap(system={"hostname": "sectest"}), None),
        ("invalid UTF-8 in body", b'{"snapshot": {"system": {"hostname": "\xff\xfe"}}}', None),
        ("4000 processes", snap(process_table={"processes": [
            {"pid": i, "name": f"p{i}", "cpu": i % 100, "working_set": i * 1000, "lag_score": i % 7}
            for i in range(4000)], "totals": {"count": 4000}}), None),
        ("5MB single report", snap(system={"hostname": "sectest", "blob": "b" * 5_000_000}), None),
    ]
    ingest_bad = 0
    read_bad = 0
    growth: list[int] = []
    for label, payload, extra in cases:
        r = send(payload, extra)
        status = r.status if r else None
        if status is not None and status >= 500:
            ingest_bad += 1
            rep.add("HIGH", "ingest", f"{label}: report -> {status} (the ingest itself "
                    "raised; anything it half-applied stays)")
        elif status is not None and 200 <= status < 300 and label.startswith("NaN"):
            rep.add("WARN", "ingest", f"{label}: accepted (200) -- NaN is not JSON; the "
                    "read-back below shows whether it reached the browser")
        problems = readback(ctx, node)
        if problems:
            read_bad += 1
            rep.add("CRIT", "ingest", f"after {label!r}: " + "; ".join(problems))
        if "growth probe" in label and ctx.cookie:
            r2 = safe_req(ctx, "GET", f"/api/nodes/{node}/snapshot", cookie=ctx.cookie, timeout=20.0)
            growth.append(len(r2.body) if r2 else 0)
    if len(growth) == 2 and growth[1] > growth[0] * 1.5 and growth[1] > 100_000:
        rep.add("WARN", "ingest", f"unknown section names are retained: the node snapshot "
                f"grew {growth[0]//1024}KB -> {growth[1]//1024}KB across two reports of "
                "made-up keys (a hostile agent can grow host memory without bound)")
    # A dashboard request that must not hang because of what the agent said.
    if ctx.cookie:
        send(dumps_lenient({"agent": {"report_interval": 1e300}, "snapshot": {}}))
        t0 = time.perf_counter()
        r = safe_req(ctx, "GET", f"/api/nodes/{node}/processes/1", cookie=ctx.cookie, timeout=60.0)
        took = time.perf_counter() - t0
        if r is None:
            read_bad += 1
            rep.add("HIGH", "ingest", f"a process-detail request hung for {took:.0f}s after the "
                    "agent reported report_interval=1e300 (the wait is sized from the "
                    "agent's own claim)")
        elif r.status != 504:
            rep.add("WARN", "ingest", f"process-detail for a silent agent -> {r.status} "
                    f"after {took:.0f}s (expected 504)")
        else:
            rep.add("INFO", "ingest", f"process-detail for a silent agent gave up after "
                    f"{took:.0f}s (capped regardless of the agent's claimed cadence)")
    # Restore a sane snapshot and confirm the node is coherent again.
    r = send(snap(system={"hostname": "sectest-clean"}, cpu={"total": 1.0},
                  memory={"percent": 10.0}, diagnosis={"status": "ok", "severity": "ok"}))
    if ctx.cookie:
        fleet = (safe_req(ctx, "GET", "/api/fleet", cookie=ctx.cookie, timeout=20.0) or Resp(0, {}, b"")).json() or {}
        mine = next((n for n in fleet.get("nodes", []) if isinstance(n, dict) and n.get("name") == node), None)
        if not mine:
            read_bad += 1
            rep.add("HIGH", "ingest", "the node vanished from /api/fleet after the fuzz")
    if not ingest_bad and not read_bad:
        rep.ok("ingest", f"{len(cases)} hostile reports: nothing 5xx'd, every viewer endpoint "
               "and the SSE frame stayed strict JSON, no hang, node coherent afterwards")


# --------------------------------------------------------------------- main
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter,
                                     epilog=__doc__)
    parser.add_argument("--url", default=None)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--user")
    parser.add_argument("--password")
    parser.add_argument("--throwaway-user", action="store_true",
                        help="create a temporary dashboard user via the CLI (same machine)")
    parser.add_argument("--token", help="an existing agent token to fuzz with")
    parser.add_argument("--node", help="the agent name that --token belongs to")
    parser.add_argument("--skip-fuzz", action="store_true", help="only the bypass matrix")
    parser.add_argument("--skip-isolation", action="store_true",
                        help="skip the two-agent isolation re-run")
    parser.add_argument("--insecure", action="store_true")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--json", metavar="PATH")
    args = parser.parse_args()
    args.active = True          # check_agent_isolation reads it
    args.concurrency = 0
    url = args.url or f"http://127.0.0.1:{args.port}"
    if bool(args.token) != bool(args.node):
        print(f"{RED}--token and --node go together{RESET}")
        return 2

    ctx = Ctx(Http(url, args.insecure, timeout=args.timeout), Report(quiet=args.quiet), args)
    install_leak_observer(ctx)
    print(f"{BOLD}culprit ingest / token-bypass check{RESET} -> {url}")
    try:
        ctx.http.req("GET", "/api/healthz", timeout=4.0)
    except OSError as exc:
        print(f"{RED}cannot reach {url}: {exc}{RESET}")
        return 2
    enabled = bool((ctx.http.req("GET", "/api/auth").json() or {}).get("enabled"))

    section("Session")
    if args.throwaway_user and enabled:
        ctx.throwaway = create_throwaway_user(ctx)
        if ctx.throwaway:
            args.user, args.password = ctx.throwaway
    if args.user and args.password:
        r = login(ctx, args.user, args.password, count=False)
        m = __import__("re").search(r"culprit_session=([^;]+)", r.header("set-cookie") or "")
        ctx.cookie = m.group(1) if m else None
        if not ctx.cookie:
            ctx.report.add("WARN", "session", f"login as {args.user!r} failed ({r.status})")
    if ctx.cookie:
        nodes = ctx.http.req("GET", "/api/nodes", cookie=ctx.cookie).json() or {}
        ctx.agent_names = [n["name"] for n in nodes.get("nodes", [])
                           if isinstance(n, dict) and n.get("name")]
        ctx.report.add("INFO", "session", f"signed in; {len(ctx.agent_names)} enrolled agents known")
    else:
        print(f"  {DIM}no session: bypass matrix runs without real node names; fuzzing "
              f"needs --token/--node or a login{RESET}")

    token = args.token
    node = args.node
    throwaway_agent = None
    try:
        if not token and ctx.cookie and not args.skip_fuzz:
            throwaway_agent = f"sectest-in-{secrets.token_hex(2)}"
            r = ctx.http.req("POST", "/api/agents", json_body={"name": throwaway_agent},
                             cookie=ctx.cookie)
            token = (r.json() or {}).get("token")
            node = throwaway_agent
            if token:
                ctx.report.add("INFO", "session", f"enrolled throwaway agent {node!r}")
            else:
                ctx.report.add("WARN", "session", f"could not enrol a throwaway agent ({r.status})")
        known = list(ctx.agent_names)
        if node and node not in known:
            known.insert(0, node)

        section("Token bypass")
        check_token_bypass(ctx, known, token)

        if token and node and not args.skip_fuzz:
            section("Ingest poisoning")
            check_poisoning(ctx, node, token)
        if ctx.cookie and not args.skip_isolation:
            section("Cross-agent isolation")
            check_agent_isolation(ctx)
    finally:
        if throwaway_agent and ctx.cookie:
            ctx.http.req("DELETE", f"/api/agents/{throwaway_agent}", cookie=ctx.cookie)
        if ctx.throwaway:
            remove_throwaway_user(ctx.throwaway[0])

    rep = ctx.report
    counts = {lvl: sum(1 for f in rep.findings if f.level == lvl)
              for lvl in ("CRIT", "HIGH", "WARN", "INFO", "PASS")}
    print(f"\n{BOLD}summary{RESET}  " + "  ".join(f"{k} {v}" for k, v in counts.items()))
    worst = rep.worst()
    failing = worst in ("CRIT", "HIGH") or (args.strict and worst == "WARN")
    result = "FAIL" if failing else "OK"
    print(f"{RED if failing else GREEN}{result}{RESET}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"url": url, "result": result, "counts": counts,
                       "findings": [f.__dict__ for f in rep.findings]}, fh, indent=2)
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
