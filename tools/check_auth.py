"""Offline tests of the credential logic -- no server, no network, no real DB.

The project has no unit-test suite because what usually breaks is
environmental and only the real machine reveals it. Authentication is the
exception: it is pure logic (hashing, HMAC, a rate limiter, a token table) and
the failure mode is silent -- a session that verifies when it should not, a
revoked token that still works. Those are exactly what a deterministic test
catches, so this runs the real `db.py` / `auth.py` / `nodes.py` / `main.py`
functions against a throwaway SQLite file in a temp directory and asserts
every property the security design promises:

* passwords: scrypt with a fresh salt, wrong/unknown reject, timing parity
* sessions: signature covers user and expiry; tamper, expiry, swap all fail;
  a password change (or removal, or rename) revokes existing cookies
* login limiter: locks the address after 8 failures even for the right
  password, other addresses unaffected, success clears the count
* agent tokens: shape, revoke, rotate, delete, malformed inputs
* command results: an agent can only resolve its own node's commands
* report inflation: a gzip bomb is refused at the ceiling, in bounded time
* startup safety: default user creation and the exposed-without-users refusal
* config patches: locked fields and out-of-range values are rejected
* the gate: which paths are open, session-gated, or agent-gated
* network trust: forwarding headers are refused from an undeclared peer and
  honoured (right-most untrusted hop) from a declared proxy; the Host
  allow-list, wildcards, loopback always; list entries are validated

    .venv/bin/python tools/check_auth.py           # ~2 s, exit 1 on any failure
    .venv/bin/python tools/check_auth.py -v        # print every assertion
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hmac
import logging
import os
import stat
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

GREEN, RED, YELLOW, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[1m", "\033[0m",
)


class Runner:
    def __init__(self, verbose: bool) -> None:
        self.verbose = verbose
        self.passed = 0
        self.failed: list[str] = []
        self.group = ""

    def section(self, title: str) -> None:
        self.group = title
        print(f"\n{BOLD}{title}{RESET}")

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        if ok:
            self.passed += 1
            if self.verbose:
                print(f"  {GREEN}ok{RESET}   {name}")
        else:
            self.failed.append(f"{self.group}: {name}")
            print(f"  {RED}FAIL{RESET} {name}" + (f" -- {detail}" if detail else ""))
        return ok

    def summary(self, group: str, detail: str) -> None:
        if not any(f.startswith(group + ":") for f in self.failed):
            print(f"  {GREEN}pass{RESET} {detail}")


# ---------------------------------------------------------------- fixtures
def fresh_history(tmp: Path, name: str = "t.db"):  # type: ignore[no-untyped-def]
    from culprit.db import History
    return History(tmp / name, enabled=True)


def test_passwords(r: Runner, tmp: Path) -> None:
    from culprit.db import hash_password, verify_password
    r.section("passwords")
    h1, h2 = hash_password("hunter22"), hash_password("hunter22")
    r.check("hash is scrypt$salt$digest", h1.startswith("scrypt$") and h1.count("$") == 2)
    r.check("same password, different salts", h1 != h2)
    r.check("verify accepts the right password", verify_password("hunter22", h1))
    r.check("verify rejects a wrong password", not verify_password("hunter23", h1))
    r.check("verify rejects a malformed stored value", not verify_password("x", "nonsense"))
    r.check("verify rejects a foreign scheme", not verify_password("x", "md5$aa$bb"))

    history = fresh_history(tmp, "pw.db")
    history.add_user("olai", "correct horse")
    r.check("user_count counts", history.user_count() == 1)
    r.check("verify_user right", history.verify_user("olai", "correct horse"))
    r.check("verify_user wrong", not history.verify_user("olai", "wrong"))
    r.check("verify_user unknown", not history.verify_user("nobody", "correct horse"))
    r.check("user_exists", history.user_exists("olai") and not history.user_exists("x"))
    r.check("password_hash returns the stored hash",
            (history.password_hash("olai") or "").startswith("scrypt$"))
    r.check("password_hash None for unknown", history.password_hash("x") is None)
    r.check("list_users omits hashes",
            all("password_hash" not in u for u in history.list_users()))
    mode = stat.S_IMODE((tmp / "pw.db").stat().st_mode)
    r.check("database chmod 600", mode == 0o600, f"mode {mode:o}")

    # Timing parity: unknown user vs wrong password must cost the same.
    def cost(fn) -> float:  # type: ignore[no-untyped-def]
        best = 1e9
        for _ in range(5):
            t0 = time.perf_counter()
            fn()
            best = min(best, time.perf_counter() - t0)
        return best
    unknown = cost(lambda: history.verify_user("nobody", "wrong"))
    known = cost(lambda: history.verify_user("olai", "wrong"))
    ratio = max(unknown, known) / max(min(unknown, known), 1e-9)
    r.check("unknown-user and wrong-password cost the same (one scrypt each)",
            ratio < 1.5, f"unknown {unknown*1000:.1f}ms vs known {known*1000:.1f}ms")
    history.close()
    r.summary("passwords", "scrypt hashing, verification and timing parity")


def test_sessions(r: Runner, tmp: Path) -> None:
    from culprit.auth import Auth
    r.section("sessions")
    history = fresh_history(tmp, "sess.db")
    history.add_user("olai", "correct horse")
    auth = Auth(history)
    cookie = auth.issue_session("olai")
    r.check("issue -> verify round trip", auth.verify_session(cookie) == "olai")
    user, expiry, sig = cookie.rsplit(":", 2)
    r.check("expiry about seven days out",
            6.9 * 86400 < int(expiry) - time.time() < 7.1 * 86400)
    r.check("signature is 64 hex chars", len(sig) == 64 and all(c in "0123456789abcdef" for c in sig))
    flipped = f"{user}:{expiry}:" + ("0" if sig[0] != "0" else "1") + sig[1:]
    r.check("flipped signature rejected", auth.verify_session(flipped) is None)
    r.check("rewritten expiry rejected",
            auth.verify_session(f"{user}:{int(expiry) + 1}:{sig}") is None)
    r.check("swapped username rejected", auth.verify_session(f"root:{expiry}:{sig}") is None)
    stale_body = f"olai:{int(time.time()) - 5}"
    stale_sig = hmac.new(auth._key("olai"), stale_body.encode(), "sha256").hexdigest()
    r.check("expired but correctly signed rejected",
            auth.verify_session(f"{stale_body}:{stale_sig}") is None)
    for bad in (None, "", "olai", "olai:abc:def", "::", ":" * 10, "a" * 5000,
                f"olai:{expiry}", f"{user}:{expiry}:{sig}:extra"):
        r.check(f"garbage cookie {bad!r:.24} rejected", auth.verify_session(bad) is None)
    try:
        auth.issue_session("ghost")
        r.check("issuing a session for a user that does not exist is refused", False)
    except ValueError:
        r.check("issuing a session for a user that does not exist is refused", True)
    ghost_body = f"ghost:{expiry}"
    ghost_sig = hmac.new(hmac.new(auth.secret(), b"", "sha256").digest(),
                         ghost_body.encode(), "sha256").hexdigest()
    r.check("cookie signed with the bare install secret rejected",
            auth.verify_session(f"{ghost_body}:{ghost_sig}") is None)

    # The install secret is stable within a database and differs between two.
    r.check("session secret stable", history.session_secret() == history.session_secret())
    other = fresh_history(tmp, "sess2.db")
    r.check("session secret differs per install",
            history.session_secret() != other.session_secret())
    other.add_user("olai", "correct horse")
    r.check("a cookie from one install fails on another",
            Auth(other).verify_session(cookie) is None)
    other.close()

    # Revocation via the password hash.
    history.set_password("olai", "new password 99")
    auth.invalidate("olai")
    r.check("password change revokes the old cookie", auth.verify_session(cookie) is None)
    fresh = auth.issue_session("olai")
    r.check("a new cookie after the change verifies", auth.verify_session(fresh) == "olai")
    history.rename_user("olai", "olai2")
    auth.invalidate("olai")
    r.check("rename kills the cookie for the old name", auth.verify_session(fresh) is None)
    r.check("cookie for the new name verifies",
            auth.verify_session(auth.issue_session("olai2")) == "olai2")
    cookie2 = auth.issue_session("olai2")
    history.remove_user("olai2")
    auth.invalidate("olai2")
    r.check("removing the user kills the cookie", auth.verify_session(cookie2) is None)
    history.close()
    r.summary("sessions", "HMAC covers user+expiry; tamper/expiry/swap/"
              "password-change/rename/remove all revoke")


def test_limiter(r: Runner, tmp: Path) -> None:
    from culprit.auth import Auth
    r.section("login limiter")
    history = fresh_history(tmp, "lim.db")
    history.add_user("olai", "correct horse")
    auth = Auth(history)
    for i in range(auth._MAX_ATTEMPTS):
        r.check(f"failure {i + 1} returns None", auth.login("olai", "wrong", "10.0.0.1") is None)
    r.check("locked: the right password is refused",
            auth.login("olai", "correct horse", "10.0.0.1") is None)
    r.check("another address is unaffected",
            auth.login("olai", "correct horse", "10.0.0.2") is not None)
    r.check("success cleared that address's count",
            auth.login("olai", "wrong", "10.0.0.2") is None
            and auth.login("olai", "correct horse", "10.0.0.2") is not None)
    # Window expiry: age the attempts artificially.
    with auth._lock:
        auth._attempts["10.0.0.1"] = [t - auth._WINDOW_S - 1 for t in auth._attempts["10.0.0.1"]]
    r.check("attempts older than the window are forgotten",
            auth.login("olai", "correct horse", "10.0.0.1") is not None)
    r.check("limiter is applied before the hash (unknown user counts too)",
            all(auth.login("ghost", "x", "10.0.0.3") is None for _ in range(auth._MAX_ATTEMPTS))
            and auth.login("olai", "correct horse", "10.0.0.3") is None)
    history.close()
    r.summary("login limiter", f"{auth._MAX_ATTEMPTS} failures per address per "
              f"{auth._WINDOW_S:.0f}s, right password included")


def test_agents(r: Runner, tmp: Path) -> None:
    from culprit.auth import Auth
    from culprit.main import _valid_agent_name
    r.section("agent tokens")
    history = fresh_history(tmp, "ag.db")
    auth = Auth(history)
    token = history.add_agent("web-01")
    name, dot, secret = token.partition(".")
    r.check("token is <name>.<secret>", name == "web-01" and dot and len(secret) >= 32)
    r.check("verify_agent_token -> name", history.verify_agent_token(token) == "web-01")
    r.check("Auth.verify_agent parses Bearer",
            auth.verify_agent(f"Bearer {token}", "10.0.0.9") == "web-01")
    seen = next(a for a in history.list_agents() if a["name"] == "web-01")
    r.check("verify touches last_seen/last_addr",
            seen["last_seen"] and seen["last_addr"] == "10.0.0.9")
    r.check("list_agents omits the hash", "token_hash" not in seen)
    for bad in ("", "Bearer", "Bearer ", f"Basic {token}", f"bearer {token}",
                f"Bearer {name}.", f"Bearer .{secret}", f"Bearer {name}{secret}",
                f"Bearer {name}.{secret[:-1]}", f"Bearer {name}.{secret}x",
                f"Bearer ghost.{secret}", f"Bearer {token} extra"):
        r.check(f"rejects {bad[:28]!r}", auth.verify_agent(bad, None) is None)
    r.check("rejects None", auth.verify_agent(None, None) is None)
    history.revoke_agent("web-01")
    r.check("revoked token fails", history.verify_agent_token(token) is None)
    rotated = history.add_agent("web-01")
    r.check("rotation re-enables with a new secret",
            rotated != token and history.verify_agent_token(rotated) == "web-01")
    r.check("pre-rotation token stays dead", history.verify_agent_token(token) is None)
    history.remove_agent("web-01")
    r.check("deleted agent's token fails", history.verify_agent_token(rotated) is None)
    r.check("revoke/remove of unknown return False",
            not history.revoke_agent("x") and not history.remove_agent("x"))
    for candidate, want_ok in (("web-01", True), ("a_b", True), ("x" * 48, True),
                               ("local", False), ("a.b", False), ("", False),
                               (" ", False), ("x" * 49, False), ("a/b", False),
                               ("<script>", False), ("a b", False), ("a\x00", False)):
        r.check(f"name {candidate[:12]!r} {'accepted' if want_ok else 'rejected'}",
                (_valid_agent_name(candidate) is None) == want_ok)
    history.close()
    r.summary("agent tokens", "shape, revoke, rotate, delete, malformed inputs, name rules")


def test_commands(r: Runner) -> None:
    from culprit.nodes import CommandBroker
    r.section("command broker")

    async def scenario() -> None:
        broker = CommandBroker()
        id_a, fut_a = broker.submit("agent-a", "process_detail", {"pid": 1})
        id_b, fut_b = broker.submit("agent-b", "terminate", {"pid": 2})
        r.check("ids are node-scoped", id_a.startswith("agent-a:") and id_b.startswith("agent-b:"))
        broker.resolve("agent-a", [{"id": id_b, "ok": True, "result": {"spoof": 1}}])
        r.check("agent-a cannot resolve agent-b's command", not fut_b.done())
        broker.resolve("agent-a", [{"id": id_a, "ok": True, "result": {"pid": 1}}])
        r.check("agent-a resolves its own", fut_a.done() and fut_a.result()["ok"])
        broker.resolve("agent-b", [{"id": id_b, "ok": False, "status": 403, "error": "no"}])
        r.check("agent-b resolves its own", fut_b.done() and fut_b.result()["status"] == 403)
        taken = broker.take("agent-b")
        r.check("take hands out the queued command once",
                [c["id"] for c in taken] == [id_b] and broker.take("agent-b") == [])
        broker.resolve("agent-a", [{"id": "nonsense"}, {"noid": 1}, {"id": None}])
        r.check("garbage results are ignored", True)
        # Overflow drops the oldest with a 503-shaped result.
        first_id, first = broker.submit("agent-c", "priority", {})
        for _ in range(broker._MAX_PENDING):
            broker.submit("agent-c", "priority", {})
        r.check("queue overflow fails the oldest command with 503",
                first.done() and first.result().get("status") == 503)
        r.check("overflowed queue is capped", len(broker.take("agent-c")) == broker._MAX_PENDING)

    asyncio.run(scenario())
    r.summary("command broker", "results are accepted only from the node they belong to")


def test_inflate(r: Runner) -> None:
    from fastapi import HTTPException

    from culprit.main import _inflate
    from culprit.nodes import MAX_REPORT_BYTES
    r.section("report inflation")
    limit = 1024 * 1024
    small = gzip.compress(b"{}" + b" " * 1000)
    r.check("small body inflates", _inflate(small, limit) == b"{}" + b" " * 1000)
    exact = gzip.compress(b"x" * limit)
    r.check("body exactly at the limit is accepted", len(_inflate(exact, limit)) == limit)

    def status(data: bytes, lim: int) -> int:
        try:
            _inflate(data, lim)
            return 200
        except HTTPException as exc:
            return exc.status_code
    r.check("one byte over the limit -> 413", status(gzip.compress(b"x" * (limit + 1)), limit) == 413)
    bomb = gzip.compress(b"\0" * (256 * 1024 * 1024), compresslevel=9)
    t0 = time.perf_counter()
    code = status(bomb, limit)
    took = time.perf_counter() - t0
    r.check(f"256MB bomb ({len(bomb)//1024}KB) refused with 413 in bounded time",
            code == 413 and took < 1.0, f"status {code}, {took:.2f}s")
    r.check("garbage -> 400", status(b"not gzip at all", limit) == 400)
    r.check("truncated stream -> 400", status(exact[:len(exact) // 2], limit) == 400)
    r.check("gzip header only -> 400", status(b"\x1f\x8b\x08\x00", limit) == 400)
    r.check("empty body -> 400", status(b"", limit) == 400)
    r.check("MAX_REPORT_BYTES is a sane ceiling", 1 << 20 <= MAX_REPORT_BYTES <= 64 << 20)
    r.summary("report inflation", "bounded decompression: bombs cost at most the ceiling")


def test_startup(r: Runner, tmp: Path) -> None:
    from culprit.auth import (DEFAULT_PASSWORD, DEFAULT_USER, Auth,
                              ensure_default_user, refuse_exposed_without_users)
    r.section("startup safety")
    empty = fresh_history(tmp, "empty.db")
    r.check("no users: loopback binds", refuse_exposed_without_users("127.0.0.1", empty) is None)
    r.check("no users: ::1 binds", refuse_exposed_without_users("::1", empty) is None)
    r.check("no users: 0.0.0.0 refused",
            "refusing" in (refuse_exposed_without_users("0.0.0.0", empty) or ""))
    r.check("no users: a LAN address refused",
            refuse_exposed_without_users("192.168.1.5", empty) is not None)
    gate = Auth(empty)
    r.check("no users: gate is open", gate.gate("/api/snapshot") == "open")
    r.check("no users: agent path still agent-gated", gate.gate("/api/agents/report") == "agent")
    r.check("ensure_default_user creates admin", ensure_default_user(empty) is True)
    r.check("...only once", ensure_default_user(empty) is False)
    r.check("default credentials verify", empty.verify_user(DEFAULT_USER, DEFAULT_PASSWORD))
    r.check("with a user, 0.0.0.0 is allowed",
            refuse_exposed_without_users("0.0.0.0", empty) is None)
    empty.close()

    history = fresh_history(tmp, "gate.db")
    history.add_user("olai", "correct horse")
    auth = Auth(history)
    for path, want in (("/", "session"), ("/api/snapshot", "session"),
                       ("/api/settings", "session"), ("/api/docs", "session"),
                       ("/api/openapi.json", "session"), ("/api/stream", "session"),
                       ("/api/logout", "session"), ("/api/agents", "session"),
                       ("/login", "open"), ("/api/login", "open"), ("/api/auth", "open"),
                       ("/api/healthz", "open"), ("/favicon.svg", "open"),
                       ("/assets/js/app.js", "open"), ("/assets/../config.json", "open"),
                       ("/assets", "session"), ("/api/agents/report", "agent"),
                       ("/api/agents/report/", "session"), ("//api/snapshot", "session"),
                       ("/API/snapshot", "session"), ("/api/auth/", "session"),
                       ("/login/", "session")):
        r.check(f"gate {path} -> {want}", auth.gate(path) == want, auth.gate(path))
    history.close()
    r.summary("startup safety", "exposed-without-users refusal, default user, gate table")


def test_config(r: Runner) -> None:
    from culprit import config as config_module
    r.section("config patches")
    config_module.load()
    before = config_module.get().to_dict()

    def errors(patch: dict) -> list[str]:  # type: ignore[type-arg]
        _, errs = config_module.update(patch, persist=False)
        return errs
    r.check("db_path not editable", any("db_path" in e for e in errors({"db_path": "/tmp/x"})))
    r.check("host not editable", any("host" in e for e in errors({"host": "0.0.0.0"})))
    r.check("port not editable", any("port" in e for e in errors({"port": 1})))
    r.check("interval below floor rejected", bool(errors({"interval_fast": 0.0})))
    r.check("interval above ceiling rejected", bool(errors({"interval_fast": 1e9})))
    r.check("non-numeric rejected", bool(errors({"interval_fast": "fast"})))
    r.check("shell-ish string rejected", bool(errors({"retention_days": "7; rm -rf /"})))
    r.check("a bad key aborts the whole patch",
            bool(errors({"interval_fast": 1.0, "db_path": "x"}))
            and config_module.get().to_dict() == before)
    r.check("every LIMITS key is editable",
            set(config_module.LIMITS) <= set(config_module.EDITABLE))
    r.check("default bind is loopback",
            config_module.Config().host in ("127.0.0.1", "localhost", "::1"))
    r.check("public config drops db_path", "db_path" not in _public_config_keys())
    r.check("trusted_proxies: bad entry rejected",
            any("not an IP" in e for e in errors({"trusted_proxies": "10.0.0.1, gateway"})))
    r.check("trusted_hosts: port rejected", bool(errors({"trusted_hosts": ["dash:8787"]})))
    r.check("trusted_hosts: bad wildcard rejected", bool(errors({"trusted_hosts": ["*."]})))
    r.check("trusted lists: non-text rejected", bool(errors({"trusted_hosts": [1, 2]})))
    cfg, errs = config_module.update({"trusted_proxies": "127.0.0.1\n10.0.0.0/8, [::1]",
                                      "trusted_hosts": ["Dash.Example.COM.", "*.lan", "[::1]"]},
                                     persist=False)
    r.check("trusted lists: accepted and normalised", not errs
            and cfg.trusted_proxies == ["127.0.0.1", "10.0.0.0/8", "::1"]
            and cfg.trusted_hosts == ["dash.example.com", "*.lan", "::1"],
            f"{errs} {cfg.trusted_proxies} {cfg.trusted_hosts}")
    config_module.update({"trusted_proxies": [], "trusted_hosts": []}, persist=False)
    r.check("default: no trusted proxies", config_module.Config().trusted_proxies == [])
    r.check("default: Host check off", config_module.Config().trusted_hosts == [])
    r.summary("config patches", "locked fields, ranges, types, trust lists; defaults bind loopback")


def test_trust(r: Runner) -> None:
    from culprit import trust
    r.section("network trust")
    os.environ.pop(trust.ENV_PROXIES, None)
    none = trust.policy([], [])
    direct = trust.resolve("192.168.1.9", {"host": "dash.lan:8787"}, none)
    r.check("direct request passes", direct.refusal is None and direct.client == "192.168.1.9"
            and direct.host == "dash.lan" and not direct.via_proxy)
    for name, value in (("x-forwarded-for", "10.9.9.9"), ("forwarded", "for=10.9.9.9"),
                        ("x-real-ip", "10.9.9.9"), ("x-forwarded-host", "evil.example"),
                        ("x-forwarded-proto", "https"), ("x-forwarded-prefix", "/x"),
                        ("cf-connecting-ip", "10.9.9.9"), ("true-client-ip", "10.9.9.9")):
        a = trust.resolve("192.168.1.9", {"host": "dash.lan", name: value}, none)
        r.check(f"{name} from an undeclared peer refused",
                a.reason == "untrusted_proxy" and a.client == "192.168.1.9", str(a))
    r.check("refused even from loopback", trust.resolve(
        "127.0.0.1", {"host": "localhost", "x-forwarded-for": "10.9.9.9"}, none).reason == "untrusted_proxy")
    r.check("unknown peer refused", trust.resolve(
        None, {"host": "x", "x-forwarded-for": "10.9.9.9"}, none).reason == "untrusted_proxy")

    pol = trust.policy(["127.0.0.1", "10.0.0.0/8", "::1"], [])
    a = trust.resolve("127.0.0.1", {"host": "127.0.0.1:8787", "x-forwarded-for": "203.0.113.5",
                                     "x-forwarded-proto": "https", "x-forwarded-host": "dash.example.com:443"}, pol)
    r.check("declared proxy: client, scheme and host taken from the headers",
            a.refusal is None and a.via_proxy and a.client == "203.0.113.5"
            and a.scheme == "https" and a.host == "dash.example.com", str(a))
    a = trust.resolve("10.1.2.3", {"host": "h", "x-forwarded-for": "1.1.1.1, 203.0.113.5, 10.0.0.7"}, pol)
    r.check("chain: right-most untrusted hop is the client (spoofed left part ignored)",
            a.client == "203.0.113.5", a.client)
    a = trust.resolve("10.1.2.3", {"host": "h", "x-forwarded-for": "10.0.0.7"}, pol)
    r.check("chain of only trusted hops: the proxy itself", a.client == "10.0.0.7", a.client)
    a = trust.resolve("10.1.2.3", {"host": "h", "x-forwarded-for": "not-an-ip"}, pol)
    r.check("garbage from a trusted proxy: falls back to the peer", a.client == "10.1.2.3", a.client)
    a = trust.resolve("10.1.2.3", {"host": "h", "forwarded": 'for="[2001:db8::1]:4711";proto=https, for=10.0.0.9'}, pol)
    r.check("RFC 7239 Forwarded parsed (quoted, bracketed, port)",
            a.client == "2001:db8::1" and a.scheme == "https", str(a))
    a = trust.resolve("10.1.2.3", {"host": "h", "x-forwarded-proto": "ftp"}, pol)
    r.check("unknown forwarded proto ignored", a.scheme == "http")
    a = trust.resolve("::ffff:127.0.0.1", {"host": "h", "x-real-ip": "203.0.113.9"}, pol)
    r.check("IPv4-mapped IPv6 peer matches a v4 entry", a.client == "203.0.113.9", str(a))
    a = trust.resolve("10.1.2.3", {"host": "h"}, pol)
    r.check("declared proxy without headers: plain, not via_proxy",
            a.refusal is None and not a.via_proxy and a.client == "10.1.2.3")
    r.check("only address headers count, not Via",
            trust.resolve("1.2.3.4", {"host": "h", "via": "1.1 x"}, none).refusal is None)

    # `local` pinned: the machine running this check has its own addresses,
    # which must not decide whether 192.168.1.6 passes.
    mine = frozenset(trust.LOOPBACK_HOSTS | {"10.7.7.7", "boxname"})
    hosts = trust.policy([], ["dash.example.com", "*.lan", "192.168.1.5", "::1"])
    for header, ok in (("dash.example.com", True), ("DASH.example.com:8787", True),
                       ("dash.example.com.", True), ("a.lan", True), ("x.y.lan", True),
                       ("lan", False), ("evil.example", False), ("192.168.1.5:8787", True),
                       ("192.168.1.6", False), ("[::1]:8787", True), ("localhost", True),
                       ("127.0.0.1:8787", True), ("", False), ("dash.example.com.evil", False),
                       ("10.7.7.7:8787", True), ("BoxName", True)):
        a = trust.resolve("192.168.1.9", {"host": header}, hosts, local=mine)
        r.check(f"Host {header!r} -> {'allowed' if ok else 'refused'}",
                (a.refusal is None) == ok, str(a.refusal))
    a = trust.resolve("192.168.1.9", {"host": "evil.example"}, hosts, local=mine)
    r.check("refusal names the reason", a.reason == "untrusted_host")
    both = trust.policy(["10.0.0.0/8"], ["dash.example.com"])
    a = trust.resolve("10.0.0.2", {"host": "10.0.0.1", "x-forwarded-host": "dash.example.com"}, both, local=mine)
    r.check("forwarded Host from a declared proxy is the one checked", a.refusal is None, str(a))
    a = trust.resolve("10.0.0.2", {"host": "dash.example.com", "x-forwarded-host": "evil.example"}, both, local=mine)
    r.check("...and a foreign forwarded Host is refused", a.reason == "untrusted_host")
    r.check("empty host list accepts anything", trust.host_allowed("whatever", [], local=mine))
    live = trust.local_names(refresh=True)
    import socket as _socket
    r.check("local_names: loopback, the host name and an interface address",
            trust.LOOPBACK_HOSTS <= live and _socket.gethostname().lower() in live
            and any("." in n and n[0].isdigit() for n in live), str(sorted(live))[:200])
    own = next(n for n in live if n[0].isdigit() and n not in ("127.0.0.1",))
    r.check("this machine's own address passes an unrelated list",
            trust.resolve("192.168.1.9", {"host": f"{own}:8787"},
                          trust.policy([], ["only.example"])).refusal is None, own)

    os.environ[trust.ENV_PROXIES] = "172.16.0.1"
    a = trust.resolve("172.16.0.1", {"host": "h", "x-forwarded-for": "203.0.113.5"}, trust.policy([], []))
    r.check("--trust-proxy adds to the saved list for this run", a.client == "203.0.113.5", str(a))
    os.environ.pop(trust.ENV_PROXIES, None)
    r.check("...and is gone with the variable", trust.resolve(
        "172.16.0.1", {"host": "h", "x-forwarded-for": "203.0.113.5"}, trust.policy([], [])).refusal is not None)

    r.check("split_entries: string forms", trust.split_entries("a, b\nc  a") == ["a", "b", "c"])
    r.check("parse_hosts rejects port / space / slash", all(
        _raises(trust.parse_hosts, [x]) for x in ("dash:80", "a b", "a/b", "-bad.example", "*.")))
    r.check("parse_proxies rejects names", _raises(trust.parse_proxies, ["gateway"]))
    r.check("host_of strips port, brackets, case, dot",
            trust.host_of("[::1]:8787") == "::1" and trust.host_of("Dash.LAN.:80") == "dash.lan")
    r.summary("network trust", "undeclared proxies refused, declared ones honoured right-to-left, Host list with wildcards + own names")


def _raises(fn, *args):  # type: ignore[no-untyped-def]
    try:
        fn(*args)
    except ValueError:
        return True
    return False


def _public_config_keys() -> set[str]:
    from culprit.main import _public_config
    return set(_public_config())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="print every passing assertion")
    args = parser.parse_args()
    r = Runner(args.verbose)
    # The code under test logs every refused login and spoofed command; that
    # is the point, not noise worth printing here.
    logging.disable(logging.CRITICAL)
    print(f"{BOLD}culprit auth logic check{RESET}")
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="culprit-auth-") as tmpdir:
        tmp = Path(tmpdir)
        # Keep the app's own config out of it: nothing here persists.
        os.environ["CULPRIT_NO_BROWSER"] = "1"
        test_passwords(r, tmp)
        test_sessions(r, tmp)
        test_limiter(r, tmp)
        test_agents(r, tmp)
        test_commands(r)
        test_inflate(r)
        test_startup(r, tmp)
        test_config(r)
        test_trust(r)
    took = time.perf_counter() - started
    print(f"\n{BOLD}summary{RESET}  {r.passed} passed  {len(r.failed)} failed  "
          f"{DIM}({took:.1f}s){RESET}")
    for name in r.failed:
        print(f"  {RED}FAIL{RESET} {name}")
    print(f"{RED}FAIL{RESET}" if r.failed else f"{GREEN}OK{RESET}")
    return 1 if r.failed else 0


if __name__ == "__main__":
    sys.exit(main())
