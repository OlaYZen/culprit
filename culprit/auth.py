"""Authentication for the dashboard and the agent ingest endpoint.

Two independent mechanisms, because the two callers are different animals:

* **People** sign in with a username/password (scrypt-hashed in SQLite -- see
  db.py) and get an HMAC-signed session cookie: `user:expiry:signature`,
  signed with a per-installation secret stored in the database. Stateless, so
  sessions survive restarts and there is no session table to leak or prune.
* **Agents** authenticate every report with a bearer token `<name>.<secret>`;
  only the SHA-256 of the secret is stored. A token identifies exactly one
  node and can be revoked without touching any other.

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
import threading
import time

from .db import History

log = logging.getLogger("culprit.auth")

SESSION_COOKIE = "culprit_session"
SESSION_HOURS = 24 * 7

# Paths reachable without a session. Everything else under / is gated when
# auth is enabled. The agent report endpoint has its own bearer check.
PUBLIC_PATHS = frozenset({
    "/login", "/api/login", "/api/auth", "/api/healthz", "/favicon.svg",
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
    def issue_session(self, username: str) -> str:
        expiry = int(time.time() + SESSION_HOURS * 3600)
        body = f"{username}:{expiry}"
        sig = hmac.new(self.secret(), body.encode(), "sha256").hexdigest()
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
        body = f"{username}:{expiry}"
        expected = hmac.new(self.secret(), body.encode(), "sha256").hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        if expiry < time.time():
            return None
        return username

    # ------------------------------------------------------------------ login
    _MAX_ATTEMPTS = 8
    _WINDOW_S = 300.0

    def login(self, username: str, password: str, addr: str) -> str | None:
        """Verify credentials; returns a session cookie value or None.

        Rate limit: 8 failures per source address per 5 minutes. Applied
        before the scrypt work, so a flood cannot even spend our CPU.
        """
        now = time.monotonic()
        with self._lock:
            attempts = [t for t in self._attempts.get(addr, ())
                        if now - t < self._WINDOW_S]
            self._attempts[addr] = attempts
            if len(attempts) >= self._MAX_ATTEMPTS:
                log.warning("login rate limit hit from %s", addr)
                return None
        if self.history.verify_user(username, password):
            with self._lock:
                self._attempts.pop(addr, None)
            log.info("login ok: %s from %s", username, addr)
            return self.issue_session(username)
        with self._lock:
            self._attempts.setdefault(addr, []).append(now)
        log.warning("login failed for %r from %s", username, addr)
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
