"""Authentication for the dashboard and the agent ingest endpoint.

Three independent mechanisms, because the callers are different animals:

* **People** sign in with a username/password (scrypt-hashed in SQLite -- see
  db.py) and get an HMAC-signed session cookie: `user:expiry:signature`,
  signed with a per-installation secret stored in the database. Stateless, so
  sessions survive restarts and there is no session table to leak or prune.
  The signing key also mixes in the user's current password hash, so changing
  (or removing) the password invalidates every session for that account --
  the one revocation a stateless design still needs, at no storage cost.
* **Agents** authenticate every report with a bearer token `<name>.<secret>`;
  only the SHA-256 of the secret is stored. A token identifies exactly one
  node and can be revoked without touching any other.

* **Scripts** acting for a person carry an API key, `Authorization: Bearer
  ck_<id>.<secret>`, stored like an agent token (SHA-256 only, shown once).
  A key belongs to a user and carries a role cap; what it may do is the
  lower of that cap and the owner's *current* role, read per request, so a
  demotion reaches the person's keys as fast as it reaches their session and
  removing the account removes them. A key is deliberately independent of
  the password (rotating a password must not break the backup check, and an
  account a provider opened has none), so minting one asks for nothing but
  the session -- and a key can never mint or revoke keys or touch the
  account's credentials (main.require_session).

People can also arrive through an OpenID Connect provider (oidc.py does the
protocol; `Auth.oidc_finish` below decides which account that is). Such a
sign-in ends in the very same session cookie, so nothing downstream knows
the difference. An account the provider created has no password: its stored
hash is an unusable sentinel (db.py `login_key_sentinel`), which is still
what the session key mixes in, so re-randomising it revokes the account's
sessions the way a password change does.

Enforcement policy, chosen to avoid both lockouts and accidental exposure:

* No users in the database + bound to loopback -> auth is OFF (single-user
  local tool, nothing is reachable anyway) and the UI says so.
* No users + bound to a real interface -> the server REFUSES to start. An
  unauthenticated dashboard with a process-kill button must never be reachable
  from a network by accident.
* Any user exists -> auth is ON everywhere, loopback included.

Login attempts are rate-limited per source address (in memory) so the password
hash cannot be brute-forced online at wire speed.
"""

from __future__ import annotations

import hmac
import logging
import secrets
import threading
import time
import unicodedata
from typing import Any, Callable

from . import oidc
from .db import API_KEY_PREFIX, History

log = logging.getLogger("culprit.auth")

SESSION_COOKIE = "culprit_session"
SESSION_HOURS = 24 * 7

# viewer: read-only. operator: viewer + process actions (terminate/priority/
# throttle, agent update) and expected-finding markers. admin: operator +
# user/agent management and Settings. Rank is what a minimum-role check
# compares against -- "at least operator" is `RANK[role] >= RANK["operator"]`.
ROLE_RANK = {"viewer": 0, "operator": 1, "admin": 2}

# Paths reachable without a session. Everything else under / is gated when
# auth is enabled. The agent report endpoint has its own bearer check.
PUBLIC_PATHS = frozenset({
    "/login", "/api/login", "/api/auth", "/api/healthz", "/favicon.svg",
    # The provider round-trip: the browser leaves from one and comes back,
    # signed out, to the other. Both are exact paths, both are login-mode
    # only, and neither handler touches dashboard data (auth.oidc_finish
    # does the account work) -- tools/audit_security.py reads their source.
    oidc.START_PATH, oidc.CALLBACK_PATH,
})
AGENT_PATHS = frozenset({"/api/agents/report"})

# Static assets (JS/CSS) are code, not data; serving them unauthenticated
# leaks nothing the public repository does not already contain, and it lets
# the login page share the theme.
PUBLIC_PREFIXES = ("/assets/",)


