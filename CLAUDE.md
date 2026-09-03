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

### The verification tools — run after any change, they catch real bugs

```bash
.venv/bin/python tools/smoketest.py        # exercises every collector against THIS machine; prints
                                           # timings + a per-source availability matrix; asserts
                                           # process coverage == len(psutil.pids())
.venv/bin/python tools/check_frontend.py   # ES-module graph: every import resolves to a real export
                                           # (no bundler exists to catch a bad import)
.venv/bin/python tools/check_contract.py --user <name> --password <pw>   # every field the JS views
                                           # read is present in the live API (needs a running server;
                                           # --user/--password only when auth is on)
.venv/bin/python tools/audit_security.py   # static: unescaped HTML sinks, public-allowlist drift,
                                           # dynamic SQL, cookie flags, unbounded decompression,
                                           # tracked credentials, file modes
.venv/bin/python tools/check_security.py --user <name> --password <pw>   # live black-box scan: every
                                           # route (enumerated from app.routes) bounces without a
                                           # session, path/header bypasses, forged cookies, login
                                           # enumeration + timing, agent-token rejection, headers,
                                           # CORS, injection, write validation. Safe by default;
                                           # --active adds a throwaway-agent lifecycle and exhausts
                                           # the login limiter (locks that address out for 5 min)
.venv/bin/python tools/scan_unauth.py      # live: hit every route (enumerated from app.routes) with
                                           # no cookie and no token; a gated route that answers with
                                           # anything but 401 / a 303 to /login is the finding. The
                                           # blunt subset of check_security's gate group, read at a
                                           # glance. Read-only unless auth is on (writes bounce at the
                                           # gate); skips writes when auth is disabled so nothing mutates
.venv/bin/python tools/check_auth.py       # offline (~7s): the credential logic against a temp DB --
                                           # scrypt, session HMAC/tamper/expiry/revocation, limiter,
                                           # agent tokens, command-result scoping, bounded gzip,
                                           # startup refusal, config patches, the gate table,
                                           # the proxy / Host trust rules (culprit/trust.py)
.venv/bin/python tools/check_ingest.py --throwaway-user   # live: 94 token-bypass shapes must all
                                           # 401; then 45 hostile reports from a valid token (wrong
                                           # types, NaN, JSON bombs, overflow ints, huge strings,
                                           # absurd intervals, made-up sections) must never 5xx the
                                           # ingest or break /api/nodes, /api/fleet, the node
                                           # snapshot or the SSE frame; plus the two-agent isolation
.venv/bin/python -m pyflakes culprit tools # lint
```

Security invariants the two security tools pin down (a change to any of them must update the tool in the same commit): the public path allowlist in `auth.py` is mirrored as `EXPECTED_PUBLIC_*` in both tools; every response carries nosniff / `X-Frame-Options: DENY` / `frame-ancestors 'none'` / `Referrer-Policy`, and `/api/*` is `Cache-Control: no-store` (`_harden` in `main.py`); gzip reports are inflated through a bounded `decompressobj` (`_inflate`), never `gzip.decompress`; session signatures mix in the user's password hash (`Auth._key`) so a password change revokes every session; the unknown-user login path costs exactly one scrypt (`_dummy_hash`) so latency cannot enumerate usernames. Values interpolated into `innerHTML`/`html:` templates in `web/js` must go through `esc()` or be a static `icons.*` string — the audit fails otherwise. Reports are sanitised before they touch node state (`sanitise_report` in `nodes.py`: allow-listed sections, dict-typed, depth-capped, ints that fit a float, no lone surrogates, intervals clamped to 0.2–60s) and NaN/Infinity is refused at parse; a bad report gets a 400, never a 500, and a poisoned snapshot is impossible by construction. `CommandBroker.resolve` accepts a result only from the node the command was queued for. A session can only verify for a user that exists (`Auth._key` returns None otherwise). uvicorn's proxy-header trust is pinned off; `culprit/trust.py` does the job in the middleware before the gate: a forwarding header from a peer not in `trusted_proxies` (Settings › Network trust, plus `--trust-proxy` for one run) is **refused with 400** rather than ignored, and from a declared proxy the right-most untrusted hop becomes `request.client` (the scope is rewritten), so a client can never pick the address the login limiter keys on. `trusted_hosts` is an opt-in Host allow-list (loopback always passes); the settings endpoint refuses a save that would cut off the connection making it (`_lockout_guard`). The default for `trusted_proxies` must stay empty — the audit pins it. The 422 handler never echoes the input.

