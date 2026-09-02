#!/bin/sh
# Demo provisioning: enroll a "demo-agent", share its token with the agent
# container over a volume, then run the dashboard. Auth is on with the default
# admin/admin account (created on first run). This exists only for the demo
# compose — a real host just runs `python -m culprit`.
set -e

TOKEN_FILE="/shared/token"
mkdir -p /shared

python - "$TOKEN_FILE" <<'PY'
import sys
from culprit import config as c
from culprit.db import History

history = History(c.load().resolved_db_path, enabled=True)
token = history.add_agent("demo-agent")   # (re)enroll: a fresh token each start
history.close()
with open(sys.argv[1], "w") as fh:
    fh.write(token)
PY

echo "demo: enrolled 'demo-agent'; token shared at $TOKEN_FILE"
exec python -m culprit --no-browser