class Auth:
    def __init__(self, history: History) -> None:
        self.history = history
        self._secret: bytes | None = None
        self._attempts: dict[str, list[float]] = {}
        self._keys: dict[str, tuple[float, bytes, str]] = {}
        self._key_touched: dict[str, float] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ state
    _ENABLED_TTL = 5.0

    @property
    def enabled(self) -> bool:
        """Cached briefly: this runs on every request, and `users add` from
        the CLI taking up to 5s to switch the gate on is a fine trade for not
        hitting SQLite per request."""
        now = time.monotonic()
        if now - getattr(self, "_enabled_at", 0.0) > self._ENABLED_TTL:
            self._enabled_cache = (self.history.ready
                                   and self.history.user_count() > 0)
            self._enabled_at = now
        return self._enabled_cache

    def secret(self) -> bytes:
        if self._secret is None:
            self._secret = self.history.session_secret()
        return self._secret

    # --------------------------------------------------------------- sessions
    _KEY_TTL = 5.0

    def _entry(self, username: str) -> tuple[bytes, str] | None:
        """(signing key, role) for a user, or None when no such user exists --
        a cookie can never verify for a name that is not in the table. Cached
        briefly (this runs per request) and only for users that exist, so a
        flood of forged cookies for made-up names cannot grow the cache --
        their lookup is one indexed SELECT. One query backs both the session
        key and the role, so a role change is visible exactly as fast as a
        password change (same cache, same `invalidate`)."""
        now = time.monotonic()
        cached = self._keys.get(username)
        if cached and now - cached[0] < self._KEY_TTL:
            return cached[1], cached[2]
        creds = self.history.user_credentials(username)
        if not creds:
            return None
        stored, role = creds
        key = hmac.new(self.secret(), stored.encode(), "sha256").digest()
        with self._lock:
            self._keys[username] = (now, key, role)
        return key, role

    def _key(self, username: str) -> bytes | None:
        entry = self._entry(username)
        return entry[0] if entry else None

    def role_of(self, username: str) -> str | None:
        entry = self._entry(username)
        return entry[1] if entry else None

    def satisfies(self, role: str | None, minimum: str) -> bool:
        return ROLE_RANK.get(role, -1) >= ROLE_RANK[minimum]

    def invalidate(self, username: str) -> None:
        """Forget the cached key/role after a password change, role change or
        rename, so the very next request sees the new value rather than
        waiting out the TTL."""
        with self._lock:
            self._keys.pop(username, None)

    def issue_session(self, username: str) -> str:
        key = self._key(username)
        if key is None:
            raise ValueError(f"no such user: {username!r}")
        expiry = int(time.time() + SESSION_HOURS * 3600)
        body = f"{username}:{expiry}"
        sig = hmac.new(key, body.encode(), "sha256").hexdigest()
        return f"{body}:{sig}"

    def verify_session(self, cookie: str | None) -> str | None:
        """Cookie value -> username, or None."""
        if not cookie:
            return None
        try:
            username, expiry_text, sig = cookie.rsplit(":", 2)
            expiry = int(expiry_text)
        except ValueError:
            return None
        key = self._key(username)
        if key is None:
            return None
        body = f"{username}:{expiry}"
        expected = hmac.new(key, body.encode(), "sha256").hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        if expiry < time.time():
            return None
        return username

    # ---------------------------------------------------------------- limiter
    # 8 failures per source address per 5 minutes, in one of two buckets:
    # "login" (passwords) and "oidc" (provider callbacks that failed before
    # or during the code exchange). Separate, so a flood of garbage
    # callbacks cannot lock a person out of their password, and a password
    # flood cannot stop a provider sign-in -- neither says anything about
    # the other.
    _MAX_ATTEMPTS = 8
    _WINDOW_S = 300.0

    def _limited(self, bucket: str, addr: str) -> bool:
        now = time.monotonic()
        with self._lock:
            attempts = [t for t in self._attempts.get((bucket, addr), ())
                        if now - t < self._WINDOW_S]
            self._attempts[(bucket, addr)] = attempts
            if len(attempts) >= self._MAX_ATTEMPTS:
                log.warning("%s rate limit hit from %s", bucket, addr)
                return True
        return False

    def _fail(self, bucket: str, addr: str) -> None:
        with self._lock:
            self._attempts.setdefault((bucket, addr), []).append(time.monotonic())

    def _clear(self, bucket: str, addr: str) -> None:
        with self._lock:
            self._attempts.pop((bucket, addr), None)

    # ------------------------------------------------------------------ login
    def login(self, username: str, password: str, addr: str) -> str | None:
        """Verify credentials; returns a session cookie value or None.

        The limiter is applied before the scrypt work, so a flood cannot
        even spend our CPU.
        """
        if self._limited("login", addr):
            return None
        if self.history.verify_user(username, password):
            self._clear("login", addr)
            log.info("login ok: %s from %s", username, addr)
            return self.issue_session(username)
        self._fail("login", addr)
        log.warning("login failed for %r from %s", username, addr)
        return None

    # ------------------------------------------------------------------- oidc
    def oidc_finish(self, cfg: Any, cookie: str | None, code: str | None,
                    state_param: str | None, error_param: str | None,
                    addr: str, session_user: str | None = None,
                    fetch: oidc.Fetch = oidc.fetch_json,
                    ) -> tuple[str | None, str | None, str]:
        """The whole callback, off the event loop: (username, error code,
        mode). `mode` is "login" or "link" and is known even when the
        rest failed, so the caller knows where to send the browser. Only
        protocol failures (a bad state, a refused exchange) count against
        the limiter -- "no account is linked" is a completed, honest answer,
        not an attack."""
        mode = "login"
        try:
            state = oidc.read_state(cookie, self.secret())
        except oidc.OIDCError as exc:
            self._fail("oidc", addr)
            log.warning("oidc callback from %s: %s", addr, exc.detail)
            return None, exc.code, mode
        mode = "link" if state.get("m") == "link" else "login"
        if self._limited("oidc", addr):
            return None, "rate_limited", mode
        if error_param:
            log.warning("oidc callback from %s: provider said %r", addr,
                        str(error_param)[:64])
            return None, "denied", mode
        try:
            identity = oidc.finish(cfg, state, code or "", state_param, fetch=fetch)
        except oidc.OIDCError as exc:
            self._fail("oidc", addr)
            log.warning("oidc callback from %s: %s (%s)", addr, exc.code, exc.detail)
            return None, exc.code, mode
        if mode == "link":
            user = state.get("u")
            if not user or user != session_user:
                return None, "session", mode
            error = self.oidc_link(user, identity)
            log.info("oidc link for %s from %s: %s", user, addr, error or "ok")
            return (None, error, mode) if error else (user, None, mode)
        user, error = self.oidc_signin(identity, cfg)
        if user:
            self._clear("oidc", addr)
            log.info("oidc login ok: %s (sub %s) from %s", user, identity.sub, addr)
        else:
            log.warning("oidc login refused (%s) for sub %s from %s", error,
                        identity.sub, addr)
        return user, error, mode

    def oidc_signin(self, identity: oidc.Identity, cfg: Any,
                    ) -> tuple[str | None, str | None]:
        """Which account this identity opens: the one it is linked to; else
        the one an admin pre-linked to its (verified) e-mail; else a new one
        when the operator allowed that -- else none, with the reason."""
        h = self.history
        row = h.identity_user(oidc.PROVIDER, identity.sub)
        if row:
            h.touch_identity(oidc.PROVIDER, identity.sub, identity.email, identity.name)
            return row["username"], None
        email = (identity.email or "").strip().lower() or None
        domains = list(getattr(cfg, "oidc_allowed_domains", []) or [])
        if email and h.pending_identity(oidc.PROVIDER, email):
            # An admin named this address. The provider must vouch for it:
            # a pre-link is a promise about an address, not about whoever
            # types it into their profile.
            if not identity.email_verified:
                return None, "email_unverified"
            if not oidc.allowed_domain(email, domains):
                return None, "domain"
            user = h.claim_identity(oidc.PROVIDER, email, identity.sub, identity.name)
            if user:
                return user, None
        if not getattr(cfg, "oidc_auto_create", False):
            return None, "not_linked"
        if domains:
            if not email:
                return None, "domain"
            if not identity.email_verified:
                return None, "email_unverified"
            if not oidc.allowed_domain(email, domains):
                return None, "domain"
        role = getattr(cfg, "oidc_default_role", "viewer") or "viewer"
        for _ in range(2):   # a name race with a concurrent sign-in: once more
            name = derive_username(identity, h.user_exists)
            if not h.add_identity_user(name, role):
                continue
            if h.link_identity(name, oidc.PROVIDER, identity.sub, email, identity.name):
                self.invalidate(name)
                log.info("oidc created user %s (%s) for sub %s", name, role, identity.sub)
                return name, None
            # The subject got linked to someone else between our two
            # queries: that account is the answer, and the empty one goes.
            h.remove_user(name)
            row = h.identity_user(oidc.PROVIDER, identity.sub)
            if row:
                return row["username"], None
            return None, "linked_elsewhere"
        return None, "not_linked"

    def oidc_link(self, username: str, identity: oidc.Identity) -> str | None:
        """Bind a signed-in user's account to the identity that just came
        back. None on success, else the error code."""
        h = self.history
        other = h.identity_user(oidc.PROVIDER, identity.sub)
        if other:
            return None if other["username"] == username else "linked_elsewhere"
        current = h.identity_of(username, oidc.PROVIDER)
        if current:
            if current["subject_set"]:
                return "taken"
            h.unlink_identity(username, oidc.PROVIDER)   # a pending pre-link: replaced
        email = (identity.email or "").strip().lower() or None
        if not h.link_identity(username, oidc.PROVIDER, identity.sub, email, identity.name):
            return "linked_elsewhere"
        return None

    # ------------------------------------------------------------------ agents
    def verify_agent(self, authorization: str | None,
                     addr: str | None) -> str | None:
        """'Bearer <name>.<secret>' -> agent name, or None."""
        if not authorization or not authorization.startswith("Bearer "):
            return None
        name = self.history.verify_agent_token(authorization[7:].strip())
        if name:
            self.history.touch_agent(name, addr)
        return name

    # --------------------------------------------------------------- API keys
    # last_used is a courtesy for the person reviewing their keys, not an
    # audit log: a script polling once a second must not become a SQLite
    # write per request, so it is stamped at most once a minute per key.
    _TOUCH_EVERY_S = 60.0

    def verify_api_key(self, authorization: str | None,
                       addr: str | None) -> dict[str, Any] | None:
        """'Bearer ck_<id>.<secret>' -> {id, name, username, role}, or None.

        `role` is the effective one: the lower of the key's cap and its
        owner's current role. No limiter sits in front of this: the secret
        is 256 random bits, so there is nothing to brute-force, and a
        per-address lockout would let one misconfigured script behind a NAT
        switch off everyone else's automation."""
        if not authorization or not authorization.startswith("Bearer "):
            return None
        token = authorization[7:].strip()
        if not token.startswith(API_KEY_PREFIX):
            return None
        key = self.history.verify_api_key(token)
        if key is None:
            return None
        cap, owner = key.pop("role"), key.pop("owner_role")
        key["role"] = cap if ROLE_RANK.get(cap, -1) <= ROLE_RANK.get(owner, -1) else owner
        now = time.monotonic()
        with self._lock:
            due = now - self._key_touched.get(key["id"], -1e9) >= self._TOUCH_EVERY_S
            if due:
                # Only ids that verified land here, so forged ones cannot
                # grow the map; revoked ones are dropped in forget_api_key.
                self._key_touched[key["id"]] = now
        if due:
            self.history.touch_api_key(key["id"], addr)
        return key

    def forget_api_key(self, key_id: str) -> None:
        with self._lock:
            self._key_touched.pop(key_id, None)

    # -------------------------------------------------------------- gate check
    def gate(self, path: str) -> str:
        """'open' | 'session' | 'agent' for a request path."""
        if path in AGENT_PATHS:
            return "agent"
        if not self.enabled:
            return "open"
        if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
            return "open"
        return "session"


