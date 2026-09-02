# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Culprit is a Linux machine-health dashboard that **names what is making a machine slow** (which process / systemd unit is responsible, and whether a number is a problem at all) rather than just showing utilisation. It was ported from a Windows-only build; comments still reference the Windows version to explain *why* a decision was made — keep that "why the Windows approach doesn't apply here" style when it aids understanding, but there must be **no Windows code paths**.

One machine runs the **host** (dashboard + FastAPI + SQLite). Other servers run a report-only **agent** that pushes snapshots to the host and has full feature parity including remote process actions. The agent lives in its own self-contained, deployable folder **`culprit-agent/`** (agent.sh + a duplicate copy of the runnable `culprit` package); the host no longer samples itself and `culprit/agent.py` no longer exists — `python -m culprit.agent` runs only from inside `culprit-agent/`.

## Commands

```bash
./install.sh                    # host: create .venv, install deps, print the source-availability matrix
./run.sh [--port N] [--no-browser]   # host: idempotent launch (installs if needed, picks a free port)
CULPRIT_HOST=0.0.0.0 ./run.sh   # bind to a network address (requires a user to exist first)

.venv/bin/python -m culprit                     # run the host directly
.venv/bin/python -m culprit --host 0.0.0.0 --no-browser
.venv/bin/python -m culprit users add <name>    # create a dashboard user (prompts for password)
.venv/bin/python -m culprit agents add <name>   # enroll an agent (prints token ONCE)

# Agent: deploy the self-contained culprit-agent/ folder to the target server, then:
cd culprit-agent && ./agent.sh <host-url> <token>   # bootstrap venv (psutil only) + save config + run
./culprit-agent/sync-package.sh   # maintainer: refresh culprit-agent/culprit/ from the host package
```

### The three verification tools — run after any change, they catch real bugs

```bash
.venv/bin/python tools/smoketest.py        # exercises every collector against THIS machine; prints
                                           # timings + a per-source availability matrix; asserts
                                           # process coverage == len(psutil.pids())
.venv/bin/python tools/check_frontend.py   # ES-module graph: every import resolves to a real export
                                           # (no bundler exists to catch a bad import)
.venv/bin/python tools/check_contract.py --user <name> --password <pw>   # every field the JS views
                                           # read is present in the live API (needs a running server;
                                           # --user/--password only when auth is on)
.venv/bin/python -m pyflakes culprit tools # lint
```

There is **no unit-test suite** by design: what breaks here is environmental (a sysfs path a distro moved, a kernel without PSI, a gated journal), which only the real machine reveals — hence `smoketest.py`. When you add or rename a payload field, update `tools/check_contract.py`'s `CONTRACT` map in the same change or the frontend silently degrades.

## Architecture

### Sampling: four tiers, one snapshot store, SSE fan-out

