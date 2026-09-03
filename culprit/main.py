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
import threading
import time
import webbrowser
import zlib
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import (FileResponse, JSONResponse, RedirectResponse,
                               StreamingResponse)
from fastapi.staticfiles import StaticFiles

from . import config as config_module
from .auth import SESSION_COOKIE, Auth, ensure_default_user
from .db import LOCAL_NODE, History
from .nodes import MAX_REPORT_BYTES, CommandBroker, NodeRegistry
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    global history, auth, registry, commands
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
        if registry is not None:
            registry.flush_all()
        if sampler is not None:
            await sampler.stop()


app = FastAPI(
    title="Culprit",
    description="Live Linux health, process and event monitoring.",
    version="2.0.1",
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
    if response is None:
        response = await call_next(request)
    return _harden(request, response)


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
    return {"enabled": auth.enabled, "username": user}


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
                         ) -> Any:
    """Queue a command for an agent, wait for its result, and return it.

    The agent runs the command with the same collector code the host uses on
    itself, so remote process detail / End task / renice are the same
    operations -- just relayed. Latency is one report interval; the timeout is
    sized from the node's own cadence so a slow-reporting agent is not cut off
    prematurely.
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
    timeout = min(45.0, max(8.0, float(interval) * 2 + 3.0))

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


@app.post("/api/nodes/{name}/processes/{pid}/terminate")
async def api_node_terminate(
    name: str, pid: int,
    force: bool = Body(False, embed=True),
    confirm: bool = Body(False, embed=True),
) -> dict[str, Any]:
    if not confirm:
        raise HTTPException(400, "confirm must be true for a terminate request")
    return await _agent_command(name, "terminate",
                                {"pid": pid, "force": force})


@app.post("/api/nodes/{name}/processes/{pid}/priority")
async def api_node_priority(
    name: str, pid: int, level: str = Body(..., embed=True),
) -> dict[str, Any]:
    return await _agent_command(name, "priority", {"pid": pid, "level": level})


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
    return {"nodes": registry.fleet(), "ts": time.time()}


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
    # host/host:port is given an http:// scheme.
    cfg = config_module.get()
    base = (cfg.deploy_host or "").strip()
    if not base:
        base = f"{request.url.scheme}://{request.url.hostname}:{request.url.port or 8787}"
    elif "://" not in base:
        base = f"http://{base}"
    return base


def _deploy_command(request: Request, token: str) -> str:
    # `agent_command` defaults to ./agent.sh and can be, e.g., "sudo ./agent.sh".
    command = (config_module.get().agent_command or "").strip() or "./agent.sh"
    return f"{command} {_deploy_base(request)} {token}"


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
        " ghcr.io/olayzen/culprit-agent:latest"
    )


@app.post("/api/agents", summary="Enroll an agent; returns its token ONCE")
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
            "docker_command": _docker_command(request, token),
            "note": "this token is shown once; only its hash is stored"}


@app.post("/api/agents/{name}/token",
          summary="Rotate an agent's token (re-enables a revoked one)")
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
            "docker_command": _docker_command(request, token),
            "note": "the previous token stopped working the moment this one "
                    "was minted; update the agent's config"}


@app.post("/api/agents/{name}/revoke", summary="Reject this agent's reports")
async def api_agent_revoke(name: str, request: Request) -> dict[str, Any]:
    assert history is not None and registry is not None
    if not history.revoke_agent(name):
        raise HTTPException(404, f"no agent named '{name}'")
    log.info("agent '%s' revoked by %s", name,
             getattr(request.state, "user", "?"))
    broker.publish("nodes", registry.status_list())
    return {"ok": True, "name": name}


@app.delete("/api/agents/{name}", summary="Remove an agent entirely")
async def api_agent_delete(name: str, request: Request) -> dict[str, Any]:
    assert history is not None and registry is not None
    if not history.remove_agent(name):
        raise HTTPException(404, f"no agent named '{name}'")
    log.info("agent '%s' deleted by %s", name,
             getattr(request.state, "user", "?"))
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
    """Session-gated. The agent applies this from its next report's response,
    so it takes one report interval to land. In-memory on both sides by
    design -- like the titlebar Refresh control locally, it means "faster
    right now", not a saved preference; restarts revert to defaults."""
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
async def api_get_settings() -> dict[str, Any]:
    return {
        "config": _public_config(),
        "limits": {k: list(v) for k, v in config_module.LIMITS.items()},
        "editable": sorted(config_module.EDITABLE),
    }


@app.put("/api/settings")
async def api_put_settings(
    patch: dict[str, Any] = Body(...),
    persist: bool = Query(
        True,
        description="False applies the change to the running sampler without "
                    "writing config.json. Used by the title-bar Refresh "
                    "control, where a change means 'faster right now' rather "
                    "than a saved preference.",
    ),
) -> JSONResponse:
    """Apply a settings patch.

    Rejections come back as a field-keyed map so the Settings form can render
    each message inline next to the offending input rather than as a toast.
    """
    if not isinstance(patch, dict) or not patch:
        raise HTTPException(400, "expected a non-empty object of settings")
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
    payload["history_enabled"] = bool(history and history.ready
                                      and history.recording)
    payload["history_error"] = history.error if history else None
    return payload


def _display_host(host: str) -> str:
    return "localhost" if host in ("0.0.0.0", "127.0.0.1", "::") else host
