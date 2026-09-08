"""FastAPI application: routes, SSE stream, static hosting.

Every read endpoint serves from the in-memory store rather than sampling on
demand, so request cost is dict serialisation and nothing else. The only
handlers that touch the OS are the ones that must: a single process's detail
(too expensive to collect for 400 processes every tick) and the two action
endpoints.
"""

from __future__ import annotations

import asyncio
import json as json_module
import logging
import os
import re
import threading
import time
import webbrowser
import zlib
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import (FileResponse, JSONResponse, PlainTextResponse,
                               RedirectResponse, StreamingResponse)
from fastapi.staticfiles import StaticFiles

from . import __version__
from . import config as config_module
from . import trust
from .auth import SESSION_COOKIE, Auth, ensure_default_user
from .coroner import Coroner
from .db import LOCAL_NODE, ROLES, History
from .expect import Expectations
from .fleetmap import FleetMap
from .expect import validate as validate_expectation
from . import nodes as nodes_module
from .nodes import MAX_REPORT_BYTES, CommandBroker, NodeRegistry
from . import changelog, portnames
from .notify import Notifier
from .pulse import Pulse
from .verdict import ActionVerifier
from .sampler import LIVE_KEYS, Sampler
from .state import Broker, Store
from .util import is_elevated

log = logging.getLogger("culprit")

store = Store()
broker = Broker()
history: History | None = None
sampler: Sampler | None = None
auth: Auth | None = None
registry: NodeRegistry | None = None
commands: CommandBroker | None = None
expectations: Expectations | None = None
verifier: ActionVerifier | None = None
notifier: Notifier | None = None
coroner: Coroner | None = None
fleetmap: FleetMap | None = None
pulse: Pulse | None = None


async def _sweep_loop() -> None:
    """Housekeeping the ingest path cannot do: verdicts whose node went quiet,
    notifications for findings that resolved or nodes that stopped reporting,
    the daily auto-update schedule."""
    while True:
        await asyncio.sleep(15.0)
        try:
            if verifier is not None:
                verifier.sweep()
            if notifier is not None:
                notifier.sweep()
            if registry is not None:
                # A blocking GET (one fetch for the whole fleet, not one per
                # agent) -- off the event loop thread. refresh_remote_version
                # itself no-ops until REMOTE_VERSION_REFRESH_S has passed.
                await asyncio.get_running_loop().run_in_executor(
                    None, registry.refresh_remote_version, config_module.get().agent_update_branch)
            if pulse is not None:
                # Its own retention, rate-limited to once an hour inside
                # History -- the rhythm outlives the metric history.
                pulse.prune()
            _maybe_auto_update()
        except Exception:  # noqa: BLE001 -- housekeeping must not die
            log.exception("sweep failed")


def _maybe_auto_update() -> None:
    """The entire schedule mechanism: the agent is never handed a schedule,
    only ever the same "update" command the manual button sends, fired here
    at a host-decided time. At most once a day per node (History.mark_auto_
    updated claims the slot atomically), and only for a node that has told us
    it is both update_capable and update_available -- no point restarting a
    process that is already current."""
    cfg = config_module.get()
    if not cfg.auto_update_enabled or history is None or registry is None:
        return
    now = time.localtime()
    if now.tm_hour != cfg.auto_update_hour:
        return
    today = time.strftime("%Y-%m-%d", now)
    for meta in registry.status_list():
        if not meta.get("enabled"):
            continue
        if meta.get("update_capable") is not True:
            continue
        if meta.get("update_available") is not True:
            continue
        if meta.get("pinned_version"):
            continue  # an operator put it there; only an explicit action moves it
        if meta.get("update_self_broken"):
            continue  # a build whose updater never worked; the command would fail daily
        if not history.mark_auto_updated(str(meta["name"]), today):
            continue  # already updated today, or the claim lost a race
        asyncio.get_running_loop().create_task(
            _run_scheduled_update(str(meta["name"])))


def _update_payload(**extra: Any) -> dict[str, Any]:
    """Every update command names the branch agents are meant to run, so an
    agent on another line switches rather than pulling its own branch."""
    return {"branch": config_module.get().agent_update_branch or "main", **extra}


async def _run_scheduled_update(name: str) -> None:
    try:
        result = await _agent_command(name, "update", _update_payload(),
                                      timeout_override=UPDATE_TIMEOUT_S)
        log.info("scheduled update on '%s' -> %s", name, result)
    except HTTPException as exc:
        log.warning("scheduled update on '%s' failed: %s", name, exc.detail)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global history, auth, registry, commands, expectations, verifier, notifier, coroner, fleetmap, pulse
    cfg = config_module.load()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    store.ring.set_window(cfg.live_window_seconds)
    # The database also holds credentials now, so it opens even when metric
    # history is off -- set_enabled() only gates the rollup writes.
    history = History(cfg.resolved_db_path, enabled=True)
    history.set_enabled(cfg.persist_history)
    # Never leave the dashboard unauthenticated: a fresh install with no users
    # gets a default admin/admin (the CLI's _serve does the same before binding).
    if ensure_default_user(history):
        log.warning("SECURITY: no users existed -- created default admin/admin. "
                    "Change the password in Settings > Account now.")
    auth = Auth(history)
    registry = NodeRegistry(history, rollup_seconds=cfg.rollup_seconds,
                            history_top=cfg.history_top_processes)
    commands = CommandBroker()
    expectations = Expectations(history)
    verifier = ActionVerifier(history)
    notifier = Notifier()
    # The operator's "not always on" marks survive a restart in the agents
    # table; the notifier must know them before its first sweep, or a node
    # that is off at startup would be reported as gone.
    for agent in history.list_agents():
        registry.set_intermittent(str(agent["name"]), bool(agent.get("intermittent")))
        if agent.get("intermittent"):
            notifier.set_intermittent(str(agent["name"]), True)
    coroner = Coroner(history, notifier)
    registry.expectations = expectations
    registry.verifier = verifier
    registry.notifier = notifier
    registry.coroner = coroner
    pulse = Pulse(history, expectations)
    registry.pulse = pulse
    fleetmap = FleetMap(registry)
    sweeper = asyncio.get_running_loop().create_task(_sweep_loop())
    # This host is an aggregator + dashboard only: it ingests external agents
    # and serves the UI, and no longer samples its own machine. So the local
    # sampler is not started and the host never appears as a node -- there is
    # nothing to warm up, so mark ready immediately (otherwise the dashboard
    # would wait forever on a warm-up that never completes).
    store.warm = True
    store.warmup_stage = "Ready"

    if cfg.open_browser and not os.environ.get("CULPRIT_NO_BROWSER"):
        # Delay slightly so the first paint has data to render, and use a thread
        # because webbrowser.open blocks while the browser starts.
        threading.Timer(
            0.8,
            lambda: webbrowser.open(
                f"http://{_display_host(cfg.effective_host)}:{cfg.effective_port}/"
            ),
        ).start()

    log.info("culprit host listening on http://%s:%d/  (auth=%s, elevated=%s)",
             _display_host(cfg.effective_host), cfg.effective_port,
             "on" if auth.enabled else "off (no users)", is_elevated())
    try:
        yield
    finally:
        sweeper.cancel()
        if registry is not None:
            registry.flush_all()
        if sampler is not None:
            await sampler.stop()


app = FastAPI(
    title="Culprit",
    description="Live Linux health, process and event monitoring.",
    version=__version__,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
    # No OAuth2 flows here, so the Swagger helper page it would add is one
    # more route for nothing.
    swagger_ui_oauth2_redirect_url=None,
    openapi_url="/api/openapi.json",
)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request,  # noqa: ANN201
                           exc: RequestValidationError):
    """A 422 that describes the problem without echoing the input.

    FastAPI's default body repeats the submitted value in each error, which
    (a) puts a mistyped password into a response that proxies and browsers
    log, and (b) is not always serialisable: a JSON body carrying 1e400 or
    NaN parses to a float that json.dumps refuses, so the *error response*
    itself failed with a 500. tools/check_security.py sends both.
    """
    errors = [{"loc": list(e.get("loc", ())), "msg": str(e.get("msg", "")),
               "type": str(e.get("type", ""))} for e in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


# --------------------------------------------------------------------- auth
@app.middleware("http")
async def auth_middleware(request: Request, call_next):  # noqa: ANN001, ANN201
    """One gate for everything.

    * Agent reports carry a bearer token, checked in their endpoint (it needs
      the body anyway); the middleware only routes them past the session gate.
    * With no users in the database, auth is off -- but __main__ refuses to
      bind a non-loopback address in that state, so "off" can only ever mean
      "off on localhost".
    """
    if auth is None:  # startup race: nothing is served before lifespan runs
        return await call_next(request)
    # Network trust first: who the peer is decides whether the forwarding
    # headers mean anything, and that decides the address the limiter sees.
    cfg = config_module.get()
    access = trust.resolve(
        request.client.host if request.client else None, request.headers,
        trust.policy(cfg.trusted_proxies, cfg.trusted_hosts),
        scheme=request.url.scheme)
    request.state.access = access
    if access.refusal:
        return _harden(request, _refuse(request, access))
    if access.via_proxy:
        # Rewrite the scope the way uvicorn's own proxy middleware would, so
        # every handler's request.client / request.url sees the real client
        # and scheme -- but only after the peer proved to be a declared proxy.
        request.scope["client"] = (access.client, 0)
        request.scope["scheme"] = access.scheme
    gate = auth.gate(request.url.path)
    response = None
    if gate == "session":
        user = auth.verify_session(request.cookies.get(SESSION_COOKIE))
        if user is None:
            if request.url.path.startswith("/api/"):
                response = JSONResponse({"detail": "authentication required"},
                                        status_code=401)
            else:
                response = RedirectResponse("/login", status_code=303)
        else:
            request.state.user = user
            request.state.role = auth.role_of(user)
    if response is None:
        response = await call_next(request)
    return _harden(request, response)


_refusals_logged: dict[tuple[str, str], float] = {}


def _refuse(request: Request, access: trust.Access):  # noqa: ANN201
    """400 for a request whose network path is not trusted. Logged once a
    minute per peer and reason: an undeclared proxy would otherwise write a
    line per SSE reconnect."""
    key = (access.peer, access.reason or "")
    now = time.monotonic()
    if now - _refusals_logged.get(key, 0.0) > 60.0:
        _refusals_logged[key] = now
        log.warning("refused %s %s from %s: %s", request.method,
                    request.url.path, access.peer, access.refusal)
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": access.refusal, "reason": access.reason},
                            status_code=400)
    return PlainTextResponse(access.refusal + "\n", status_code=400)


