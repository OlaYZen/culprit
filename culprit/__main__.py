"""Entry point: `python -m culprit`.

Serves the host node by default; subcommands manage the credentials that the
multi-node setup depends on:

    python -m culprit                        # run the host node
    python -m culprit users add <name>       # dashboard user (prompts, hidden)
    python -m culprit users list|remove
    python -m culprit agents add <name>      # enroll an agent, prints its
                                             # token exactly once
    python -m culprit agents list|revoke|remove

The agent is a separate, self-contained bundle in `culprit-agent/` (its own copy
of the runnable package + agent.sh); `python -m culprit.agent` runs only from
there, so a report-only node never even imports FastAPI. The host package has no
agent module.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import time

from . import config as config_module


def _env_int(name: str) -> int | None:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return None


def _open_history():  # type: ignore[no-untyped-def]
    from .db import History

    cfg = config_module.load()
    history = History(cfg.resolved_db_path, enabled=True)
    if not history.ready:
        print(f"error: cannot open {cfg.resolved_db_path}: {history.error}",
              file=sys.stderr)
        sys.exit(1)
    return history


def _cmd_users(args: argparse.Namespace) -> int:
    history = _open_history()
    try:
        if args.action == "add":
            password = getpass.getpass(f"password for {args.name}: ")
            if len(password) < 8:
                print("error: use at least 8 characters", file=sys.stderr)
                return 1
            if password != getpass.getpass("repeat: "):
                print("error: passwords do not match", file=sys.stderr)
                return 1
            history.add_user(args.name, password)
            print(f"user '{args.name}' saved. Authentication is now REQUIRED "
                  "for the dashboard (restart the server if it is running).")
        elif args.action == "remove":
            if history.remove_user(args.name):
                print(f"user '{args.name}' removed."
                      + (" No users remain -- the dashboard is open again "
                         "(loopback only)." if history.user_count() == 0 else ""))
            else:
                print(f"no such user '{args.name}'", file=sys.stderr)
                return 1
        else:
            users = history.list_users()
            if not users:
                print("no users -- the dashboard runs unauthenticated and will "
                      "refuse to bind a non-loopback address.")
            for user in users:
                created = time.strftime("%Y-%m-%d",
                                        time.localtime(user["created_at"]))
                print(f"  {user['username']}  (created {created})")
        return 0
    finally:
        history.close()


def _cmd_agents(args: argparse.Namespace) -> int:
    history = _open_history()
    try:
        if args.action == "add":
            if "." in args.name or "/" in args.name or not args.name.strip():
                print("error: agent names cannot contain '.' or '/'",
                      file=sys.stderr)
                return 1
            if args.name == "local":
                print("error: 'local' is reserved for the host node",
                      file=sys.stderr)
                return 1
            token = history.add_agent(args.name)
            print(f"agent '{args.name}' enrolled. Its token (shown ONCE -- "
                  "only a hash is stored):\n")
            print(f"  {token}\n")
            print("on the target server (copy the culprit-agent/ folder there):")
            print(f"  cd culprit-agent && ./agent.sh https://<this-host>:8787 {token}")
        elif args.action == "revoke":
            if history.revoke_agent(args.name):
                print(f"agent '{args.name}' revoked -- its reports are now "
                      "rejected. Re-enable by re-running `agents add` (issues "
                      "a new token).")
            else:
                print(f"no such agent '{args.name}'", file=sys.stderr)
                return 1
        elif args.action == "remove":
            if history.remove_agent(args.name):
                print(f"agent '{args.name}' removed (its stored history is "
                      "kept; prune it with sqlite3 if you want it gone).")
            else:
                print(f"no such agent '{args.name}'", file=sys.stderr)
                return 1
        else:
            agents = history.list_agents()
            if not agents:
                print("no agents enrolled. Enroll one with: "
                      "python -m culprit agents add <name>")
            for agent in agents:
                seen = (time.strftime("%Y-%m-%d %H:%M",
                                      time.localtime(agent["last_seen"]))
                        if agent["last_seen"] else "never")
                state = "enabled" if agent["enabled"] else "REVOKED"
                print(f"  {agent['name']:<24} {state:<8} last seen {seen}"
                      f"{'  from ' + agent['last_addr'] if agent['last_addr'] else ''}")
        return 0
    finally:
        history.close()


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .auth import ensure_default_user, refuse_exposed_without_users
    from .db import History

    cfg = config_module.load()
    host = args.host or os.environ.get("CULPRIT_HOST") or cfg.host
    port = args.port or _env_int("CULPRIT_PORT") or cfg.port

    # Startup safety check: a dashboard with a kill button must never be
    # network-reachable without a login. A fresh install has no users, so a
    # default admin/admin is created first -- that keeps the dashboard behind a
    # login everywhere (and makes the refusal below unreachable in practice),
    # with a loud warning to change the password.
    history = History(cfg.resolved_db_path, enabled=True)
    created_default = ensure_default_user(history)
    refusal = refuse_exposed_without_users(host, history)
    history.close()
    if refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return 1
    if created_default:
        print("SECURITY: no users existed, so a default 'admin' / 'admin' "
              "account was created. Change its password now -- Settings > "
              "Account in the web UI, or: python -m culprit users add admin",
              file=sys.stderr)

    # Publish the resolved bind address so the app's own `config.load()` inside
    # the lifespan hook agrees with what uvicorn actually bound.
    os.environ["CULPRIT_PORT"] = str(port)
    os.environ["CULPRIT_HOST"] = host
    if args.no_browser:
        os.environ["CULPRIT_NO_BROWSER"] = "1"

    uvicorn.run(
        "culprit.main:app",
        host=host,
        port=port,
        log_level=args.log_level,
        reload=args.reload,
        ssl_certfile=args.ssl_certfile,
        ssl_keyfile=args.ssl_keyfile,
        # Access logs would print a line per SSE keepalive; the app logs what
        # matters itself.
        access_log=False,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="culprit",
        description="Live Linux health, process and event monitoring.",
    )
    parser.add_argument("--host", default=None, help="bind address")
    parser.add_argument("--port", type=int, default=None, help="bind port")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window on start")
    parser.add_argument("--reload", action="store_true",
                        help="auto-reload on source changes (development)")
    parser.add_argument("--ssl-certfile", default=None,
                        help="TLS certificate; enables https")
    parser.add_argument("--ssl-keyfile", default=None,
                        help="TLS private key")
    parser.add_argument("--log-level", default="info",
                        choices=("critical", "error", "warning", "info", "debug"))
    subparsers = parser.add_subparsers(dest="command")

    users = subparsers.add_parser("users", help="manage dashboard users")
    users.add_argument("action", choices=("add", "list", "remove"))
    users.add_argument("name", nargs="?", default=None)

    agents = subparsers.add_parser("agents", help="manage agent nodes")
    agents.add_argument("action", choices=("add", "list", "revoke", "remove"))
    agents.add_argument("name", nargs="?", default=None)

    args = parser.parse_args(argv)

    if args.command in ("users", "agents"):
        if args.action in ("add", "remove", "revoke") and not args.name:
            parser.error(f"'{args.command} {args.action}' needs a name")
        return _cmd_users(args) if args.command == "users" else _cmd_agents(args)
    return _serve(args)


if __name__ == "__main__":
    sys.exit(main())
