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
* roles: viewer/operator/admin validation, the migration default, the
  last-admin guard on both demotion and removal, cache TTL/invalidate, and
  the rank comparisons a role gate relies on
* login limiter: locks the address after 8 failures even for the right
  password, other addresses unaffected, success clears the count
* agent tokens: shape, revoke, rotate, delete, malformed inputs
* API keys: shape, the role cap (never above the owner, and following a
  demotion at once), expiry, owner-scoped revocation, the cascade with the
  account, the throttled last-used stamp, a key presented beside a cookie is
  judged alone, and every credential route refuses a key (require_session)
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
import urllib.parse
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
    # A second admin so the removal below isn't the last-admin guard (that
    # guard gets its own dedicated coverage in test_roles).
    history.add_user("spare-admin", "another password 99")
    history.remove_user("olai2")
    auth.invalidate("olai2")
    r.check("removing the user kills the cookie", auth.verify_session(cookie2) is None)
    history.close()
    r.summary("sessions", "HMAC covers user+expiry; tamper/expiry/swap/"
              "password-change/rename/remove all revoke")


def test_roles(r: Runner, tmp: Path) -> None:
    from culprit.auth import ROLE_RANK, Auth
    from culprit.db import ROLES
    r.section("roles")
    history = fresh_history(tmp, "roles.db")

    history.add_user("root-admin", "correct horse 1")
    r.check("add_user defaults to admin",
            history.user_role("root-admin") == "admin")
    history.add_user("viewer1", "correct horse 2", "viewer")
    r.check("add_user honours an explicit role",
            history.user_role("viewer1") == "viewer")
    r.check("add_user rejects an unknown role",
            _raises(history.add_user, "x", "correct horse 3", "superuser"))

    r.check("set_role changes a non-admin freely",
            history.set_role("viewer1", "operator")
            and history.user_role("viewer1") == "operator")
    r.check("set_role rejects an unknown role",
            not history.set_role("viewer1", "superuser"))
    r.check("set_role False for a user that does not exist",
            not history.set_role("ghost", "admin"))

    # Last-admin guard: root-admin is the only admin left (viewer1 is now
    # operator), so neither demoting nor removing it is allowed.
    r.check("count_admins reflects reality", history.count_admins() == 1)
    r.check("set_role refuses to demote the last admin",
            not history.set_role("root-admin", "viewer"))
    r.check("remove_user refuses to remove the last admin",
            not history.remove_user("root-admin"))
    r.check("the last admin is still there and still admin",
            history.user_role("root-admin") == "admin")

    # A second admin lifts the guard.
    history.add_user("spare-admin", "correct horse 4", "admin")
    r.check("set_role allows demoting once another admin exists",
            history.set_role("root-admin", "operator"))
    # add_user's ON CONFLICT only refreshes the password, never the role, so
    # restoring root-admin's role needs set_role, not another add_user call.
    history.set_role("root-admin", "admin")
    r.check("remove_user allows removing an admin once another exists",
            history.remove_user("spare-admin"))

    r.check("list_users reports every role",
            {u["username"]: u["role"] for u in history.list_users()}
            == {"root-admin": "admin", "viewer1": "operator"})

    auth = Auth(history)
    r.check("Auth.role_of reads the stored role",
            auth.role_of("viewer1") == "operator")
    r.check("Auth.role_of is None for a user that does not exist",
            auth.role_of("ghost") is None)
    history.set_role("viewer1", "admin")
    r.check("role change is stale until invalidate (cache TTL)",
            auth.role_of("viewer1") == "operator")
    auth.invalidate("viewer1")
    r.check("invalidate makes the new role visible immediately",
            auth.role_of("viewer1") == "admin")

    for role, minimum, expected in (
        ("admin", "viewer", True), ("admin", "operator", True), ("admin", "admin", True),
        ("operator", "viewer", True), ("operator", "operator", True), ("operator", "admin", False),
        ("viewer", "viewer", True), ("viewer", "operator", False), ("viewer", "admin", False),
        (None, "viewer", False),
    ):
        r.check(f"satisfies({role!r}, {minimum!r}) == {expected}",
                auth.satisfies(role, minimum) is expected)

    r.check("every real role is in the rank table",
            all(role in ROLE_RANK for role in ROLES))
    history.close()
    r.summary("roles", "migration default, validation, the last-admin guard, "
              "role-cache TTL/invalidate, and rank comparisons")


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
        auth._attempts[("login", "10.0.0.1")] = [
            t - auth._WINDOW_S - 1 for t in auth._attempts[("login", "10.0.0.1")]]
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