def require_role(minimum: str):
    """A route dependency: 403 unless the signed-in session's role is at
    least `minimum`. Declared as `dependencies=[Depends(require_role(...))]`
    on the route itself (never called imperatively from inside a handler) so
    a route's access level is a property of the route -- readable straight
    off `app.routes` by anything that walks them, `tools/check_role_matrix.py`
    included, the same way `EXPECTED_PUBLIC_PATHS` there mirrors the public
    gate instead of trusting a route to remember to check itself.

    With auth off there is no user concept at all -- and __main__ refuses to
    bind a non-loopback address in that state -- so "off" means everyone
    reaching this process already has full access, same as before roles
    existed. A route with no such dependency needs nothing more than a
    session -- the default every gated route already had before roles
    existed, i.e. `viewer`.
    """
    async def _dep(request: Request) -> None:
        if auth is None or not auth.enabled:
            return
        role = getattr(request.state, "role", None)
        if not auth.satisfies(role, minimum):
            raise HTTPException(403, f"requires {minimum} access")
    _dep.minimum_role = minimum  # read by tools/check_role_matrix.py
    return _dep


def _harden(request: Request, response):  # noqa: ANN001, ANN201
    """Defensive headers on every response, including the gate's own 401/303.

    The dashboard is a page with an End-task button that acts on real
    machines, so it must not be frameable (clickjacking) and its JSON must not
    survive in a shared browser's cache. `setdefault` so a handler that set
    its own value (the SSE stream's no-cache) keeps it. tools/check_security.py
    asserts these are present on the wire.
    """
    headers = response.headers
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("X-Frame-Options", "DENY")
    headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
    headers.setdefault("Referrer-Policy", "same-origin")
    if request.url.path.startswith("/api/"):
        headers.setdefault("Cache-Control", "no-store")
    return response


@app.get("/login", include_in_schema=False)
async def login_page() -> FileResponse:
    return FileResponse(config_module.WEB_DIR / "login.html",
                        headers={"Cache-Control": "no-cache"})


@app.post("/api/login")
async def api_login(
    request: Request,
    username: str = Body(..., embed=True),
    password: str = Body(..., embed=True),
) -> JSONResponse:
    assert auth is not None
    if not auth.enabled:
        return JSONResponse({"ok": True, "auth": False,
                             "note": "no users exist; authentication is off"})
    addr = request.client.host if request.client else "?"
    cookie = await asyncio.get_running_loop().run_in_executor(
        None, auth.login, username, password, addr)
    if cookie is None:
        raise HTTPException(401, "wrong username or password (or too many "
                                 "attempts -- wait a few minutes)")
    response = JSONResponse({"ok": True, "auth": True, "username": username})
    response.set_cookie(
        SESSION_COOKIE, cookie,
        httponly=True, samesite="lax",
        secure=request.url.scheme == "https",
        max_age=7 * 24 * 3600, path="/",
    )
    return response


@app.post("/api/logout")
async def api_logout() -> JSONResponse:
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@app.get("/api/auth", summary="Whether auth is on, and who is signed in")
async def api_auth(request: Request) -> dict[str, Any]:
    assert auth is not None
    user = auth.verify_session(request.cookies.get(SESSION_COOKIE))
    role = auth.role_of(user) if user else None
    return {"enabled": auth.enabled, "username": user, "role": role}


# ------------------------------------------------------------------- account
# Session-gated (they live under /api/ and are not public), so request.state.user
# is the signed-in account. Both re-verify the current password: changing a
# credential is exactly where a borrowed, still-signed-in session should have to
# prove it is the account owner.
@app.post("/api/account/password", summary="Change the signed-in user's password")
async def api_account_password(
    request: Request,
    current_password: str = Body(..., embed=True),
    new_password: str = Body(..., embed=True),
) -> JSONResponse:
    assert auth is not None and history is not None
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "not signed in")
    loop = asyncio.get_running_loop()
    if not await loop.run_in_executor(None, history.verify_user, user,
                                      current_password):
        raise HTTPException(403, "current password is incorrect")
    if len(new_password) < 8:
        raise HTTPException(422, "new password must be at least 8 characters")
    if not history.set_password(user, new_password):
        raise HTTPException(500, "could not update the password")
    log.info("password changed for %s", user)
    # Sessions are signed with the password hash, so this change just
    # revoked every session for the account -- including the one making the
    # request. Re-issue it: the person who changed the password stays in,
    # anyone else holding a copied cookie is out.
    auth.invalidate(user)
    response = JSONResponse({"ok": True})
    response.set_cookie(
        SESSION_COOKIE, auth.issue_session(user),
        httponly=True, samesite="lax",
        secure=request.url.scheme == "https",
        max_age=7 * 24 * 3600, path="/",
    )
    return response


@app.post("/api/account/username", summary="Rename the signed-in user")
async def api_account_username(
    request: Request,
    new_username: str = Body(..., embed=True),
    current_password: str = Body(..., embed=True),
) -> JSONResponse:
    assert auth is not None and history is not None
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "not signed in")
    new_username = new_username.strip()
    if not (1 <= len(new_username) <= 48) or \
            not all(c.isalnum() or c in "-_." for c in new_username):
        raise HTTPException(422, "username must be 1-48 characters: letters, "
                                 "digits, '-', '_' and '.' only")
    loop = asyncio.get_running_loop()
    if not await loop.run_in_executor(None, history.verify_user, user,
                                      current_password):
        raise HTTPException(403, "current password is incorrect")
    if new_username == user:
        return JSONResponse({"ok": True, "username": user})
    if history.user_exists(new_username):
        raise HTTPException(409, f"a user named '{new_username}' already exists")
    if not history.rename_user(user, new_username):
        raise HTTPException(500, "could not rename the account")
    log.info("user renamed: %s -> %s", user, new_username)
    # The session cookie encodes the username, so re-issue it for the new name;
    # the current session would otherwise point at an account that no longer
    # exists.
    response = JSONResponse({"ok": True, "username": new_username})
    response.set_cookie(
        SESSION_COOKIE, auth.issue_session(new_username),
        httponly=True, samesite="lax",
        secure=request.url.scheme == "https",
        max_age=7 * 24 * 3600, path="/",
    )
    return response


# --------------------------------------------------------------------- users
# Admin-only management of *other* accounts, mirroring the /api/agents CRUD
# shape below. Self-service (your own password/username) is the account
# endpoints above, open to every role.
@app.get("/api/users", summary="Dashboard users and their roles",
         dependencies=[Depends(require_role("admin"))])
async def api_users(request: Request) -> dict[str, Any]:
    assert history is not None
    return {"users": history.list_users()}


@app.post("/api/users", summary="Create a dashboard user",
          dependencies=[Depends(require_role("admin"))])
async def api_user_create(
    request: Request,
    username: str = Body(..., embed=True),
    password: str = Body(..., embed=True),
    role: str = Body(..., embed=True),
) -> dict[str, Any]:
    assert history is not None
    username = username.strip()
    if not (1 <= len(username) <= 48) or \
            not all(c.isalnum() or c in "-_." for c in username):
        raise HTTPException(422, "username must be 1-48 characters: letters, "
                                 "digits, '-', '_' and '.' only")
    if role not in ROLES:
        raise HTTPException(422, f"role must be one of {', '.join(ROLES)}")
    if len(password) < 8:
        raise HTTPException(422, "password must be at least 8 characters")
    if history.user_exists(username):
        raise HTTPException(409, f"a user named '{username}' already exists")
    history.add_user(username, password, role)
    log.info("user '%s' created as %s by %s", username, role,
             getattr(request.state, "user", "?"))
    return {"ok": True, "username": username, "role": role}


