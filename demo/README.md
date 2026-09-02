# culprit demo

Bring up the whole thing — the **host dashboard** plus one **reporting agent** —
with a single command, no manual token step.

## Run it

Clone both repos side by side (the agent is a separate repo), then start the
demo from the host repo:

```bash
git clone https://github.com/OlaYZen/culprit.git
git clone https://github.com/OlaYZen/culprit-agent.git   # sibling folder
cd culprit
docker compose -f demo/docker-compose.yml up --build
```

Then open <http://localhost:8787> and sign in with **`admin` / `admin`** (the
default account the host creates on first run — change it in Settings ›
Account). You'll see a **`demo-agent`** node reporting; click its card to view it.

Stop and clean up with:

```bash
docker compose -f demo/docker-compose.yml down -v
```

## How it works

- **host** builds from this repo's `Dockerfile` and runs the dashboard. Its demo
  entrypoint (`demo/host-entrypoint.sh`) enrolls a `demo-agent` on startup and
  writes the token to a shared volume.
- **agent** builds from the sibling `culprit-agent` repo, reads that token
  (`CULPRIT_TOKEN_FILE=/shared/token`), and reports to `http://host:8787`.

This is a **demo**: the agent reports from inside its own container (it still
sees the machine's CPU and memory through `/proc`, but only the container's
processes). To monitor a real host — its processes, sockets, systemd units and
journal — deploy the agent natively or with the agent repo's own
`docker-compose.yml`, which runs it in the host's PID and network namespaces.
