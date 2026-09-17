"""Sign in with an OpenID Connect provider (Authentik).

The protocol half of provider sign-in, host-only and stdlib-only. auth.py
owns what happens to the person afterwards (which account, whether one is
created); main.py owns the two public routes. This module knows nothing
about users: it turns a configured issuer into an authorization URL and a
callback into a verified `Identity`.

Authorization code flow with PKCE (S256), a signed state cookie, and a
nonce. **Why no JOSE library:** the ID token is read straight out of the
token endpoint's response, over TLS, from the endpoint the issuer's own
discovery document named -- OIDC Core 3.1.3.7 (step 6) allows a client that
receives the ID token this way to rely on the TLS server validation instead
of checking the token's signature. So the claims are checked (iss, aud/azp,
exp, nonce, sub) and then cross-checked against the userinfo endpoint under
the access token, whose `sub` must agree, and nothing needs RSA. The price
is that the issuer must be https:// (http only for a loopback issuer, which
is a development setup), and `Discovery` enforces it.

Every failure is one of the short codes in ERRORS: they are what the login
page renders, and what rides in the redirect URL -- never a provider's own
message, which is not this host's to echo.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

log = logging.getLogger("culprit.oidc")

PROVIDER = "oidc"
STATE_COOKIE = "culprit_oidc"
STATE_TTL_S = 600
# The cookie is scoped to this prefix: it is only ever read by the callback.
STATE_PATH = "/api/auth/oidc"
START_PATH = "/api/auth/oidc/start"
CALLBACK_PATH = "/api/auth/oidc/callback"

DISCOVERY_TTL_S = 3600.0
DISCOVERY_RETRY_S = 30.0
TIMEOUT_S = 10.0
MAX_BODY = 256 * 1024
CLOCK_SKEW_S = 60

ERRORS: dict[str, str] = {
    "disabled": "Signing in with a provider is not set up on this host.",
    "state": "The sign-in did not start here, or the browser dropped its "
             "state cookie. Try again.",
    "expired": "The sign-in took longer than ten minutes. Try again.",
    "denied": "The provider did not approve the sign-in.",
    "rate_limited": "Too many sign-in attempts from your address -- wait a "
                    "few minutes.",
    "discovery": "The provider could not be reached, or its configuration "
                 "is not what this host expects.",
    "exchange": "The provider refused to exchange the sign-in code.",
    "id_token": "The provider's ID token was not issued for this host, or "
                "could not be read.",
    "nonce": "The provider's ID token did not answer this sign-in.",
    "userinfo": "The provider would not confirm who signed in.",
    "not_linked": "No account here is linked to that identity, and this host "
                  "does not create accounts on first sign-in. Ask an admin "
                  "to link your e-mail address.",
    "domain": "That e-mail domain is not allowed to sign in here.",
    "email_unverified": "The provider does not vouch for that e-mail address, "
                        "so it cannot claim an account here.",
    "linked_elsewhere": "That identity is already linked to another account.",
    "taken": "This account is already linked to a provider identity.",
    "session": "You are no longer signed in as the account you started "
               "linking.",
}


class OIDCError(Exception):
    """A failure with a fixed code (a key of ERRORS) and a detail that goes
    to the log only."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass
class Identity:
    """Who the provider says signed in. `sub` is the only stable key;
    everything else is descriptive and may change between sign-ins."""
    sub: str
    email: str | None = None
    email_verified: bool | None = None
    preferred_username: str | None = None
    name: str | None = None


def error_text(code: str | None) -> str:
    return ERRORS.get(code or "", ERRORS["state"])


# ----------------------------------------------------------------- config
def configured(cfg: Any) -> bool:
    """Enabled *and* every field the flow needs. The login button and the
    start route both key off this, so a half-filled form never renders a
    button that leads nowhere."""
    return bool(getattr(cfg, "oidc_enabled", False)
                and getattr(cfg, "oidc_issuer", "")
                and getattr(cfg, "oidc_client_id", "")
                and getattr(cfg, "oidc_client_secret", ""))