@app.put("/api/users/{name}/role", summary="Change a user's role",
         dependencies=[Depends(require_role("admin"))])
async def api_user_role(name: str, request: Request,
                        role: str = Body(..., embed=True)) -> dict[str, Any]:
    assert history is not None and auth is not None
    if role not in ROLES:
        raise HTTPException(422, f"role must be one of {', '.join(ROLES)}")
    if not history.set_role(name, role):
        if not history.user_exists(name):
            raise HTTPException(404, f"no such user '{name}'")
        raise HTTPException(409, "refusing: this would leave no admin account")
    auth.invalidate(name)
    log.info("user '%s' role changed to %s by %s", name, role,
             getattr(request.state, "user", "?"))
    return {"ok": True, "username": name, "role": role}


@app.delete("/api/users/{name}", summary="Remove a dashboard user",
            dependencies=[Depends(require_role("admin"))])
async def api_user_delete(name: str, request: Request) -> dict[str, Any]:
    assert history is not None and auth is not None
    if name == getattr(request.state, "user", None):
        raise HTTPException(
            409, "cannot remove your own account -- sign in as another "
                 "admin, or remove it from the CLI")
    if not history.remove_user(name):
        if not history.user_exists(name):
            raise HTTPException(404, f"no such user '{name}'")
        raise HTTPException(409, "refusing: this would leave no admin account")
    auth.invalidate(name)
    log.info("user '%s' removed by %s", name, getattr(request.state, "user", "?"))
    return {"ok": True, "username": name}


# ------------------------------------------------------------------- agents
@app.post("/api/agents/report", summary="Agent ingest (bearer token)")
async def api_agent_report(request: Request) -> dict[str, Any]:
    assert auth is not None and registry is not None
    addr = request.client.host if request.client else None
    name = auth.verify_agent(request.headers.get("authorization"), addr)
    if name is None:
        raise HTTPException(401, "invalid or revoked agent token")
    body = await request.body()
    if len(body) > MAX_REPORT_BYTES:
        raise HTTPException(413, "report too large")
    if request.headers.get("content-encoding") == "gzip":
        body = _inflate(body, MAX_REPORT_BYTES * 4)
    try:
        # NaN/Infinity are not JSON: Python would accept them, then emit them
        # into SSE frames that every browser's JSON.parse rejects. A JSON bomb
        # (100k nested brackets) raises RecursionError, not ValueError.
        payload = json_module.loads(body, parse_constant=_reject_non_finite)
    except (ValueError, RecursionError):
        raise HTTPException(400, "body is not JSON (or carries NaN/Infinity, "
                                 "or is nested absurdly deep)")
    if not isinstance(payload, dict):
        raise HTTPException(400, "expected a JSON object")
    # A report may carry results for commands the agent just ran; resolve the
    # dashboard requests waiting on them before folding the snapshot in.
    if commands is not None and isinstance(payload.get("command_results"), list):
        commands.resolve(name, payload["command_results"])
    try:
        reply = await asyncio.get_running_loop().run_in_executor(
            None, registry.ingest, name, payload)
    except ValueError as exc:
        raise HTTPException(400, f"report rejected: {exc}")
    except Exception:  # noqa: BLE001 -- a bad report must never 500 the host
        log.exception("report from %s could not be ingested", name)
        raise HTTPException(400, "report rejected: could not be ingested")
    # Keep every open dashboard's node picker current without polling.
    broker.publish("nodes", registry.status_list())
    # The response is the only downlink to a push-only agent: it carries
    # whether the host already knows this node (False after a host restart ->
    # send a full snapshot next), desired setting overrides, and any queued
    # commands (process detail, End task, renice) for this node to run.
    reply["commands"] = commands.take(name) if commands is not None else []
    return {"ok": True, **reply}


# ------------------------------------------------- remote actions (via agent)
async def _agent_command(name: str, action: str, payload: dict[str, Any],
                         timeout_override: float | None = None) -> Any:
    """Queue a command for an agent, wait for its result, and return it.

    The agent runs the command with the same collector code the host uses on
    itself, so remote process detail / End task / renice are the same
    operations -- just relayed. Latency is one report interval; the timeout is
    sized from the node's own cadence so a slow-reporting agent is not cut off
    prematurely. `timeout_override` is for actions whose own duration has
    nothing to do with report cadence (a git pull + pip install can run well
    past the usual 45s dialog-wait cap -- see UPDATE_TIMEOUT_S).
    """
    assert history is not None and registry is not None and commands is not None
    agents = {a["name"]: a for a in history.list_agents()}
    if name not in agents:
        raise HTTPException(404, f"no agent named '{name}'")
    if not agents[name]["enabled"]:
        raise HTTPException(409, f"agent '{name}' is revoked")
    meta = next((n for n in registry.status_list() if n["name"] == name), None)
    interval = (meta or {}).get("report_interval") or 5.0
    # Sized from the node's cadence, but capped: the cadence is the agent's
    # own claim (already clamped to 60s on ingest), and a request must never
    # be parked for longer than a person will wait on a dialog.
    timeout = (timeout_override if timeout_override is not None
              else min(45.0, max(8.0, float(interval) * 2 + 3.0)))

    cmd_id, future = commands.submit(name, action, payload)
    try:
        result = await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        commands.cancel(cmd_id)
        raise HTTPException(
            504, f"'{name}' did not answer within {timeout:.0f}s -- it may be "
                 "offline or reporting slowly")
    if not result.get("ok"):
        raise HTTPException(int(result.get("status") or 502),
                            str(result.get("error") or "agent command failed"))
    return result.get("result")


@app.get("/api/nodes/{name}/processes/{pid}",
         summary="Full detail for one process on an agent")
async def api_node_process_detail(
    name: str, pid: int, extras: str | None = Query(None),
) -> dict[str, Any]:
    return await _agent_command(name, "process_detail",
                                {"pid": pid, "extras": extras or ""})


async def _verified_action(request: Request, name: str, action: str,
                           payload: dict[str, Any]) -> dict[str, Any]:
    """Run a process action on an agent and start watching what happens.

    The node's diagnosis *before* the action is the baseline; the verifier
    then follows the node's next diagnoses and reaches a verdict (helped /
    no change / ...), readable at /api/nodes/{name}/actions/{verify_id}. The
    action itself is unchanged -- the verdict is extra, never a gate. Role
    checked by each caller's own `dependencies=[Depends(require_role(...))]`,
    not here -- this helper is not a route, so it has nothing for a tool
    walking `app.routes` to read.
    """
    assert registry is not None and verifier is not None
    baseline = (registry.get_snapshot(name) or {}).get("diagnosis") or {}
    result = await _agent_command(name, action, payload)
    result = dict(result) if isinstance(result, dict) else {"result": result}
    try:
        verify_id = verifier.start(
            name, action, int(payload.get("pid") or 0) or None,
            str(result.get("name") or "") or None,
            str(result.get("unit") or "") or None, result, baseline,
            getattr(request.state, "user", None))
    except Exception:  # noqa: BLE001 -- the action succeeded; say so regardless
        log.exception("could not start verdict watch")
        verify_id = None
    result["verify_id"] = verify_id
    log.info("%s pid %s on '%s' by %s -> %s", action, payload.get("pid"), name,
             getattr(request.state, "user", "?"),
             "ok" if result.get("ok", True) else result.get("reason"))
    return result


@app.post("/api/nodes/{name}/processes/{pid}/terminate",
          dependencies=[Depends(require_role("operator"))])
async def api_node_terminate(
    request: Request, name: str, pid: int,
    force: bool = Body(False, embed=True),
    confirm: bool = Body(False, embed=True),
) -> dict[str, Any]:
    if not confirm:
        raise HTTPException(400, "confirm must be true for a terminate request")
    return await _verified_action(request, name, "terminate",
                                  {"pid": pid, "force": force})


@app.post("/api/nodes/{name}/processes/{pid}/priority",
          dependencies=[Depends(require_role("operator"))])
async def api_node_priority(
    request: Request, name: str, pid: int, level: str = Body(..., embed=True),
) -> dict[str, Any]:
    return await _verified_action(request, name, "priority",
                                  {"pid": pid, "level": level})


_THROTTLE_LEVELS = ("half", "quarter", "release")


@app.post("/api/nodes/{name}/processes/{pid}/throttle",
          summary="Cap the CPU/IO of the unit a process runs in",
          dependencies=[Depends(require_role("operator"))])
async def api_node_throttle(
    request: Request, name: str, pid: int, level: str = Body(..., embed=True),
) -> dict[str, Any]:
    if level not in _THROTTLE_LEVELS:
        raise HTTPException(422, f"level must be one of {', '.join(_THROTTLE_LEVELS)}")
    return await _verified_action(request, name, "throttle",
                                  {"pid": pid, "level": level})