There is **no unit-test suite** by design: what breaks here is environmental (a sysfs path a distro moved, a kernel without PSI, a gated journal), which only the real machine reveals — hence `smoketest.py`. When you add or rename a payload field, update `tools/check_contract.py`'s `CONTRACT` map in the same change or the frontend silently degrades.

## Commits

Commit messages carry **no attribution trailers, ever**: no `Co-Authored-By: Claude ...`, no `Claude-Session:` line, nothing that names the tool. The history reads as the maintainer's own work; the two pushed commits that once carried these lines were rewritten and force-pushed to strip them, so adding one back is a regression, not a default. Other sessions may be editing this checkout at the same time — stage by explicit path, never `git add -A`, and leave files you did not touch out of your commit.

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

**Look and vocabulary (2026-09 redesign).** A flat, rule-divided instrument panel — quiet, faintly cool greys for the chrome and vivid status/metric hues and accent on top (the colour is the signal; the chrome stays out of its way) — no boxes inside boxes, no cards. CSS is four files: `base.css` (tokens: `--bg..--bg-4`, `--line/--line-2`, `--fg..--fg-3`, one `--accent`, status `--ok/--info/--warn/--high/--crit` with `-bg` tints, metric hues `--m-*`), `shell.css` (top bar, sidebar tabs, `.stack`/`.cols`/`.cells` layout grids), `ui.css` (components), `mobile.css`. Build views from the shared primitives, never ad-hoc markup: `viewHead`, `section` (`.sec`, a titled area separated by rules), `figures` (stat strip), `.facts` grids, `kv`/`kvs`, `pill`, `meter`, `logItem`, `offenderRow` in `views/shared.js`; `banner` (system notices only — action feedback is inline), `note`, `segmented`, `switchControl`, `combobox`, `checkTree`, `searchField`, dialog helpers in `ui.js`. The Overview is a single column of full-width bands so nothing variable-height sits beside something tall; things that can be empty (offenders, incidents) collapse to a one-line note instead of an empty panel.

**Loading states.** Every slot that fills asynchronously goes through `pendingSlot(slot, skeleton)` / `readySlot(slot, node)` (`ui.js`): shape-matched skeletons (`skeletonFleet`, `skeletonStatus`, `skeletonFigures`, `skeletonFacts`, `skeletonSection`) held ≥320 ms so fast responses don't flash, and each view's `viewHead(...).setPending()` skeletons the title with its content. `index.html` ships a static boot skeleton that `app.js` clears on the first mount. `store.setNode()` deletes the metric sections so a node switch drops every view back to skeletons until the new node's snapshot lands; `store.state.nodesKnown` separates "node list not received yet" from "no agents" so the fleet never flashes an empty state. There is no warm-up card: the host is an aggregator and is always ready.

**Verifying UI changes.** `check_frontend.py` proves the module graph, not runtime behaviour. For that, a headless run works on the dev box without touching the repo: fetch a Node tarball into the scratchpad, `npm i jsdom` (fast, catches runtime errors and skeleton counts) and/or `npm i playwright-core` + `npx playwright-core install chromium-headless-shell` (real rendering — the only thing that catches broken HTML nesting and layout), sign in with a throwaway user (`printf 'pw\npw\n' | .venv/bin/python -m culprit users add <name>`; `getpass` reads stdin without a tty; `users remove` afterwards), walk every `.nav__item`, collect console errors, screenshot. After editing static HTML by script, verify nesting — a mis-cut closing tag once left skeleton nodes outside their wrapper and they never cleared.

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
