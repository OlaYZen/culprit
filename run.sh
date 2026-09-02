#!/usr/bin/env bash
# Idempotent launcher: installs if needed, picks a free port if the configured
# one is taken, then starts the server.
#
#   ./run.sh                 # default port (8787 or config.json's)
#   ./run.sh --port 9000     # explicit port
#   ./run.sh --no-browser    # do not try to open a browser
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
    ./install.sh
fi

PORT=""
ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        *) ARGS+=("$1"); shift ;;
    esac
done

if [ -z "$PORT" ]; then
    PORT=$(.venv/bin/python - <<'EOF'
from culprit import config
print(config.load().effective_port)
EOF
)
fi

# If the configured port is busy (a previous instance, or something else),
# walk forward to the first free one rather than dying with a bind error.
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
if [ "$PORT" != "$ORIGINAL" ]; then
    echo "port $ORIGINAL is in use; using $PORT instead"
fi

exec .venv/bin/python -m culprit --port "$PORT" "${ARGS[@]}"