@app.post("/api/nodes/{name}/processes/{pid}/truncate",
          summary="Free the space a deleted-but-open file still holds",
          dependencies=[Depends(require_role("operator"))])
async def api_node_truncate(
    request: Request, name: str, pid: int,
    path: str = Body(..., embed=True, min_length=1, max_length=4096),
    confirm: bool = Body(False, embed=True),
) -> dict[str, Any]:
    """Truncates the file through the holder's own descriptor
    (/proc/<pid>/fd/<n>), the way `: > /proc/<pid>/fd/<n>` does; the agent
    refuses unless the file is still deleted, regular, and the one named.
    Verified like a process action: the storage finding should clear."""
    if not confirm:
        raise HTTPException(400, "confirm must be true for a truncate request")
    if not (path.startswith("/") or re.match(r"^[A-Za-z]:\\", path)):
        raise HTTPException(422, "path must be absolute")
    return await _verified_action(request, name, "truncate",
                                  {"pid": pid, "path": path})


# Unit actions: the Outage Doctor's verbs. A restart can legitimately take
# as long as the unit's TimeoutStopSec, so the budget is fixed rather than
# cadence-sized, like an update's.
UNIT_VERBS = ("restart", "start", "reload-or-restart", "reset-failed")
UNIT_TIMEOUT_S = 60.0
_UNIT_NAME = re.compile(r"^[A-Za-z0-9:_.@\\-]{1,255}\.(service|socket|timer|mount|path|target)$")
# A Windows service name: the SCM's key name (Spooler, W32Time, MSSQL$SQLEXPRESS),
# no suffix. The agent applies its own guards on top (units.refuse).
_SERVICE_NAME = re.compile(r"^[A-Za-z0-9_.$@ -]{1,256}$")


def _node_platform(name: str) -> str:
    """linux / windows for an enrolled node, from its last report (or the
    persisted value for an offline one); linux when nothing is known."""
    assert registry is not None
    for meta in registry.status_list():
        if meta.get("name") == name:
            return str(meta.get("platform") or "linux")
    return "linux"


@app.post("/api/nodes/{name}/units/{unit}/{verb}",
          summary="Restart / start / reload / reset a systemd unit on an agent",
          dependencies=[Depends(require_role("operator"))])
async def api_node_unit_action(
    request: Request, name: str, unit: str, verb: str,
    manager: str = Body("system", embed=True),
    confirm: bool = Body(False, embed=True),
) -> dict[str, Any]:
    """Relayed to the agent, which runs `systemctl <verb> <unit>` with the
    same guards the process actions have (never init, journald, logind,
    udevd, dbus, or its own unit) and reports the unit's state before and
    after. The host then watches the node's next outage samples and states
    whether the items that named the unit cleared and stayed clear
    (/api/nodes/{name}/actions/{verify_id}); the track record at
    /api/history/record?unit= counts earlier tries."""
    if verb not in UNIT_VERBS:
        raise HTTPException(422, f"verb must be one of {', '.join(UNIT_VERBS)}")
    if manager not in ("system", "user"):
        raise HTTPException(422, "manager must be system or user")
    assert registry is not None and verifier is not None
    # The name's shape depends on which agent this is: a systemd unit on a
    # Linux node, the SCM's service name on a Windows one.
    if _node_platform(name) == "windows":
        if not _SERVICE_NAME.match(unit) or unit != unit.strip():
            raise HTTPException(422, "not a service name")
        if manager != "system":
            raise HTTPException(422, "Windows services have one manager (system)")
    elif not _UNIT_NAME.match(unit):
        raise HTTPException(422, "not a unit name")
    if not confirm:
        raise HTTPException(400, "confirm must be true for a unit action")
    baseline = (registry.get_snapshot(name) or {}).get("outage") or {}
    result = await _agent_command(name, "unit_action",
                                  {"unit": unit, "verb": verb, "manager": manager},
                                  timeout_override=UNIT_TIMEOUT_S)
    result = dict(result) if isinstance(result, dict) else {"result": result}
    try:
        verify_id = verifier.start_outage(name, verb, unit, result, baseline,
                                          getattr(request.state, "user", None))
    except Exception:  # noqa: BLE001 -- the action succeeded; say so regardless
        log.exception("could not start outage verdict watch")
        verify_id = None
    result["verify_id"] = verify_id
    log.info("unit %s %s on '%s' by %s -> %s", verb, unit, name,
             getattr(request.state, "user", "?"),
             "ok" if result.get("ok", True) else result.get("reason"))
    return result


# A git fetch + pip install can run well past a process action's usual
# few-second budget -- fixed and independent of report cadence, unlike the
# formula _agent_command falls back to.
UPDATE_TIMEOUT_S = 120.0


@app.post("/api/nodes/{name}/update",
          summary="git-pull this agent's checkout and restart it",
          dependencies=[Depends(require_role("operator"))])
async def api_node_update(request: Request, name: str) -> dict[str, Any]:
    """Not wrapped in _verified_action: that machinery is a before/after
    diagnosis comparison for process actions, and does not apply here."""
    assert registry is not None
    meta = next((n for n in registry.status_list() if n["name"] == name), None)
    if meta is None:
        raise HTTPException(404, f"no agent named '{name}'")
    if meta.get("update_capable") is not True:
        raise HTTPException(409, meta.get("update_reason")
                            or "this agent has not reported update capability yet")
    result = await _agent_command(name, "update", _update_payload(),
                                  timeout_override=UPDATE_TIMEOUT_S)
    # An explicit update to the tip ends any pin: the operator chose latest.
    if meta.get("pinned_version") and history is not None:
        history.set_agent_pin(name, None, None)
    log.info("update triggered on '%s' by %s -> %s", name,
             getattr(request.state, "user", "?"), result)
    return result


# The first agent build whose update command takes a ref; older ones report
# no update_refs and are refused a version change rather than sent a ref
# they would ignore (and update to the tip instead).
AGENT_REFS_SINCE = "0.20.0-b"


@app.post("/api/nodes/{name}/version",
          summary="Move this agent to a chosen version (a downgrade, usually)",
          dependencies=[Depends(require_role("operator"))])
