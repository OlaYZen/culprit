# Culprit host — the dashboard, API and SQLite history. Ingests report-only
# agents (see the separate culprit-agent repo / image). Auth is always on; a
# default admin/admin is created on first run — change it in Settings > Account.
#
#   docker build -t culprit .
#   docker run -d -p 8787:8787 -v culprit-data:/app/data culprit
#   open http://localhost:8787   (login: admin / admin)
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY culprit/ ./culprit/
COPY web/ ./web/

EXPOSE 8787
# Bind all interfaces so the mapped port is reachable; history + credentials
# live in /app/data (mount a volume to persist them).
ENV CULPRIT_HOST=0.0.0.0 PYTHONUNBUFFERED=1
CMD ["python", "-m", "culprit", "--no-browser"]