`culprit/sampler.py` runs four independent loops at four cadences, each in its own single-threaded executor (so one slow tier can't starve another):

- **fast** (1s, ~2ms): cpu, memory, PSI, gpu, disk+net rates — `cpu_mem.py`, `gpu.py`, `disks.py`, `network.py`
- **proc** (2s, ~25ms): the full process table + lag scoring — `processes.py`, `lag.py`
- **slow** (20s, ~0.5–1s): systemd units + cgroups, mounts, sockets, listening ports, sync — `services.py`, `disks.py`, `network.py`, `ports.py`, `sync.py`
- **events** (120s, ~0.6s warm / ~10s cold): journal, crash files, pending reboot — `events.py`

Collectors write into an in-memory `Store` (`state.py`); every HTTP read serves from the store (never samples on demand). `Broker` (`state.py`) pushes per-tier deltas to the browser over SSE. Frontend `web/js/stream.js` mirrors this: views `store.on(section, …)` and are only called when that section changes.

### The data-source layer replaces both Windows layers

`culprit/linux.py` is the single low-level layer (replaces the deleted `pdh.py` + `wmi.py`): `/proc` and `/sys` file reads, cgroup v2 stats, PSI parsing, and `systemctl`/`journalctl`/`loginctl`/`lsblk`/`ip` as `-o json` subprocesses. **Do not add a D-Bus dependency** — measured, subprocess JSON is ~12ms and D-Bus buys nothing here. `linux.py` documents two journalctl performance cliffs (a `+` match disjunction disables cursor seeking → 26s; `--after-cursor` + `-n` hangs) — respect them.

### The Lag Doctor is the point

`lag.py` scoring is two-stage and this ordering is load-bearing: (1) a 0..1 pressure per resource — **PSI drives it where the kernel has it**, the derived model is a labelled fallback; (2) each process scored by its share of a resource *gated by that resource's pressure* (0.3 floor). Findings fire only after N sustained samples. Field names in payloads deliberately preserve Windows-era names where semantics map, so the frontend keeps working — a rename must touch the collector, the view, and `check_contract.py` together.

### Honesty discipline — the project's distinguishing quality

Every optional source degrades to an explicit `available: False` + `reason`, never a blank panel or a lying zero. Missing ≠ zero: unreadable per-process IO renders an em dash and the payload counts how many were gated. Every gated source names the **exact** group/capability that unlocks it (see `sysinfo.py` `_access_map`). Preserve this in any new collector.

### Frontend: no build step

`web/` is vanilla ES modules — no npm, no bundler, no CDN. Canvas charts read colours from CSS custom properties so they follow the theme toggle. The process table reconciles rows by PID (never rebuilds the tbody — that destroys selection/hover). This architecture is intentional; don't introduce a toolchain.

**UX rules:** for any frontend/UI work, follow [`docs/ux-rules.md`](docs/ux-rules.md) (the uxgoodpatterns catalogue — modals, inline feedback, skeleton vs spinner, toggles vs checkboxes, searchable selects, etc.). The codebase already cites these by name in comments (`uxgoodpatterns: …`); keep applying them and keep the local copy as the source of truth.

### Multi-node (host + agents)

- **Agents** (`agent.py`) run the same collectors/sampler but no FastAPI/SQLite — psutil + stdlib only. Strictly **outbound**: they gzip-POST snapshots to `/api/agents/report` on their own cadence (1s default), **delta-compressed** (a section is resent only when its object identity changed; full snapshot once a minute).
- **Host** (`main.py` + `nodes.py`): `NodeRegistry` keeps each agent's latest snapshot in memory and folds fast-tier sections into the same rollup pipeline as local (per-node `node` column in every history table, `db.py` schema v2).
- **The response is the only downlink to a push-only agent.** The report response carries: `known` (false after a host restart → agent resends full), `settings` (the titlebar Refresh control retunes a remote agent's `interval_fast` this way), and `commands`.
- **Remote process actions** (`nodes.py` `CommandBroker`): the dashboard queues a command (detail / terminate / renice), the agent picks it up in its next report response, runs it with the identical `processes.py` functions (same guards: PID 1, kernel threads, critical processes, self), and POSTs the result back immediately (~0.2s round-trip). Frontend routes via `procBase()` in `web/js/views/shared.js` → `/api/nodes/<node>/processes/…` when remote.
- Overview has a fleet grid (`/api/fleet`, compact per-node summaries); clicking a card switches the viewed node.

### Auth (`auth.py`)

- **Users**: scrypt-hashed passwords in SQLite, HMAC-signed session cookies (per-install secret in `meta`), per-IP login rate limit. One middleware gates everything; only login/health/agent-ingest are open.
- **Agents**: bearer tokens `<name>.<secret>`, only the SHA-256 is stored (token shown once at enrollment), constant-time verified, revocable individually. Token management is in the web Nodes view (`/api/agents` endpoints, session-gated); the CLI is the bootstrap fallback.
- **Safety invariant**: the host **refuses to bind a non-loopback address while zero users exist** (`refuse_exposed_without_users`) — an unauthenticated dashboard with a kill button must never be network-reachable by accident. `db.py` chmods the database 600 (it holds credential hashes).

## Deployment artifacts

- Host: `install.sh`, `run.sh`, `culprit.service` (systemd **user** unit), `requirements.txt`, the `culprit/` package (with `main.py`/`auth.py`/`nodes.py`), `web/`.
- Agent: the entire **`culprit-agent/`** folder — `agent.sh`, `requirements-agent.txt` (psutil only), `culprit-agent.service`, `sync-package.sh`, and its own `culprit-agent/culprit/` copy of the runnable package. `cp -r culprit-agent <target>` deploys it as one self-contained unit.
- **The bundle's `culprit-agent/culprit/` is a duplicate** of the host `culprit/` package minus the host-only `main.py`/`auth.py`/`nodes.py`, plus the agent-only `agent.py`. After editing any shared code (collectors, sampler, db, state, config, linux, util), run `./culprit-agent/sync-package.sh` to refresh the copy (it preserves `agent.py` and skips host-only files). Verify the bundle with an import test (`PYTHONPATH=culprit-agent python -c "import culprit.agent"`).
- The dashboard binds `127.0.0.1` and has no TLS by default; agents crossing an untrusted network need `--ssl-certfile/--ssl-keyfile` on the host (or a proxy) and `https://` (or `--insecure` for self-signed).

## Gotchas

- `config.json` and `agent.json` are runtime state (gitignored). `agent.json` holds the agent's token — chmod 600.
- The dev/target machine is a headless KVM Ubuntu 24.04 guest: no GPU driver (GPU degrades to "unavailable"), no smartmontools, an NFS mount that must never be `statvfs`'d, cgroup v2, PSI enabled, systemd 255.
- Commit charge is shown always but **alerted on only under strict overcommit** (`vm.overcommit_memory=2`) — under the default heuristic policy `Committed_AS` exceeding `CommitLimit` is normal.
- Probe before building a new source: confirm the sysfs/proc path and *measure the cost* on the target, the way the existing collectors were built.