def test_api_keys(r: Runner, tmp: Path) -> None:
    import re
    from types import SimpleNamespace

    from culprit import main as main_module
    from culprit.auth import Auth
    from culprit.db import API_KEY_PREFIX, MAX_API_KEYS_PER_USER
    r.section("API keys")
    history = fresh_history(tmp, "keys.db")
    auth = Auth(history)
    history.add_user("root", "rootpass-1", "admin")
    history.add_user("olga", "olgapass-1", "operator")
    history.add_user("vera", "verapass-1", "viewer")

    key_id, token = history.add_api_key("olga", "grafana", "operator")
    r.check("token is ck_<12 hex>.<secret>",
            bool(re.fullmatch(r"ck_[0-9a-f]{12}\.[\w-]{43}", token))
            and token.startswith(f"{API_KEY_PREFIX}{key_id}."))
    got = auth.verify_api_key(f"Bearer {token}", "10.0.0.7")
    r.check("verify -> owner, effective role, id, name",
            got == {"id": key_id, "name": "grafana", "username": "olga", "role": "operator"},
            repr(got))
    listed = history.list_api_keys("olga")[0]
    r.check("list omits the hash", "token_hash" not in listed)
    r.check("first use stamps last_used/last_addr",
            listed["last_used"] and listed["last_addr"] == "10.0.0.7")
    history._execute("UPDATE api_keys SET last_used = NULL WHERE id = ?", (key_id,))
    auth.verify_api_key(f"Bearer {token}", "10.0.0.8")
    r.check("the stamp is throttled (no write per request)",
            history.list_api_keys("olga")[0]["last_used"] is None)
    r.check("unknown role / unknown user mint nothing",
            history.add_api_key("olga", "x", "root") is None
            and history.add_api_key("ghost", "x", "viewer") is None)

    secret = token.split(".", 1)[1]
    agent_token = history.add_agent("web-01")
    for bad in ("", "Bearer", f"Basic {token}", f"bearer {token}", f"Bearer {token}x",
                f"Bearer {token[:-1]}", f"Bearer ck_{key_id}.", f"Bearer ck_.{secret}",
                f"Bearer ck_{key_id}{secret}", f"Bearer ck_000000000000.{secret}",
                f"Bearer {key_id}.{secret}", f"Bearer {agent_token}",
                f"Bearer ck_{key_id}.{secret} extra"):
        r.check(f"rejects {bad[:30]!r}", auth.verify_api_key(bad, None) is None)
    r.check("rejects None", auth.verify_api_key(None, None) is None)
    r.check("a key is not an agent token",
            auth.verify_agent(f"Bearer {token}", None) is None)

    # The cap: the lower of the key's role and the owner's, read per request.
    history.set_role("olga", "viewer")
    r.check("demoting the owner demotes the key at once",
            auth.verify_api_key(f"Bearer {token}", None)["role"] == "viewer")
    history.set_role("olga", "admin")
    r.check("promoting the owner never lifts the key past its cap",
            auth.verify_api_key(f"Bearer {token}", None)["role"] == "operator")

    # Expiry.
    _, soon = history.add_api_key("vera", "short", "viewer", time.time() + 60)
    r.check("an unexpired key verifies", auth.verify_api_key(f"Bearer {soon}", None) is not None)
    history._execute("UPDATE api_keys SET expires_at = ? WHERE username = 'vera'",
                     (time.time() - 1,))
    r.check("an expired key fails like an unknown one",
            auth.verify_api_key(f"Bearer {soon}", None) is None)

    # Revocation is scoped; the password is not part of a key.
    r.check("cannot revoke someone else's key through the self-service path",
            not history.remove_api_key(key_id, "vera")
            and auth.verify_api_key(f"Bearer {token}", None) is not None)
    history.set_password("olga", "another-pass-1")
    r.check("a password change leaves keys working (they are revoked one by one)",
            auth.verify_api_key(f"Bearer {token}", None) is not None)
    history.rename_user("olga", "olga2")
    r.check("a rename carries the keys along",
            (auth.verify_api_key(f"Bearer {token}", None) or {}).get("username") == "olga2")
    r.check("the owner revokes their own", history.remove_api_key(key_id, "olga2")
            and auth.verify_api_key(f"Bearer {token}", None) is None)
    _, gone = history.add_api_key("olga2", "cascade", "viewer")
    history.remove_user("olga2")
    r.check("removing the account removes its keys",
            auth.verify_api_key(f"Bearer {gone}", None) is None
            and history.list_api_keys("olga2") == [])
    r.check("the per-user ceiling is sane", 1 <= MAX_API_KEYS_PER_USER <= 100)

    # The gate's view: a presented key is judged alone.
    saved = main_module.auth
    main_module.auth = auth
    try:
        _, root_key = history.add_api_key("root", "ci", "viewer")
        cookie = auth.issue_session("root")

        def request(authorization: str | None, with_cookie: bool):  # type: ignore[no-untyped-def]
            return SimpleNamespace(
                headers={"authorization": authorization} if authorization else {},
                cookies={"culprit_session": cookie} if with_cookie else {},
                client=SimpleNamespace(host="10.0.0.9"))
        user, role, key = main_module._identify(request(None, True))
        r.check("a cookie alone is the session", (user, role, key) == ("root", "admin", None))
        user, role, key = main_module._identify(request(f"Bearer {root_key}", True))
        r.check("a key beside a cookie is judged as the key",
                (user, role) == ("root", "viewer") and key is not None)
        r.check("a wrong key beside a good cookie is refused, not ignored",
                main_module._identify(request(f"Bearer {root_key}x", True)) == (None, None, None))
        r.check("an agent token beside a cookie is not a key (the session stands)",
                main_module._identify(request(f"Bearer {agent_token}", True))[0] == "root")
        r.check("an agent token alone opens nothing",
                main_module._identify(request(f"Bearer {agent_token}", False)) == (None, None, None))
    finally:
        main_module.auth = saved

    # Which routes refuse a key is a property of the route.
    session_only = set()
    for route in main_module.app.routes:
        deps = getattr(getattr(route, "dependant", None), "dependencies", None) or []
        if any(getattr(d.call, "session_only", False) for d in deps):
            session_only.add(route.path)
    credential_routes = {
        "/api/account/keys", "/api/account/keys/{key_id}", "/api/keys", "/api/keys/{key_id}",
        "/api/account/password", "/api/account/username", "/api/account/oidc/link",
        "/api/account/oidc"}
    r.check("every credential route is session-only",
            credential_routes <= session_only, str(sorted(credential_routes - session_only)))
    r.check("and nothing else is", session_only == credential_routes,
            str(sorted(session_only - credential_routes)))
    history.close()
    r.summary("API keys", "shape, cap, expiry, revocation, cascade, precedence, session-only routes")


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
            refuse_exposed_without_users("192.0.2.10", empty) is not None)
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
                       ("/login/", "session"),
                       ("/api/auth/oidc/start", "open"), ("/api/auth/oidc/callback", "open"),
                       ("/api/auth/oidc/", "session"), ("/api/auth/oidc/callback/", "session"),
                       ("/api/account", "session"), ("/api/oidc/test", "session")):
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
    r.check("oidc: http issuer rejected", bool(errors({"oidc_issuer": "http://idp.example/"})))
    r.check("oidc: loopback http issuer allowed",
            not errors({"oidc_issuer": "http://127.0.0.1:9000/application/o/x/"}))
    r.check("oidc: scopes without openid rejected", bool(errors({"oidc_scopes": "profile email"})))
    r.check("oidc: unknown role rejected", bool(errors({"oidc_default_role": "root"})))
    r.check("oidc: bad domain rejected", bool(errors({"oidc_allowed_domains": ["not a domain"]})))
    cfg, errs = config_module.update({"oidc_allowed_domains": "@Example.COM\nx.org, example.com"}, persist=False)
    r.check("oidc: domains lower-cased and de-duplicated",
            not errs and cfg.oidc_allowed_domains == ["example.com", "x.org"], f"{errs} {cfg.oidc_allowed_domains}")
    config_module.update({"oidc_issuer": "", "oidc_allowed_domains": []}, persist=False)
    r.check("default: provider off, no auto-create, viewer",
            not config_module.Config().oidc_enabled and not config_module.Config().oidc_auto_create
            and config_module.Config().oidc_default_role == "viewer")
    keys = _public_config_keys()
    from culprit.main import _public_config
    r.check("public config masks the client secret",
            "oidc_client_secret_set" in keys and _public_config()["oidc_client_secret"] == "")
    r.summary("config patches", "locked fields, ranges, types, trust lists; defaults bind loopback")


