#!/usr/bin/env bash
# culprit host. Two steps, always in this order:
#   1. install  -- create the venv, install deps, print the availability matrix
#   2. run it   -- either set it up as a systemd service (default, it asks),
#                  or with --run start it here in the foreground
#
#   ./culprit.sh                 # install if needed, then OFFER to set up a
#                                #   systemd user service (start on boot + restart)
#   ./culprit.sh --run           # install if needed, then run HERE (foreground).
#                                #   No service prompt. Also takes --port N / --no-browser
#   ./culprit.sh --install-only  # install only -- no service, no run (CI)
#   CULPRIT_HOST=0.0.0.0 ./culprit.sh [--run]   # force-bind all interfaces so
#                                #   other machines' agents can reach it (needs a user)
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
PYTHON="${PYTHON:-python3}"

usage() {
    cat <<'USAGE'
culprit host -- install, then run it as a systemd service or in the foreground.

Usage:
  ./culprit.sh                 install if needed, then offer to set up a systemd
                               user service (start on boot, auto-restart)
  ./culprit.sh --run           install if needed, then run here in the foreground
                               (no service prompt); also takes --port N / --no-browser
  ./culprit.sh --install-only  install only -- no service, no run (CI)
  ./culprit.sh -h, --help      show this help

Environment:
  CULPRIT_HOST=0.0.0.0         bind all interfaces so other machines' agents can
                               reach this host (needs a dashboard user to exist)
USAGE
}

# ---- mode + passthrough (--port / --no-browser / --host reach the server) -----
MODE="service"
PORT=""
ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)               usage; exit 0 ;;
        --run|run)               MODE="run"; shift ;;
        --install-only|--no-run) MODE="install"; shift ;;
        --port)                  PORT="${2:-}"; shift 2 ;;
        *)                       ARGS+=("$1"); shift ;;
    esac
done

# ==============================================================================
# 1. INSTALL  (every mode needs the venv + deps)
# ==============================================================================
if ! command -v "$PYTHON" >/dev/null; then
    echo "error: python3 not found. Install it (e.g. sudo apt install python3-venv)." >&2
    exit 1
fi
if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
    echo "error: Python 3.11+ required, found $("$PYTHON" --version)." >&2
    exit 1
fi

need_install=0
if [ ! -x .venv/bin/python ]; then
    need_install=1
elif ! .venv/bin/python -c 'import fastapi, uvicorn, psutil; from culprit import main' 2>/dev/null; then
    need_install=1
fi

if [ "$need_install" -eq 1 ]; then
    if [ ! -x .venv/bin/python ]; then
        echo "creating virtual environment..."
        "$PYTHON" -m venv .venv || {
            echo "error: venv creation failed -- on Debian/Ubuntu: sudo apt install python3-venv" >&2
            exit 1
        }
    fi
    echo "installing dependencies..."
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet -r requirements.txt
    echo "verifying imports..."
    .venv/bin/python - <<'EOF'
import fastapi, uvicorn, psutil  # noqa: F401
from culprit import main  # noqa: F401
print(f"  fastapi {fastapi.__version__}, uvicorn {uvicorn.__version__}, "
      f"psutil {psutil.__version__} -- imports OK")
EOF
fi

# The source-availability matrix on a fresh install, or whenever we are not
# about to exec straight into the server (a quick --run relaunch stays quiet).
if [ "$need_install" -eq 1 ] || [ "$MODE" != "run" ]; then
    echo
    echo "source availability on this machine:"
    .venv/bin/python - <<'EOF'
from culprit import linux

def row(label, ok, why=""):
    mark = "\033[32myes\033[0m" if ok else "\033[33mno\033[0m "
    print(f"  {label:<34} {mark}  {why}")

journal = linux.journal_access()
row("PSI (/proc/pressure)", linux.psi_available(),
    "" if linux.psi_available() else "kernel <4.20 or CONFIG_PSI disabled -> derived pressure model")
row("cgroup v2 (per-unit attribution)", linux.cgroup_version() == 2,
    f"version {linux.cgroup_version()}")
row("system journal", bool(journal["readable"]),
    journal["reason"] or ("persistent" if journal["persistent"] else "volatile -- history dies at reboot"))
row("systemctl", linux.run(["systemctl", "--version"], timeout=5) is not None)
caps = linux.capabilities()
row("other users' /proc/<pid>/io", "CAP_SYS_PTRACE" in caps,
    "" if "CAP_SYS_PTRACE" in caps else "needs CAP_SYS_PTRACE; own processes still work")
row("SMART health", "CAP_SYS_RAWIO" in caps,
    "" if "CAP_SYS_RAWIO" in caps else "needs CAP_SYS_RAWIO/root + smartmontools")
container = linux.in_container()
row("bare metal / full VM", container is None,
    f"inside a {container} container -- /proc numbers may be the host's" if container else "")