def missing(cfg: Any) -> list[str]:
    """Which of the required fields are blank -- for the Settings page."""
    return [key for key in ("oidc_issuer", "oidc_client_id", "oidc_client_secret")
            if not getattr(cfg, key, "")]


def is_loopback_url(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host in ("localhost", "127.0.0.1", "::1")


def issuer_problem(url: str) -> str | None:
    """Why a URL cannot be the issuer, or None. https is not a preference:
    the whole no-signature argument above rests on it."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme == "https" and parts.netloc:
        return None
    if parts.scheme == "http" and is_loopback_url(url):
        return None
    return "must be an https:// URL (http:// only for a loopback issuer)"


# ------------------------------------------------------------------ fetch
class FetchError(Exception):
    def __init__(self, message: str, status: int | None = None,
                 body: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body or {}


Fetch = Callable[..., dict[str, Any]]


def fetch_json(url: str, *, data: bytes | None = None,
               headers: dict[str, str] | None = None,
               timeout: float = TIMEOUT_S) -> dict[str, Any]:
    """One HTTPS request answering JSON. Bounded read; an HTTP error's JSON
    body (the token endpoint's `{"error": ...}`) rides the exception for
    the log. This is the one seam tools/check_auth.py replaces."""
    request = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", "culprit")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_BODY + 1)
    except urllib.error.HTTPError as exc:
        body: dict[str, Any] = {}
        try:
            parsed = json.loads(exc.read(MAX_BODY))
            if isinstance(parsed, dict):
                body = parsed
        except (ValueError, OSError):
            pass
        raise FetchError(f"HTTP {exc.code}", exc.code, body) from None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise FetchError(str(exc)) from None
    if len(raw) > MAX_BODY:
        raise FetchError("response too large")
    try:
        parsed = json.loads(raw)
    except ValueError:
        raise FetchError("not JSON") from None
    if not isinstance(parsed, dict):
        raise FetchError("not a JSON object")
    return parsed


# -------------------------------------------------------------- discovery
_REQUIRED_ENDPOINTS = ("authorization_endpoint", "token_endpoint",
                       "userinfo_endpoint")


class Discovery:
    """The issuer's openid-configuration, cached per issuer for an hour, and
    for half a minute after a failure so a flapping provider is not asked
    on every sign-in attempt."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict[str, Any] | None, str]] = {}

    def get(self, issuer: str, fetch: Fetch = fetch_json,
            force: bool = False) -> dict[str, Any]:
        issuer = issuer.strip()
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(issuer)
        if cached and not force:
            at, doc, reason = cached
            if doc is not None and now - at < DISCOVERY_TTL_S:
                return doc
            if doc is None and now - at < DISCOVERY_RETRY_S:
                raise OIDCError("discovery", reason)
        try:
            doc = self._load(issuer, fetch)
        except OIDCError as exc:
            with self._lock:
                self._cache[issuer] = (now, None, exc.detail)
            raise
        with self._lock:
            self._cache[issuer] = (now, doc, "")
        return doc

    def _load(self, issuer: str, fetch: Fetch) -> dict[str, Any]:
        problem = issuer_problem(issuer)
        if problem:
            raise OIDCError("discovery", f"issuer {problem}")
        url = issuer.rstrip("/") + "/.well-known/openid-configuration"
        try:
            doc = fetch(url)
        except FetchError as exc:
            raise OIDCError("discovery", f"{url}: {exc}") from None
        published = str(doc.get("issuer") or "")
        if published.rstrip("/") != issuer.rstrip("/"):
            raise OIDCError("discovery", f"document names issuer {published!r}, "
                                         f"configured {issuer!r}")
        loopback = is_loopback_url(issuer)
        for key in _REQUIRED_ENDPOINTS:
            endpoint = doc.get(key)
            if not isinstance(endpoint, str) or not endpoint:
                raise OIDCError("discovery", f"no {key}")
            scheme = urllib.parse.urlsplit(endpoint).scheme
            if scheme != "https" and not (loopback and scheme == "http"):
                raise OIDCError("discovery", f"{key} is not https")
        return doc


_discovery = Discovery()


def discover(issuer: str, fetch: Fetch = fetch_json,
             force: bool = False) -> dict[str, Any]:
    return _discovery.get(issuer, fetch, force)


def summary(doc: dict[str, Any]) -> dict[str, Any]:
    """What the Settings page's *Check issuer* shows: the endpoints and
    whether PKCE S256 is advertised. No secrets are anywhere near this."""
    methods = doc.get("code_challenge_methods_supported") or []
    return {
        "issuer": doc.get("issuer"),
        "authorization_endpoint": doc.get("authorization_endpoint"),
        "token_endpoint": doc.get("token_endpoint"),
        "userinfo_endpoint": doc.get("userinfo_endpoint"),
        "end_session_endpoint": doc.get("end_session_endpoint"),
        "pkce_s256": "S256" in methods if isinstance(methods, list) else None,
        "scopes_supported": doc.get("scopes_supported"),
    }


# ------------------------------------------------------------ state cookie
def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _state_key(secret: bytes) -> bytes:
    # Derived, so the install secret itself signs nothing but what auth.py
    # signs with it.
    return hmac.new(secret, b"oidc-state", "sha256").digest()


def sign_state(payload: dict[str, Any], secret: bytes) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(_state_key(secret), body.encode(), "sha256").hexdigest()
    return f"{body}.{sig}"


def read_state(cookie: str | None, secret: bytes) -> dict[str, Any]:
    """The state payload, or OIDCError('state' | 'expired')."""
    if not cookie or "." not in cookie or len(cookie) > 4096:
        raise OIDCError("state", "no state cookie")
    body, _, sig = cookie.rpartition(".")
    expected = hmac.new(_state_key(secret), body.encode(), "sha256").hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise OIDCError("state", "state cookie signature mismatch")
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, TypeError):
        raise OIDCError("state", "state cookie unreadable") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("s"), str):
        raise OIDCError("state", "state cookie malformed")
    if not isinstance(payload.get("exp"), (int, float)) or payload["exp"] < time.time():
        raise OIDCError("expired", "state cookie expired")
    return payload


