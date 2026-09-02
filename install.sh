#!/usr/bin/env bash
# Create the venv, install dependencies, verify imports, and print what is
# available on this machine and what is gated (and by exactly which group or
# capability). Idempotent: safe to re-run after a pull.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null; then
    echo "error: python3 not found. Install it (e.g. sudo apt install python3-venv)." >&2
    exit 1
fi
if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
    echo "error: Python 3.11+ required, found $("$PYTHON" --version)." >&2
    exit 1
fi

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

echo
echo "done. start with:  ./run.sh"
echo "or install the user service:  cp culprit.service ~/.config/systemd/user/ && systemctl --user enable --now culprit"