def _clean_name(text: str | None) -> str:
    """Fold a provider's name into the dashboard's username charset
    (letters, digits, '-', '_', '.'; never ':' -- the session cookie splits
    on it) -- accents stripped, lower-cased, edge punctuation dropped, room
    left for a collision suffix."""
    if not text:
        return ""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    kept = "".join(c for c in folded.lower() if c.isalnum() or c in "-_.")
    return kept.strip("-_.")[:40].strip("-_.")


def derive_username(identity: oidc.Identity,
                    exists: Callable[[str], bool]) -> str:
    """A username for an account the provider is creating: the provider's
    own preferred_username, else the e-mail's local part, else the subject
    -- and a numeric suffix when the name is taken (a random one past 20,
    so a flood of sign-ins cannot make this walk)."""
    base = ""
    for candidate in (identity.preferred_username,
                      (identity.email or "").split("@")[0], identity.sub):
        base = _clean_name(candidate)
        if base:
            break
    base = base or "user"
    if not exists(base):
        return base
    for n in range(2, 21):
        name = f"{base}-{n}"
        if not exists(name):
            return name
    return f"{base}-{secrets.token_hex(2)}"


DEFAULT_USER = "admin"
DEFAULT_PASSWORD = "admin"


def ensure_default_user(history: History) -> bool:
    """Guarantee at least one dashboard user so the UI is never unauthenticated.

    If the users table is empty, create `admin`/`admin`. Returns True when it
    created one, so the caller can log a prominent warning: default credentials
    on a network-reachable host are a liability until the password is changed
    (which the Settings > Account panel, or the CLI, can now do from the web).
    """
    if not history.ready or history.user_count() > 0:
        return False
    history.add_user(DEFAULT_USER, DEFAULT_PASSWORD)
    return True


def refuse_exposed_without_users(host: str, history: History) -> str | None:
    """The startup safety check. Returns the refusal message, or None."""
    loopback = host in ("127.0.0.1", "::1", "localhost")
    if loopback or not history.ready:
        return None
    if history.user_count() == 0:
        return (
            f"refusing to bind {host}: no dashboard users exist, and an "
            "unauthenticated dashboard must not be network-reachable. Create "
            "one first:  .venv/bin/python -m culprit users add <name>"
        )
    return None