def pkce_challenge(verifier: str) -> str:
    return _b64(hashlib.sha256(verifier.encode()).digest())


def begin(cfg: Any, *, redirect_uri: str, secret: bytes, mode: str = "login",
          user: str | None = None, fetch: Fetch = fetch_json) -> tuple[str, str]:
    """(authorization URL, state cookie value). The redirect URI rides in the
    cookie so the token exchange repeats exactly what the authorization
    request said, which the provider checks."""
    if not configured(cfg):
        raise OIDCError("disabled")
    doc = discover(cfg.oidc_issuer, fetch)
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    payload: dict[str, Any] = {
        "s": state, "n": nonce, "v": verifier, "m": mode, "r": redirect_uri,
        "exp": int(time.time() + STATE_TTL_S),
    }
    if user:
        payload["u"] = user
    query = {
        "response_type": "code",
        "client_id": cfg.oidc_client_id,
        "redirect_uri": redirect_uri,
        "scope": cfg.oidc_scopes or "openid",
        "state": state,
        "nonce": nonce,
        "code_challenge": pkce_challenge(verifier),
        "code_challenge_method": "S256",
    }
    base = doc["authorization_endpoint"]
    joiner = "&" if "?" in base else "?"
    return base + joiner + urllib.parse.urlencode(query), sign_state(payload, secret)


# ---------------------------------------------------------------- callback
def _basic_auth(client_id: str, client_secret: str) -> str:
    # RFC 6749 2.3.1: the credentials are form-urlencoded before base64.
    pair = f"{urllib.parse.quote(client_id, safe='')}:" \
           f"{urllib.parse.quote(client_secret, safe='')}"
    return "Basic " + base64.b64encode(pair.encode()).decode()