EOF
fi

config_port() { .venv/bin/python -c 'from culprit import config; print(config.load().effective_port)'; }

# --install-only: stop after the install step.
if [ "$MODE" = "install" ]; then
    echo
    echo "setup done."
    echo "  run it here:         ./culprit.sh --run"
    echo "  set up as a service: ./culprit.sh        (asks, then enables + starts it)"
    exit 0
fi

# ==============================================================================
# 2a. RUN  -- foreground: resolve the port, walk to a free one, exec the server
# ==============================================================================
if [ "$MODE" = "run" ]; then
    [ -n "$PORT" ] || PORT="$(config_port)"
    port_free() {
        .venv/bin/python -c "
import socket, sys
s = socket.socket()
try:
    s.bind(('127.0.0.1', $1))
except OSError:
    sys.exit(1)
finally:
    s.close()
"
    }
    ORIGINAL=$PORT
    while ! port_free "$PORT"; do
        PORT=$((PORT + 1))
        if [ $((PORT - ORIGINAL)) -gt 20 ]; then
            echo "error: no free port in $ORIGINAL-$PORT" >&2
            exit 1
        fi
    done
    [ "$PORT" = "$ORIGINAL" ] || echo "port $ORIGINAL is in use; using $PORT instead"
    exec .venv/bin/python -m culprit --port "$PORT" "${ARGS[@]}"
fi

# ==============================================================================
# 2b. SERVICE (default) -- ask, then install + enable + start the user service
# ==============================================================================
UNIT="$HOME/.config/systemd/user/culprit.service"

setup_service() {
    # Bind host: an explicit CULPRIT_HOST wins; otherwise use the config's host,
    # and if that is loopback while a remote deploy_host is set (agents are meant
    # to reach this box), offer to open it to all interfaces.
    local host port expose_default
    port="$(config_port)"
    read -r host expose_default < <(.venv/bin/python - <<'EOF'
import os
from culprit import config
c = config.load()
host = os.environ.get("CULPRIT_HOST") or getattr(c, "host", "127.0.0.1") or "127.0.0.1"
dh = (getattr(c, "deploy_host", "") or "").strip()
remote = bool(dh) and not (dh.startswith("127.") or dh.startswith("localhost"))
print(host, "y" if remote else "n")
EOF
)
    if [ -z "${CULPRIT_HOST:-}" ] && [ "$host" != "0.0.0.0" ]; then
        local d="[y/N]"; [ "$expose_default" = "y" ] && d="[Y/n]"
        local ans; read -rp "  Bind to all interfaces (0.0.0.0) so remote agents can reach it? $d " ans || true
        ans="${ans:-$expose_default}"
        case "$ans" in [yY]*) host="0.0.0.0" ;; esac
    fi

    mkdir -p "$HOME/.config/systemd/user"
    cat > "$UNIT" <<UNIT
[Unit]
Description=culprit machine-health dashboard (host)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$HERE
ExecStart=$HERE/.venv/bin/python -m culprit --no-browser --host $host --port $port
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

    systemctl --user daemon-reload
    systemctl --user enable --now culprit
    if ! loginctl enable-linger "$USER" >/dev/null 2>&1; then
        echo "  note: run 'sudo loginctl enable-linger $USER' so it starts on boot / survives logout"
    fi
    echo
    if systemctl --user is-active --quiet culprit; then
        echo "  culprit.service is installed and running (as $USER)."
    else
        echo "  culprit.service installed but not active -- check: systemctl --user status culprit"
    fi
    local shown="$host"; [ "$host" = "0.0.0.0" ] && shown="<this-host-ip>"
    echo "  dashboard: http://$shown:$port/"
    echo "  manage:    systemctl --user status|restart|stop culprit"
}

if [ ! -t 0 ]; then
    echo
    echo "non-interactive shell -- not prompting."
    echo "  run it:              ./culprit.sh --run"
    echo "  set up the service:  re-run ./culprit.sh from a terminal"
    exit 0
fi

echo
if systemctl --user is-active --quiet culprit 2>/dev/null; then
    # A service is already running -- default to NO so a stray Enter never
    # restarts it out from under you.
    read -rp "A culprit service is already running. Reconfigure and restart it? [y/N] " reply || true
    case "${reply:-n}" in
        [yY]*) setup_service ;;
        *) echo "  left as-is. (edit ~/.config/systemd/user/culprit.service to change it)" ;;
    esac
else
    # First-time setup -- default to YES: Enter installs the service.
    read -rp "Set up culprit as a systemd service (start on boot, auto-restart)? [Y/n] " reply || true
    case "${reply:-y}" in
        [nN]*) echo "  skipped. start it any time with:  ./culprit.sh --run" ;;
        *) setup_service ;;
    esac
fi