async def api_node_version(request: Request, name: str,
                           body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Resolves the version to the newest commit that carried it in the
    host's mirror of the agent repository (the same list Patch notes shows)
    and sends the agent the same "update" command with that commit as
    `ref`. Any version other than the published one pins the node, so the
    daily sweep and Update all leave it alone; choosing the published
    version clears the pin. Refused for an agent that cannot update, or
    whose build predates ref support."""
    assert registry is not None and history is not None
    version = str(body.get("version") or "").strip()
    if not version or len(version) > 64:
        raise HTTPException(422, "version is required")
    meta = next((n for n in registry.status_list() if n["name"] == name), None)
    if meta is None:
        raise HTTPException(404, f"no agent named '{name}'")
    if meta.get("update_capable") is not True:
        raise HTTPException(409, meta.get("update_reason")
                            or "this agent has not reported update capability yet")
    if meta.get("update_refs") is not True:
        raise HTTPException(409, f"agent v{meta.get('agent_version') or '?'} cannot change "
                                 f"to a chosen version; update it to v{AGENT_REFS_SINCE} "
                                 "or newer first")
    notes = await asyncio.to_thread(
        changelog.load, "agent-windows" if _node_platform(name) == "windows" else "agent")
    if not notes.get("available"):
        raise HTTPException(503, f"cannot list agent versions: {notes.get('reason')}")
    commit = next((c for c in notes["commits"] if c.get("version") == version), None)
    if commit is None:
        raise HTTPException(404, f"no agent version '{version}' in the mirror")
    if meta.get("agent_version") == version:
        raise HTTPException(409, f"'{name}' is already on v{version}")
    result = await _agent_command(name, "update", _update_payload(ref=commit["sha"]),
                                  timeout_override=UPDATE_TIMEOUT_S)
    latest = meta.get("remote_version")
    pinned = version != latest
    history.set_agent_pin(name, version if pinned else None, commit["sha"] if pinned else None)
    log.info("version change on '%s' to v%s (%s) by %s -> %s", name, version,
             commit["sha"][:12], getattr(request.state, "user", "?"), result)
    return {"version": version, "sha": commit["sha"], "pinned": pinned, "result": result}


@app.delete("/api/nodes/{name}/pin", summary="Let the schedule and Update all move this agent again",
            dependencies=[Depends(require_role("operator"))])
async def api_node_unpin(request: Request, name: str) -> dict[str, Any]:
    """Clears the pin without touching the agent: it stays on its version
    until the daily sweep, Update all, or its own Update button moves it."""
    assert history is not None
    if not history.set_agent_pin(name, None, None):
        raise HTTPException(404, f"no agent named '{name}'")
    log.info("pin cleared on '%s' by %s", name, getattr(request.state, "user", "?"))
    return {"name": name, "pinned": False}


@app.put("/api/nodes/{name}/availability",
         summary="Say whether this machine is always on",
         dependencies=[Depends(require_role("operator"))])
async def api_node_availability(request: Request, name: str,
                                body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """`{"intermittent": true}` is the operator's word that this machine is
    not always on -- a desktop that sleeps at night, a laptop -- so its being
    offline is expected: not badged, not counted as a problem, not notified.
    The host cannot tell a switched-off machine from a dead one; only the
    operator can, which is why this is a setting and not a heuristic."""
    assert history is not None and registry is not None
    flag = body.get("intermittent") if isinstance(body, dict) else None
    if not isinstance(flag, bool):
        raise HTTPException(422, "expected {\"intermittent\": true|false}")
    if not history.set_agent_intermittent(name, flag):
        raise HTTPException(404, f"no agent named '{name}'")
    if notifier is not None:
        notifier.set_intermittent(name, flag)
    registry.set_intermittent(name, flag)
    log.info("node '%s' marked %s by %s", name,
             "not always on" if flag else "always on", getattr(request.state, "user", "?"))
    broker.publish("nodes", registry.status_list())
    return {"name": name, "intermittent": flag}


@app.post("/api/nodes/update-all",
          summary="git-pull and restart every agent that has an update",
          dependencies=[Depends(require_role("operator"))])
async def api_nodes_update_all(request: Request) -> dict[str, Any]:
    """The per-node button, fanned out: every enabled, online, capable agent
    with an update available (nodes.update_targets -- never a containerised
    one, which updates through its image). The commands are queued at once
    and each agent picks its own up in its next report, so the fleet updates
    in parallel; the response names every node, updated or not, and why the
    rest were left out."""
    assert registry is not None
    targets, skipped = nodes_module.update_targets(registry.status_list())

    async def one(name: str) -> dict[str, Any]:
        try:
            result = await _agent_command(name, "update", _update_payload(),
                                          timeout_override=UPDATE_TIMEOUT_S)
            return {"name": name, "ok": True, "result": result}
        except HTTPException as exc:
            return {"name": name, "ok": False, "error": str(exc.detail)}

    results = list(await asyncio.gather(*(one(name) for name in targets)))
    log.info("update-all triggered on %s by %s -> %s", targets,
             getattr(request.state, "user", "?"),
             {r["name"]: r.get("ok") for r in results})
    return {"targets": targets, "results": results, "skipped": skipped}


@app.get("/api/nodes/{name}/actions/{action_id}",
         summary="Progress and verdict of an action taken on this node")
async def api_node_action(name: str, action_id: int) -> dict[str, Any]:
    assert verifier is not None
    watch = verifier.get(action_id)
    if watch is None or watch["node"] != name:
        raise HTTPException(404, "no such action being watched (verdicts are "
                                 "kept for 15 minutes; older ones are in "
                                 "/api/history/actions)")
    return watch


@app.get("/api/nodes", summary="Enrolled agent nodes and their status")
async def api_nodes() -> dict[str, Any]:
    assert registry is not None
    return {"nodes": registry.status_list()}


@app.get("/api/fleet", summary="Headline numbers for every node at once")
async def api_fleet() -> dict[str, Any]:
    """The all-nodes overview grid reads this: one compact summary per agent
    node, in one round trip -- so seeing the whole fleet never requires pulling
    every node's full snapshot into the browser. The host is an aggregator and
    is not itself a node."""
    assert registry is not None
    return {"nodes": registry.fleet(), "shared": registry.shared_causes(),
            "ts": time.time()}


# ------------------------------------------------- agent management (web UI)
# These sit behind the session gate like every other /api route: whoever can
# see the dashboard can manage its nodes. Tokens are returned exactly once,
# in the response to the request that minted them, and never stored.

def _valid_agent_name(name: str) -> str | None:
    name = name.strip()
    if not (1 <= len(name) <= 48):
        return "name must be 1-48 characters"
    if name == "local":
        return "'local' is reserved for the host node"
    if not all(c.isalnum() or c in "-_" for c in name):
        return "use letters, digits, '-' and '_' only (the token format " \
               "reserves '.')"
    return None


def _deploy_base(request: Request) -> str:
    # The address an agent should report to. Configurable in Settings; when
    # `deploy_host` is blank it is inferred from how the browser reached the
    # dashboard (usually the same address an agent can reach). A bare
    # host/host:port is given an http:// scheme. The inferred form keeps the
    # Host header's netloc as it came: a portless Host means the default port
    # for the scheme (a reverse proxy on 443), not this process's 8787, which
    # used to be appended and produced https://example.com:8787.
    cfg = config_module.get()
    base = (cfg.deploy_host or "").strip()
    if not base:
        base = f"{request.url.scheme}://{request.url.netloc}"
    elif "://" not in base:
        base = f"http://{base}"
    return base


def _deploy_command(request: Request, token: str) -> str:
    # `agent_command` defaults to ./agent.sh and can be, e.g., "sudo ./agent.sh".
    command = (config_module.get().agent_command or "").strip() or "./agent.sh"
    return f"{command} {_deploy_base(request)} {token}"


def _deploy_command_windows(request: Request, token: str) -> str:
    # The Windows agent's installer takes the same two positionals; run it
    # from an Administrator PowerShell for the SYSTEM task.
    return f".\\agent.ps1 {_deploy_base(request)} {token}"


def _docker_command(request: Request, token: str) -> str:
    # The privileged `docker run` installer with this host's URL and the agent's
    # token filled in -- the exact one-liner the agent README documents, so an
    # operator can paste it straight onto a Docker host. Single line on purpose.
    base = _deploy_base(request)
    return (
        "docker run -d --name culprit-agent --restart unless-stopped --pull always"
        " --privileged --pid host --network host"
        f" -e CULPRIT_HOST={base} -e CULPRIT_TOKEN={token}"
        " -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro"
        " -v /etc/os-release:/etc/os-release:ro"
        " -v /var/lib/ubuntu-advantage:/var/lib/ubuntu-advantage:ro"
        " -v /var/log/journal:/var/log/journal:ro -v /etc/machine-id:/etc/machine-id:ro"
        " -v /run/systemd:/run/systemd:ro -v /run/dbus:/run/dbus:ro"
        # Read-only Docker socket: lets the agent name the containers its
        # culprits run in (see collectors/containers.py) -- without it they
        # show as runtime + short id, with a note saying so.
        " -v /var/run/docker.sock:/var/run/docker.sock:ro"
        " ghcr.io/olayzen/culprit-agent:latest"
    )


@app.post("/api/agents", summary="Enroll an agent; returns its token ONCE",
          dependencies=[Depends(require_role("admin"))])
async def api_agent_create(
    request: Request,
    name: str = Body(..., embed=True),
) -> dict[str, Any]:
    assert history is not None and registry is not None
    error = _valid_agent_name(name)
    if error:
        raise HTTPException(422, error)
    name = name.strip()
    existing = {a["name"] for a in history.list_agents()}
    if name in existing:
        raise HTTPException(
            409, f"agent '{name}' already exists -- use its 'new token' "
                 "action to rotate the token, or delete it first")
    token = history.add_agent(name)
    log.info("agent '%s' enrolled by %s", name,
             getattr(request.state, "user", "?"))
    broker.publish("nodes", registry.status_list())
    return {"ok": True, "name": name, "token": token,
            "deploy_command": _deploy_command(request, token),
            "deploy_command_windows": _deploy_command_windows(request, token),
            "docker_command": _docker_command(request, token),
            "note": "this token is shown once; only its hash is stored"}


@app.post("/api/agents/{name}/token",
          summary="Rotate an agent's token (re-enables a revoked one)",
          dependencies=[Depends(require_role("admin"))])
async def api_agent_rotate(name: str, request: Request) -> dict[str, Any]:
    assert history is not None and registry is not None
    if name not in {a["name"] for a in history.list_agents()}:
        raise HTTPException(404, f"no agent named '{name}'")
    token = history.add_agent(name)  # rotates the hash and re-enables
    log.info("agent '%s' token rotated by %s", name,
             getattr(request.state, "user", "?"))
    broker.publish("nodes", registry.status_list())
    return {"ok": True, "name": name, "token": token,
            "deploy_command": _deploy_command(request, token),
            "deploy_command_windows": _deploy_command_windows(request, token),
            "docker_command": _docker_command(request, token),
            "note": "the previous token stopped working the moment this one "
                    "was minted; update the agent's config"}


@app.post("/api/agents/{name}/revoke", summary="Reject this agent's reports",
          dependencies=[Depends(require_role("admin"))])
async def api_agent_revoke(name: str, request: Request) -> dict[str, Any]:
    assert history is not None and registry is not None
    if not history.revoke_agent(name):
        raise HTTPException(404, f"no agent named '{name}'")
    log.info("agent '%s' revoked by %s", name,
             getattr(request.state, "user", "?"))
    broker.publish("nodes", registry.status_list())
    return {"ok": True, "name": name}


@app.delete("/api/agents/{name}", summary="Remove an agent entirely",
            dependencies=[Depends(require_role("admin"))])
async def api_agent_delete(name: str, request: Request) -> dict[str, Any]:
    assert history is not None and registry is not None
    if not history.remove_agent(name):
        raise HTTPException(404, f"no agent named '{name}'")
    log.info("agent '%s' deleted by %s", name,
             getattr(request.state, "user", "?"))
    if notifier is not None:
        notifier.forget_node(name)
    if pulse is not None:
        pulse.forget(name)
    registry.set_intermittent(name, False)
    broker.publish("nodes", registry.status_list())
    return {"ok": True, "name": name,
            "note": "stored history for this node is kept"}


# Settings an agent may be asked to change, with the same bounds the host's
# own config enforces. report_interval is derived, never set directly.
_NODE_SETTABLE = {"interval_fast"}


@app.put("/api/nodes/{name}/settings",
         summary="Ask an agent to sample/report at a different cadence")
async def api_node_settings(
    name: str,
    request: Request,
    patch: dict[str, Any] = Body(...),
) -> dict[str, Any]:
    """Session-gated (any role): the title-bar Refresh control's live
    `interval_fast` nudge for a remote agent, not configuration -- "faster
    right now", never a saved preference. The agent applies it from its next
    report's response, so it takes one report interval to land, and it is
    in-memory on both sides: restarts revert to defaults. Contrast
    `/api/settings`, which is real configuration and admin-only."""
    assert history is not None and registry is not None
    if name == LOCAL_NODE:
        raise HTTPException(422, "use /api/settings for the host node")
    if name not in {a["name"] for a in history.list_agents()}:
        raise HTTPException(404, f"no agent named '{name}'")
    cleaned: dict[str, float] = {}
    for key, value in (patch or {}).items():
        if key not in _NODE_SETTABLE:
            raise HTTPException(422, f"{key}: not settable on an agent "
                                     f"(allowed: {', '.join(_NODE_SETTABLE)})")
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise HTTPException(422, f"{key}: expected a number")
        low, high = config_module.LIMITS[key]
        if not (low <= value <= high):
            raise HTTPException(422, f"{key}: must be between {low:g} and {high:g}")
        cleaned[key] = value
    if not cleaned:
        raise HTTPException(422, "empty patch")
    settings = registry.set_node_settings(name, cleaned)
    log.info("node '%s' settings %s by %s", name, cleaned,
             getattr(request.state, "user", "?"))
    return {"ok": True, "name": name, "settings": settings,
            "note": "applies on the agent's next report"}


@app.get("/api/nodes/{name}/snapshot",
         summary="Latest full snapshot reported by one agent")
async def api_node_snapshot(name: str) -> dict[str, Any]:
    assert registry is not None
    if name == LOCAL_NODE:
        raise HTTPException(404, "this host is not a monitored node")
    snapshot = registry.get_snapshot(name)
    if snapshot is None:
        known = {a["name"] for a in (history.list_agents() if history else [])}
        if name in known:
            raise HTTPException(
                404, f"agent '{name}' is enrolled but has not reported since "
                     "this server started")
        raise HTTPException(404, f"no agent named '{name}'")
    return snapshot


# ------------------------------------------------------------------ static
@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(
        config_module.WEB_DIR / "index.html",
        # The shell is tiny and changes with every edit during development.
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/favicon.svg", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(config_module.WEB_DIR / "favicon.svg")


# --------------------------------------------------------------------- reads
@app.get("/api/snapshot", summary="Everything needed for a cold start")
async def api_snapshot(request: Request) -> dict[str, Any]:
    payload = store.snapshot()
    payload["config"] = _public_config()
    payload["elevated"] = is_elevated()
    payload["auth"] = {
        "enabled": auth.enabled if auth else False,
        "username": getattr(request.state, "user", None),
        "role": getattr(request.state, "role", None),
    }
    if registry is not None:
        payload["nodes"] = registry.status_list()
    return payload


@app.get("/api/live", summary="In-memory ring buffer for the live sparklines")
async def api_live(
    keys: str | None = Query(None, description="Comma-separated metric paths"),
) -> dict[str, Any]:
    requested = tuple(k.strip() for k in keys.split(",") if k.strip()) if keys \
        else LIVE_KEYS
    unknown = [k for k in requested if k not in LIVE_KEYS]
    if unknown:
        raise HTTPException(400, f"unknown metric(s): {', '.join(unknown)}. "
                                 f"Available: {', '.join(LIVE_KEYS)}")
    return store.live_series(requested)


@app.get("/api/processes", summary="Current process table")
async def api_processes() -> dict[str, Any]:
    return store.get("process_table") or {"processes": [], "totals": {},
                                          "warm": store.warm}


@app.get("/api/processes/{pid}", summary="Full detail for one process")
async def api_process_detail(pid: int) -> dict[str, Any]:
    # The host is not a monitored node (see the actions section below): the
    # per-process detail it used to collect on demand lives on the agents now,
    # at /api/nodes/{name}/processes/{pid}. Kept as a clear 410 for old clients.
    raise HTTPException(410, "this host is not a monitored node; read a "
                             "process's detail from an agent instead")


@app.get("/api/diagnosis", summary="Lag Doctor findings")
async def api_diagnosis() -> dict[str, Any]:
    return store.get("diagnosis") or {"status": "warming_up", "findings": [],
                                      "offenders": []}


@app.get("/api/services", summary="systemd units")
async def api_services() -> dict[str, Any]:
    return store.get("services") or {"available": False,
                                     "reason": "not sampled yet", "services": []}


@app.get("/api/events", summary="Journal findings, boots and sessions")
async def api_events() -> dict[str, Any]:
    return store.get("events") or {"crashes": {"events": []},
                                   "sessions": {"timeline": []},
                                   "updates": {"events": []},
                                   "policy": {"events": []}}


@app.get("/api/sync", summary="File-sync client health")
async def api_sync() -> dict[str, Any]:
    return store.get("sync") or {"available": False,
                                 "reason": "not sampled yet"}


@app.get("/api/network", summary="Adapters, sockets and connectivity")
async def api_network() -> dict[str, Any]:
    return {
        "rates": store.get("network") or {},
        "detail": store.get("network_detail") or {},
    }


@app.get("/api/ports", summary="Listening ports with kill-ready attribution")
async def api_ports() -> dict[str, Any]:
    return store.get("ports") or {"available": False,
                                  "reason": "not sampled yet", "ports": [],
                                  "totals": {}}


@app.get("/api/storage", summary="Mounts and block devices")
async def api_storage() -> dict[str, Any]:
    return {
        "volumes": store.get("volumes") or {},
        "activity": store.get("disk") or {},
    }


@app.get("/api/status", summary="This tool's own health and cost")
async def api_status() -> dict[str, Any]:
    import os

    import psutil

    own = psutil.Process(os.getpid())
    with own.oneshot():
        overhead = {
            "pid": own.pid,
            "cpu_percent": round(own.cpu_percent() / (psutil.cpu_count() or 1), 2),
            "working_set": own.memory_info().rss,
            "threads": own.num_threads(),
            "uptime_seconds": round(time.time() - own.create_time(), 1),
        }
    return {
        "warm": store.warm,
        "warmup_stage": store.warmup_stage,
        "elevated": is_elevated(),
        "overhead": overhead,
        "sampler": sampler.status() if sampler else {},
        "config": _public_config(),
    }


# ------------------------------------------------------------------- history
@app.get("/api/history/series", summary="Rolled-up metric history")
async def api_history_series(
    since: float | None = Query(None, description="Epoch seconds; default 6h ago"),
    until: float | None = Query(None),
    columns: str | None = Query(None, description="Comma-separated column names"),
    node: str = Query(LOCAL_NODE, description="'local' or an agent name"),
) -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    start = since if since is not None else time.time() - 6 * 3600
    wanted = tuple(c.strip() for c in columns.split(",")) if columns else None
    return history.series(start, until, wanted, node=node)


@app.get("/api/history/top", summary="Heaviest processes over a window")
async def api_history_top(
    since: float | None = Query(None),
    until: float | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    node: str = Query(LOCAL_NODE),
) -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    start = since if since is not None else time.time() - 6 * 3600
    return {"since": start, "until": until or time.time(), "node": node,
            "processes": history.top_processes(start, until, limit, node=node)}


@app.get("/api/history/processes", summary="Stored process rows for one bucket")
async def api_history_processes(
    ts: int = Query(..., description="Rollup bucket timestamp"),
    node: str = Query(LOCAL_NODE),
) -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    return {"ts": ts, "node": node, "processes": history.processes_at(ts, node=node)}


@app.get("/api/history/findings", summary="Past Lag Doctor findings")
async def api_history_findings(
    since: float | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    node: str = Query(LOCAL_NODE),
) -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    start = since if since is not None else time.time() - 24 * 3600
    return {"since": start, "node": node,
            "findings": history.findings(start, limit, node=node)}


@app.get("/api/history/incidents",
         summary="Past findings folded into incidents (start, end, peak, culprits)")
async def api_history_incidents(
    since: float | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    node: str = Query(LOCAL_NODE),
) -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    start = since if since is not None else time.time() - 24 * 3600
    cfg = config_module.get()
    return {"since": start, "node": node, "bucket_seconds": cfg.rollup_seconds,
            "incidents": history.incidents(start, limit, node=node,
                                           bucket_seconds=cfg.rollup_seconds)}


@app.get("/api/history/actions", summary="Actions taken and their verdicts")
async def api_history_actions(
    since: float | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    node: str | None = Query(None),
) -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    start = since if since is not None else time.time() - 24 * 3600
    return {"since": start, "node": node,
            "actions": history.actions(start, node=node, limit=limit)}


@app.get("/api/history/record", summary="How past actions on a process went")
async def api_history_record(
    node: str = Query(..., min_length=1, max_length=64),
    name: str | None = Query(None, max_length=256),
    unit: str | None = Query(None, max_length=256),
) -> dict[str, Any]:
    """The verdicts of earlier terminate / priority / throttle actions on
    the same process name (or unit) on this node, counted per outcome --
    what the process dialog shows as a track record before offering the
    same action again."""
    if history is None:
        raise HTTPException(503, "history is not initialised")
    return history.action_record(node, name or None, unit or None)


# -------------------------------------------------------------- port names
@app.get("/api/portnames", summary="Well-known port names (ports.json)")
async def api_portnames() -> dict[str, Any]:
    """The name a port number usually carries, for the Ports and Map views.
    A hint about the number, never a claim about the process behind it."""
    return portnames.load()


# ------------------------------------------------------------- patch notes
@app.get("/api/changelog/branches", summary="Branches of the host checkout or the agent repository")
async def api_changelog_branches(
    repo: str = Query("agent", pattern="^(host|agent|agent-windows)$",
                      description="agent: the mirror of the Linux agent repository (the branch "
                                  "setting, Patch notes); agent-windows: the Windows agent's; "
                                  "host: this checkout's own branches"),
    refresh: bool = Query(False, description="fetch first if the last fetch is older than a minute"),
) -> dict[str, Any]:
    """What the mirror of the agent repository has under refs/heads, or the
    host checkout's local and origin branches, the demo branch left out;
    `default` is the branch Patch notes opens on (running / configured).
    Unavailable with the reason on a host that has no mirror or checkout;
    Settings then offers a typed name instead of an empty list."""
    return await asyncio.to_thread(changelog.branches, repo, refresh)


@app.get("/api/changelog", summary="Patch notes: the host's or the agent's commit history")
async def api_changelog(
    repo: str = Query("host", pattern="^(host|agent|agent-windows)$",
                      description="host: this checkout; agent: a mirror of the Linux agent "
                                  "repository; agent-windows: of the Windows agent's"),
    branch: str | None = Query(None, max_length=200,
                               description="a branch of that repository; the running one (host) "
                                           "or the configured update branch (agent) when omitted"),
) -> dict[str, Any]:
    """Every commit (newest first), each tagged with the version version.json
    held after it. The host's running branch is one `git log` over HEAD at
    first request, cached for the life of the process; any other branch of
    either repository comes from refs fetched at most once an hour (origin's
    for the host, the bare mirror under data/ for the agent). A host without
    a checkout (the container image), or one that cannot reach the agent
    repository, says so rather than showing an empty list."""
    if branch is not None:
        try:
            branch = config_module._branch_name(branch.strip())
        except ValueError as exc:
            raise HTTPException(422, str(exc))
    return await asyncio.to_thread(changelog.load, repo, branch)


# --------------------------------------------------------------------- map
@app.get("/api/map", summary="The fleet map: who depends on whom, and who is waiting")
async def api_map() -> dict[str, Any]:
    """Built at read time from the nodes' own socket and port tables: an
    edge per (client process, node, listener), with the client kernel's RTT,
    retransmits, queues and byte rate, and the target's findings joined on."""
    assert fleetmap is not None
    return fleetmap.build()


@app.get("/api/map/radius", summary="Who would feel an action on this process")
async def api_map_radius(
    node: str = Query(..., min_length=1, max_length=64),
    pid: int = Query(..., ge=1),
) -> dict[str, Any]:
    assert fleetmap is not None
    return fleetmap.radius(node, pid)


# ------------------------------------------------------------------ deaths
@app.get("/api/deaths", summary="How nodes died: the Coroner's verdicts")
async def api_deaths(
    node: str | None = Query(None, max_length=64),
    since: float | None = Query(None, description="Epoch seconds; default 90 days ago"),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    """Every death the Coroner has recorded (newest first), without the
    recorder frames -- those are read per death from /api/deaths/{id}."""
    if history is None:
        raise HTTPException(503, "history is not initialised")
    start = since if since is not None else time.time() - 90 * 86400
    return {"since": start, "node": node,
            "deaths": history.deaths(node=node or None, since=start, limit=limit)}


@app.get("/api/deaths/{death_id}", summary="One death: verdict, evidence and the recorder")
async def api_death(death_id: int) -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    entry = history.death(death_id)
    if entry is None:
        raise HTTPException(404, "no such death")
    return entry


# ------------------------------------------------------------- expectations
@app.get("/api/expectations", summary="Findings marked as expected")
async def api_expectations() -> dict[str, Any]:
    assert expectations is not None
    return {"expectations": expectations.list()}


@app.get("/api/expectations/suggested",
         summary="Recurring findings that could be marked as expected")
async def api_expectations_suggested(
    node: str = Query(..., min_length=1, max_length=64),
) -> dict[str, Any]:
    """Findings that recurred at the same time of day on three or more
    days, led by the same process, and are not already covered by an
    expectation. Computed from stored incidents at read time; a person
    still decides."""
    assert expectations is not None
    return {"suggestions": expectations.suggest(node)}


@app.post("/api/expectations", summary="Mark a finding as expected",
          dependencies=[Depends(require_role("operator"))])
async def api_expectation_add(request: Request,
                              payload: dict[str, Any] = Body(...)) -> JSONResponse:
    assert history is not None and expectations is not None
    if not isinstance(payload, dict):
        raise HTTPException(400, "expected a JSON object")
    clean, errors = validate_expectation(payload)
    if errors:
        return JSONResponse(status_code=422,
                            content={"ok": False, "field_errors": errors})
    if len(expectations.list()) >= 200:
        raise HTTPException(409, "too many expectations (200); remove some first")
    try:
        new_id = history.add_expectation(
            clean["node"], clean["key"], clean["culprit"], clean["reason"],
            clean["days"], clean["start"], clean["end"],
            getattr(request.state, "user", None))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f"could not save: {exc}")
    expectations.reload()
    log.info("expectation %d added by %s: %s on %s (%s)", new_id,
             getattr(request.state, "user", "?"), clean["key"], clean["node"],
             clean["reason"])
    return JSONResponse({"ok": True, "id": new_id, **clean})


@app.delete("/api/expectations/{expectation_id}",
            summary="Stop treating a finding as expected",
            dependencies=[Depends(require_role("operator"))])
async def api_expectation_remove(expectation_id: int,
                                 request: Request) -> dict[str, Any]:
    assert history is not None and expectations is not None
    if not history.remove_expectation(expectation_id):
        raise HTTPException(404, "no such expectation")
    expectations.reload()
    log.info("expectation %d removed by %s", expectation_id,
             getattr(request.state, "user", "?"))
    return {"ok": True, "id": expectation_id}


# ------------------------------------------------------------ notifications
@app.get("/api/notify/status", summary="Notification channels and delivery stats")
async def api_notify_status() -> dict[str, Any]:
    assert notifier is not None
    return notifier.status()


@app.post("/api/notify/test", summary="Send a test message on every channel",
          dependencies=[Depends(require_role("admin"))])
async def api_notify_test(request: Request) -> dict[str, Any]:
    assert notifier is not None
    log.info("notification test requested by %s",
             getattr(request.state, "user", "?"))
    return await asyncio.get_running_loop().run_in_executor(
        None, notifier.send_test)


@app.get("/api/history/events", summary="Stored event-log entries")
async def api_history_events(
    since: float | None = Query(None),
    kinds: str | None = Query(None),
    limit: int = Query(300, ge=1, le=2000),
    node: str = Query(LOCAL_NODE),
) -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    kind_list = [k.strip() for k in kinds.split(",")] if kinds else None
    return {"events": history.events(since, kind_list, limit, node=node)}


@app.get("/api/history/stats", summary="History database size and span")
async def api_history_stats() -> dict[str, Any]:
    if history is None:
        raise HTTPException(503, "history is not initialised")
    return history.stats()


# ------------------------------------------------------------------- settings
@app.get("/api/settings")
async def api_get_settings(request: Request) -> dict[str, Any]:
    return {
        "config": _public_config(),
        "limits": {k: list(v) for k, v in config_module.LIMITS.items()},
        "editable": sorted(config_module.EDITABLE),
        "access": _access_info(request),
    }


def _access_info(request: Request) -> dict[str, Any]:
    """How this very request reached the host, so the Network trust panel
    can say "you are 10.0.0.7 via proxy 127.0.0.1, Host dash.local" and the
    lock-out guard below has something concrete to point at."""
    access = getattr(request.state, "access", None)
    info: dict[str, Any] = access.public() if access else {}
    info["runtime_proxies"] = trust.runtime_proxies()
    info["always_hosts"] = sorted(trust.local_names())
    return info


def _lockout_guard(request: Request, patch: dict[str, Any]) -> dict[str, str]:
    """Would the patched trust lists refuse the connection that is saving
    them? Then refuse the save instead: a list that cuts off the only session
    able to correct it is the one mistake here that is not reversible from
    the browser. Entries that do not parse are left for config.update() to
    report field by field."""
    access = getattr(request.state, "access", None)
    if access is None:
        return {}
    cfg = config_module.get()
    try:
        proxies = trust.split_entries(patch.get("trusted_proxies", cfg.trusted_proxies))
        hosts = trust.split_entries(patch.get("trusted_hosts", cfg.trusted_hosts))
        trust.parse_proxies(proxies)
        trust.parse_hosts(hosts)
    except ValueError:
        return {}
    again = trust.resolve(access.peer, request.headers, trust.policy(proxies, hosts),
                          scheme=request.url.scheme)
    if not again.refusal:
        return {}
    field = "trusted_hosts" if again.reason == "untrusted_host" else "trusted_proxies"
    return {field: f"not saved: this would refuse your own connection ({again.refusal}). "
                   "Include it, or save from a connection that stays allowed."}


@app.put("/api/settings", dependencies=[Depends(require_role("admin"))])
async def api_put_settings(
    request: Request,
    patch: dict[str, Any] = Body(...),
    persist: bool = Query(
        True,
        description="False applies the change to the running sampler without "
                    "writing config.json -- a live retune rather than a saved "
                    "preference.",
    ),
) -> JSONResponse:
    """Apply a settings patch. Configuration, always -- unlike the identically-
    shaped `/api/nodes/{name}/settings`, which is only ever the title-bar
    Refresh control's live `interval_fast` nudge for a remote agent and needs
    no more than a session; this host is never itself a node to nudge that
    way (`store.isLocal()` is always false -- see stream.js), so every call
    here is a real settings change.

    Rejections come back as a field-keyed map so the Settings form can render
    each message inline next to the offending input rather than as a toast.
    """
    if not isinstance(patch, dict) or not patch:
        raise HTTPException(400, "expected a non-empty object of settings")
    # The SMTP password is write-only: the form never has it, so an empty
    # string means "leave it", and only an explicit null clears it.
    if "notify_smtp_password" in patch:
        if patch["notify_smtp_password"] is None:
            patch["notify_smtp_password"] = ""
        elif patch["notify_smtp_password"] == "":
            patch.pop("notify_smtp_password")
            if not patch:
                return JSONResponse({"ok": True, "persisted": persist,
                                     "config": _public_config()})
    if "trusted_proxies" in patch or "trusted_hosts" in patch:
        blocked = _lockout_guard(request, patch)
        if blocked:
            return JSONResponse(
                status_code=422,
                content={"ok": False, "field_errors": blocked, "errors": [],
                         "config": _public_config()},
            )
    cfg, errors = config_module.update(patch, persist=persist)
    if errors:
        field_errors: dict[str, str] = {}
        general: list[str] = []
        for message in errors:
            field, sep, text = message.partition(": ")
            if sep and field in config_module.EDITABLE:
                field_errors[field] = text
            else:
                general.append(message)
        return JSONResponse(
            status_code=422,
            content={"ok": False, "field_errors": field_errors,
                     "errors": general, "config": _public_config()},
        )
    if history is not None:
        history.set_enabled(cfg.persist_history)
    store.ring.set_window(cfg.live_window_seconds)
    return JSONResponse({"ok": True, "persisted": persist,
                         "config": _public_config()})


# -------------------------------------------------------------------- actions
# The host is not a monitored node, so it exposes no actions against its own
# processes -- that would be a way to kill the dashboard's own machine. Process
# actions exist only against agents, via /api/nodes/{name}/processes/... which
# the frontend's procBase() always targets. These two routes remain so an old
# client gets a clear 410 rather than a confusing 404.
@app.post("/api/processes/{pid}/terminate")
async def api_terminate(pid: int) -> dict[str, Any]:
    raise HTTPException(410, "this host is not a monitored node; end a process "
                             "on an agent instead")


@app.post("/api/processes/{pid}/priority")
async def api_priority(pid: int) -> dict[str, Any]:
    raise HTTPException(410, "this host is not a monitored node; renice a "
                             "process on an agent instead")


# ---------------------------------------------------------------------- stream
@app.get("/api/stream", summary="Server-Sent Events feed")
async def api_stream(request: Request) -> StreamingResponse:
    queue = broker.subscribe()

    async def generator():
        try:
            # Send the whole current state first so a reconnecting client is
            # correct immediately, without waiting for the next tick.
            snapshot = store.snapshot()
            snapshot["config"] = _public_config()
            snapshot["elevated"] = is_elevated()
            snapshot["auth"] = {
                "enabled": auth.enabled if auth else False,
                "username": getattr(request.state, "user", None),
                "role": getattr(request.state, "role", None),
            }
            if registry is not None:
                snapshot["nodes"] = registry.status_list()
            yield _frame("snapshot", snapshot)
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # SSE comment: keeps the connection alive without being
                    # dispatched as an event on the client.
                    yield ": keepalive\n\n"
                    continue
                yield frame
        except asyncio.CancelledError:
            raise
        finally:
            broker.unsubscribe(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Belt and braces if anyone puts this behind nginx.
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/healthz", include_in_schema=False)
async def healthz() -> dict[str, Any]:
    return {"ok": True, "warm": store.warm, "stage": store.warmup_stage}


class _NoCacheStatic(StaticFiles):
    """Static files served with revalidation forced.

    The browser otherwise caches the ES modules indefinitely, and because there
    is no bundler there are no content-hashed filenames to bust that cache. The
    symptom is nasty: you edit a view, reload, and see the old behaviour with no
    indication why. Everything here is a few kilobytes off localhost, so caching
    buys nothing measurable and costs real confusion.
    """

    def is_not_modified(self, response_headers, request_headers) -> bool:  # noqa: ANN001
        return False

    async def get_response(self, path: str, scope):  # noqa: ANN001, ANN201
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


# Mounted last so /api/* wins over any same-named static path.
app.mount(
    "/assets",
    _NoCacheStatic(directory=str(config_module.WEB_DIR), html=False),
    name="assets",
)


# --------------------------------------------------------------------- helpers
def _reject_non_finite(constant: str) -> Any:
    raise ValueError(f"{constant} is not JSON")


def _inflate(data: bytes, limit: int) -> bytes:
    """gzip-decompress a report with a hard ceiling on the *output* size.

    `gzip.decompress` inflates the whole thing before any length check runs,
    and gzip's ratio is about 1000:1 -- so an 8 MB body (within the raw
    limit) could expand to 8 GB in the host's memory before being rejected.
    A decompressobj with max_length stops producing bytes at the ceiling, so
    a bomb costs at most `limit` bytes and is then refused like any oversized
    report.
    """
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)  # gzip framing
    try:
        out = inflater.decompress(data, limit + 1)
    except zlib.error:
        raise HTTPException(400, "bad gzip body")
    if len(out) > limit or inflater.unconsumed_tail:
        raise HTTPException(413, "report too large after decompression")
    if not inflater.eof:
        raise HTTPException(400, "bad gzip body")
    return out


def _frame(event: str, data: Any) -> str:
    import json

    from .state import _fallback

    body = json.dumps(data, default=_fallback, separators=(",", ":"))
    return f"event: {event}\ndata: {body}\n\n"


def _public_config() -> dict[str, Any]:
    cfg = config_module.get()
    payload = cfg.to_dict()
    # The absolute DB path is not the browser's business.
    payload.pop("db_path", None)
    # The SMTP password never leaves the server; the form only learns
    # whether one is set.
    payload["notify_smtp_password_set"] = bool(payload.get("notify_smtp_password"))
    payload["notify_smtp_password"] = ""
    payload["history_enabled"] = bool(history and history.ready
                                      and history.recording)
    payload["history_error"] = history.error if history else None
    # The host's own version (version.json), so the sidebar and the About
    # panel can say which build is running. Config is the one section every
    # frame carries -- the cold-start snapshot, the SSE snapshot frame and
    # /api/settings -- and it reaches the store even while a remote node is
    # being viewed, so it is the right carrier for a fact about the host.
    payload["version"] = __version__
    return payload


def _display_host(host: str) -> str:
    return "localhost" if host in ("0.0.0.0", "127.0.0.1", "::") else host