def id_token_claims(id_token: str) -> dict[str, Any]:
    """The payload segment of a JWT, read without checking its signature --
    see the module docstring for why that is sound *only* for a token that
    arrived from the token endpoint over TLS."""
    parts = id_token.split(".")
    if len(parts) != 3:
        raise OIDCError("id_token", "not a JWT")
    try:
        claims = json.loads(_unb64(parts[1]))
    except (ValueError, TypeError):
        raise OIDCError("id_token", "payload unreadable") from None
    if not isinstance(claims, dict):
        raise OIDCError("id_token", "payload not an object")
    return claims


def check_claims(claims: dict[str, Any], *, issuer: str, client_id: str,
                 nonce: str, now: float | None = None) -> None:
    now = time.time() if now is None else now
    if claims.get("iss") != issuer:
        raise OIDCError("id_token", f"iss {claims.get('iss')!r} != {issuer!r}")
    aud = claims.get("aud")
    audiences = aud if isinstance(aud, list) else [aud]
    if client_id not in audiences:
        raise OIDCError("id_token", "aud does not name this client")
    if len(audiences) > 1 and claims.get("azp") != client_id:
        raise OIDCError("id_token", "azp does not name this client")
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp + CLOCK_SKEW_S < now:
        raise OIDCError("id_token", "expired")
    iat = claims.get("iat")
    if isinstance(iat, (int, float)) and iat - CLOCK_SKEW_S > now:
        raise OIDCError("id_token", "issued in the future")
    if not isinstance(claims.get("nonce"), str) or \
            not hmac.compare_digest(claims["nonce"], nonce):
        raise OIDCError("nonce", "nonce mismatch")
    if not isinstance(claims.get("sub"), str) or not claims["sub"]:
        raise OIDCError("id_token", "no sub")


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def finish(cfg: Any, state: dict[str, Any], code: str, state_param: str | None,
           *, fetch: Fetch = fetch_json) -> Identity:
    """The callback's half: state → code exchange → claims → userinfo."""
    if not configured(cfg):
        raise OIDCError("disabled")
    if not isinstance(state_param, str) or \
            not hmac.compare_digest(state_param, state.get("s", "")):
        raise OIDCError("state", "state parameter mismatch")
    if not isinstance(code, str) or not code or len(code) > 4096:
        raise OIDCError("exchange", "no code")
    doc = discover(cfg.oidc_issuer, fetch)
    form = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": state.get("r", ""),
        "code_verifier": state.get("v", ""),
    }).encode()
    try:
        token = fetch(doc["token_endpoint"], data=form, headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": _basic_auth(cfg.oidc_client_id, cfg.oidc_client_secret),
        })
    except FetchError as exc:
        raise OIDCError("exchange", f"{exc}: {exc.body.get('error', '')}") from None
    id_token = token.get("id_token")
    access_token = token.get("access_token")
    if not isinstance(id_token, str) or not isinstance(access_token, str):
        raise OIDCError("exchange", "no id_token/access_token in the response")
    claims = id_token_claims(id_token)
    check_claims(claims, issuer=str(doc.get("issuer")), client_id=cfg.oidc_client_id,
                 nonce=str(state.get("n", "")))
    try:
        info = fetch(doc["userinfo_endpoint"],
                     headers={"Authorization": f"Bearer {access_token}"})
    except FetchError as exc:
        raise OIDCError("userinfo", str(exc)) from None
    if info.get("sub") != claims["sub"]:
        raise OIDCError("userinfo", "userinfo sub differs from the ID token's")
    merged = {**claims, **info}   # userinfo wins on profile fields
    verified = merged.get("email_verified")
    return Identity(
        sub=claims["sub"],
        email=_text(merged.get("email")),
        email_verified=verified if isinstance(verified, bool) else None,
        preferred_username=_text(merged.get("preferred_username")),
        name=_text(merged.get("name")),
    )


def allowed_domain(email: str | None, domains: list[str]) -> bool:
    """True when no list is configured, or the address's domain is on it."""
    if not domains:
        return True
    if not email or "@" not in email:
        return False
    domain = email.rsplit("@", 1)[1].strip().lower()
    return domain in {d.lower() for d in domains}