def test_oidc(r: Runner, tmp: Path) -> None:
    """The provider flow against a fake issuer: oidc.py's protocol half and
    auth.py's account half, with the network replaced by a dict."""
    import base64
    import json
    from culprit import oidc
    from culprit.auth import Auth, derive_username
    from culprit.config import Config
    r.section("provider sign-in (OIDC)")
    ISS = "https://idp.example/application/o/culprit/"
    DOC = {"issuer": ISS,
           "authorization_endpoint": "https://idp.example/application/o/authorize/",
           "token_endpoint": "https://idp.example/application/o/token/",
           "userinfo_endpoint": "https://idp.example/application/o/userinfo/",
           "code_challenge_methods_supported": ["S256"]}

    def b64(obj: dict) -> str:  # type: ignore[type-arg]
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    class FakeIdP:
        def __init__(self) -> None:
            self.claims: dict = {}   # type: ignore[type-arg]
            self.userinfo: dict = {}  # type: ignore[type-arg]
            self.doc = dict(DOC)
            self.token_status: int | None = None
            self.form: dict = {}  # type: ignore[type-arg]

        def __call__(self, url, data=None, headers=None, timeout=None):  # type: ignore[no-untyped-def]
            if url.endswith("openid-configuration"):
                return dict(self.doc)
            if url == DOC["token_endpoint"]:
                if self.token_status:
                    raise oidc.FetchError("HTTP 400", self.token_status, {"error": "invalid_grant"})
                self.form = {k: v for k, v in (p.split("=", 1) for p in data.decode().split("&"))}
                self.basic = headers.get("Authorization", "")
                return {"id_token": f"{b64({'alg': 'RS256'})}.{b64(self.claims)}.sig",
                        "access_token": "at", "token_type": "Bearer"}
            if url == DOC["userinfo_endpoint"]:
                self.bearer = headers.get("Authorization", "")
                return dict(self.userinfo)
            raise oidc.FetchError("unknown " + url)

    def refuses(fn, *args):  # type: ignore[no-untyped-def]
        try:
            fn(*args)
        except oidc.OIDCError:
            return True
        return False

    idp = FakeIdP()
    cfg = Config(oidc_enabled=True, oidc_issuer=ISS, oidc_client_id="cid", oidc_client_secret="sec")
    history = fresh_history(tmp, "oidc.db")
    history.add_user("olai", "correct horse")
    auth = Auth(history)
    secret = auth.secret()
    r.check("configured needs every field", oidc.configured(cfg)
            and not oidc.configured(Config(oidc_enabled=True, oidc_issuer=ISS, oidc_client_id="cid"))
            and oidc.missing(Config()) == ["oidc_issuer", "oidc_client_id", "oidc_client_secret"])

    def trip(cfg, *, mode="login", user=None, session_user=None, sub="sub-1",  # type: ignore[no-untyped-def]
             email="Anna@Example.com", verified=True, pu="anna", tamper=None, error_param=None,
             addr="1.2.3.4", code="code123"):
        url, cookie = oidc.begin(cfg, redirect_uri="https://h/api/auth/oidc/callback", secret=secret,
                                 mode=mode, user=user, fetch=idp)
        st = oidc.read_state(cookie, secret)
        idp.claims = {"iss": ISS, "aud": "cid", "exp": time.time() + 300, "iat": time.time(),
                      "nonce": st["n"], "sub": sub}
        idp.userinfo = {"sub": sub, "email": email, "email_verified": verified,
                        "preferred_username": pu, "name": pu}
        if tamper:
            tamper(idp, st)
        return auth.oidc_finish(cfg, cookie, code, st["s"], error_param, addr, session_user, fetch=idp), url, st

    # begin: PKCE, nonce, state, the cookie's shape
    (out, url, st) = trip(cfg)
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
    r.check("authorize URL carries S256 PKCE, nonce, state, redirect_uri, openid scope",
            q["code_challenge_method"] == "S256" and q["code_challenge"] == oidc.pkce_challenge(st["v"])
            and q["nonce"] == st["n"] and q["state"] == st["s"]
            and q["redirect_uri"] == "https://h/api/auth/oidc/callback" and "openid" in q["scope"].split())
    r.check("token exchange sends the verifier, the redirect URI and Basic client credentials",
            idp.form.get("code_verifier") == st["v"] and idp.form.get("grant_type") == "authorization_code"
            and urllib.parse.unquote(idp.form.get("redirect_uri", "")) == "https://h/api/auth/oidc/callback"
            and idp.basic.startswith("Basic ") and idp.bearer == "Bearer at")
    r.check("auto-create off: a stranger is refused as not_linked and nothing is created",
            out == (None, "not_linked", "login") and history.user_count() == 1)

    # state cookie
    url, cookie = oidc.begin(cfg, redirect_uri="x", secret=secret, fetch=idp)
    good = oidc.read_state(cookie, secret)
    r.check("state cookie round-trips", good["s"] and good["n"] and good["v"] and good["m"] == "login")
    r.check("tampered signature refused", refuses(oidc.read_state, cookie[:-1] + ("0" if cookie[-1] != "0" else "1"), secret))
    r.check("tampered body refused", refuses(oidc.read_state, "e30" + cookie[3:], secret))
    r.check("another install's secret refused", refuses(oidc.read_state, cookie, b"other-secret"))
    r.check("expired state refused as 'expired'",
            auth.oidc_finish(cfg, oidc.sign_state({**good, "exp": time.time() - 1}, secret), "c", good["s"],
                             None, "1.2.3.9", fetch=idp)[1] == "expired")
    r.check("no cookie -> state", auth.oidc_finish(cfg, None, "c", "s", None, "1.2.3.9", fetch=idp)[1] == "state")
    r.check("state parameter mismatch -> state",
            auth.oidc_finish(cfg, cookie, "c", "not-the-state", None, "1.2.3.9", fetch=idp)[1] == "state")
    r.check("provider error -> denied, no exchange",
            trip(cfg, error_param="access_denied")[0] == (None, "denied", "login"))
    idp.token_status = 400
    r.check("refused exchange -> exchange", trip(cfg)[0][1] == "exchange")
    idp.token_status = None

    # claims
    def claim_case(name, fn, code):  # type: ignore[no-untyped-def]
        out = trip(cfg, sub="sub-9", tamper=fn)[0]
        r.check(f"{name} -> {code}", out[1] == code and out[0] is None, str(out))
    claim_case("wrong iss", lambda i, st: i.claims.__setitem__("iss", "https://evil/"), "id_token")
    claim_case("aud for another client", lambda i, st: i.claims.__setitem__("aud", "other"), "id_token")
    claim_case("multiple aud without azp", lambda i, st: i.claims.__setitem__("aud", ["cid", "other"]), "id_token")
    claim_case("expired token", lambda i, st: i.claims.__setitem__("exp", time.time() - 120), "id_token")
    claim_case("missing sub", lambda i, st: i.claims.pop("sub"), "id_token")
    claim_case("wrong nonce", lambda i, st: i.claims.__setitem__("nonce", "zzz"), "nonce")
    claim_case("userinfo sub differs", lambda i, st: i.userinfo.__setitem__("sub", "else"), "userinfo")
    r.check("nothing was linked by any of those", history.identity_user("oidc", "sub-9") is None)
    r.check("...and each of them counted against the address's oidc bucket",
            len(auth._attempts.get(("oidc", "1.2.3.4"), [])) >= 7)
    auth._clear("oidc", "1.2.3.4")   # the rest of the test is about accounts, not floods
    r.check("discovery: issuer mismatch refused",
            refuses(oidc.Discovery().get, "https://idp.example/other/", idp))
    bad = FakeIdP(); bad.doc["token_endpoint"] = "http://idp.example/token"
    r.check("discovery: a plain-http endpoint refused", refuses(oidc.Discovery().get, ISS, bad))
    r.check("issuer must be https (loopback http excepted)",
            oidc.issuer_problem("http://idp.example/") and not oidc.issuer_problem("https://idp.example/")
            and not oidc.issuer_problem("http://localhost:9000/x/"))

    # pre-link by e-mail, claimed at first sign-in
    r.check("pre-link by e-mail", history.prelink_identity("olai", "oidc", "anna@example.com")
            and history.identity_of("olai", "oidc")["subject_set"] is False)
    r.check("unverified e-mail cannot claim", trip(cfg, verified=False)[0] == (None, "email_unverified", "login"))
    r.check("claim: case-insensitive e-mail match opens the account",
            trip(cfg)[0] == ("olai", None, "login") and history.identity_of("olai", "oidc")["subject"] == "sub-1")
    r.check("second sign-in resolves by subject",
            trip(cfg, email="renamed@example.com")[0] == ("olai", None, "login")
            and history.identity_of("olai", "oidc")["email"] == "renamed@example.com")
    r.check("a claimed link cannot be re-pre-linked", not history.prelink_identity("olai", "oidc", "x@y.z"))

    # auto-create
    cfg2 = Config(**{**cfg.to_dict(), "oidc_auto_create": True, "oidc_allowed_domains": ["example.com"],
                     "oidc_default_role": "operator"})
    out = trip(cfg2, sub="sub-2", email="olai@example.com", pu="Olai")[0]
    r.check("auto-create: username derived, collision suffixed, role from config, no password",
            out == ("olai-2", None, "login") and history.user_role("olai-2") == "operator"
            and not history.has_password("olai-2") and history.identity_user("oidc", "sub-2")["username"] == "olai-2")
    r.check("auto-create: other domain refused", trip(cfg2, sub="sub-3", email="x@other.org", pu="x")[0][1] == "domain")
    r.check("auto-create: unverified e-mail refused when domains are listed",
            trip(cfg2, sub="sub-3", verified=False)[0][1] == "email_unverified")
    r.check("auto-create: no e-mail refused when domains are listed",
            trip(cfg2, sub="sub-3", email=None)[0][1] == "domain")
    r.check("auto-create: accents folded, e-mail local part as fallback",
            trip(cfg2, sub="sub-4", email="Jörg.Müller@example.com", pu=None)[0] == ("jorg.muller", None, "login"))
    r.check("password login for a provider-created account fails in one scrypt",
            not history.verify_user("olai-2", "anything") and auth.login("olai-2", "x", "5.5.5.5") is None)
    r.check("add_identity_user never overwrites an existing account",
            not history.add_identity_user("olai", "viewer") and history.verify_user("olai", "correct horse"))

    # limiter: its own bucket, before the exchange
    for _ in range(auth._MAX_ATTEMPTS):
        auth.oidc_finish(cfg, None, "c", "s", None, "9.9.9.9", fetch=idp)
    idp.form = {}
    out = trip(cfg, addr="9.9.9.9")[0]
    r.check("oidc bucket: locked after the failures, before any exchange",
            out[1] == "rate_limited" and idp.form == {})
    r.check("oidc bucket: password login from that address unaffected",
            auth.login("olai", "correct horse", "9.9.9.9") is not None)
    r.check("oidc bucket: other addresses unaffected", trip(cfg)[0] == ("olai", None, "login"))

    # link mode
    history.add_user("bob", "password123", "viewer")
    r.check("link: session must be the account that started it",
            trip(cfg, mode="link", user="bob", session_user="olai", sub="sub-5")[0] == (None, "session", "link"))
    r.check("link: someone else's identity refused",
            trip(cfg, mode="link", user="bob", session_user="bob", sub="sub-1")[0] == (None, "linked_elsewhere", "link"))
    r.check("link: binds the identity", trip(cfg, mode="link", user="bob", session_user="bob", sub="sub-5")[0] == ("bob", None, "link")
            and history.identity_user("oidc", "sub-5")["username"] == "bob")
    r.check("link: a second identity refused as taken",
            trip(cfg, mode="link", user="bob", session_user="bob", sub="sub-6")[0] == (None, "taken", "link"))
    r.check("link: mode survives a failed state read (login)",
            auth.oidc_finish(cfg, None, "c", "s", None, "7.7.7.7", fetch=idp)[2] == "login")

    # revocation and cascade
    session = auth.issue_session("olai-2")
    r.check("a provider-created account gets a normal session", auth.verify_session(session) == "olai-2")
    history.unlink_identity("olai-2", "oidc")
    r.check("rotate_login_key revokes it", history.rotate_login_key("olai-2") and (auth.invalidate("olai-2") or True)
            and auth.verify_session(session) is None)
    r.check("rotate_login_key is a no-op for a password account", not history.rotate_login_key("olai"))
    r.check("rename carries the identity", history.rename_user("bob", "bobby")
            and history.identity_user("oidc", "sub-5")["username"] == "bobby")
    r.check("remove drops the identity", history.remove_user("bobby") and history.identity_user("oidc", "sub-5") is None)
    users = {u["username"]: u for u in history.list_users()}
    r.check("list_users carries has_password and identity",
            users["olai"]["has_password"] and users["olai"]["identity"]["subject"] == "sub-1"
            and users["olai-2"]["has_password"] is False and users["olai-2"]["identity"] is None)

    # derive_username
    r.check("derive_username: charset, length, fallback, suffixes",
            derive_username(oidc.Identity(sub="ab:cd", preferred_username="::"), lambda n: False) == "abcd"
            and derive_username(oidc.Identity(sub="x" * 100), lambda n: False) == "x" * 40
            and derive_username(oidc.Identity(sub="!!!"), lambda n: False) == "user"
            and derive_username(oidc.Identity(sub="s", preferred_username="Olai"), lambda n: n in ("olai", "olai-2")) == "olai-3"
            and ":" not in derive_username(oidc.Identity(sub="a:b:c"), lambda n: False))
    r.check("every error code has a sentence", all(oidc.error_text(c) for c in oidc.ERRORS)
            and oidc.error_text("made-up") == oidc.ERRORS["state"])
    history.close()
    r.summary("provider sign-in (OIDC)", "PKCE + nonce + signed state, every claim check, "
              "pre-link claim, auto-create rules, link mode, its own limiter bucket, revocation")


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
    hosts = trust.policy([], ["dash.example.com", "*.lan", "192.0.2.10", "::1"])
    for header, ok in (("dash.example.com", True), ("DASH.example.com:8787", True),
                       ("dash.example.com.", True), ("a.lan", True), ("x.y.lan", True),
                       ("lan", False), ("evil.example", False), ("192.0.2.10:8787", True),
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
        test_roles(r, tmp)
        test_limiter(r, tmp)
        test_agents(r, tmp)
        test_api_keys(r, tmp)
        test_commands(r)
        test_inflate(r)
        test_startup(r, tmp)
        test_config(r)
        test_oidc(r, tmp)
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
