# Culprit

A dashboard that watches your Linux machines and **names what is making them
slow** — not just how busy they are.

`top` gives you a number. Culprit tells you which process (or systemd unit) is
responsible for it, and whether that number is a problem at all. One machine
runs the **host** — the dashboard, API and SQLite database — and every machine
you want to watch runs a report-only **agent** that pushes its data to the host.
The host is a pure aggregator: it does not monitor itself, so to watch the
host's own hardware you run an agent on it too. Agents live in a separate,
self-contained repo — **[culprit-agent](https://github.com/olayzen/culprit-agent)**.

Python + FastAPI backend, no-build vanilla frontend, one SQLite file for
history and credentials. Runs unprivileged; nothing is installed outside the
project folder.

```
./install.sh      # one time: creates .venv, installs deps, prints what is
                  # available on this machine and what is gated (and by what)
./run.sh          # every time after that
```

Then <http://localhost:8787/>. To run it permanently:

```
mkdir -p ~/.config/systemd/user
cp culprit.service ~/.config/systemd/user/
systemctl --user enable --now culprit
loginctl enable-linger $USER    # keep it alive when you log out
```

**Authentication is always on.** On first run with no users, Culprit creates a
default **`admin` / `admin`** account and logs a warning — change it immediately
in **Settings › Account** (rename the user and/or set a new password), or from
the CLI. As a backstop the server still refuses to bind a non-loopback address
if it somehow has zero users, so an open dashboard with a kill button can never
be reachable by accident. To expose it:

```
CULPRIT_HOST=0.0.0.0 ./run.sh                    # or set "host" in config.json
.venv/bin/python -m culprit users add <name>     # add or replace users from the CLI
```

**Docker** — there's a `Dockerfile` for the host, and a published agent image
(`ghcr.io/olayzen/culprit-agent`, from the
[culprit-agent](https://github.com/OlaYZen/culprit-agent) repo).

---

## What it watches

| | |
|---|---|
| **Processor** | Per-core utilisation from `/proc/stat` with **iowait and steal** broken out (steal matters on VMs), runnable-queue depth, load averages, D-state count, clock, governor, context switches |
| **Pressure (PSI)** | The kernel's own stall accounting from `/proc/pressure/*`: the measured fraction of wall time tasks spent waiting on CPU, memory or IO — `some` vs `full`, and per systemd unit too |
| **Memory** | MemAvailable (the honest field), commit charge vs limit (alerted only under strict overcommit), **major-fault rate** (real paging), swap in/out, OOM-kill counter, dirty/writeback |
| **GPU** | A backend chain — DRM fdinfo (cross-vendor, per-PID), NVML (NVIDIA), amdgpu sysfs — each degrading to an explicit reason when absent |
| **Disk** | Per-device throughput, **in-flight queue and iostat-style await latency** from `/proc/diskstats` (layered dm/md devices never double-counted), mount capacity via `f_bavail` (what a *user* can write; ext4's root reserve shown separately), SSD/HDD identity |
| **Network** | Per-interface throughput, errors and drops, IP/gateway/DNS (real upstreams from systemd-resolved, not the 127.0.0.53 stub), socket table with honest PID attribution, VPN detection, TCP reachability probes that report a silent gateway as *filtered*, never *down* |
| **Ports** | The port map: every listening TCP/UDP port resolved to the process **and systemd unit** behind it, whether it is exposed off-box or bound to loopback, live inbound-connection counts — and a **one-click kill** that terminates whatever holds the port (the same guarded action as End task, so PID 1 and critical services are refused). Sockets owned by another user show without a PID and say so, never a lie |
| **Processes** | Every process from a direct `/proc` scan: CPU, memory, disk I/O (block-level, kept separate from syscall-level), **scheduler run delay** (time runnable but starved of a CPU), per-process major faults, D-state with the blocking kernel function (`wchan`), threads, FDs, PSS in the detail panel |
| **Services** | Every systemd unit (system *and* `--user` bus) with `Result` naming why a failure happened (oom-kill, timeout, exit-code), `NRestarts` for restart loops, timers — and **exact per-unit CPU / memory / IO / PSI from each unit's cgroup** |
| **Events** | From journald: OOM kills, segfaults and core dumps, hung-task reports, disk/filesystem errors, MCE hardware errors, unit failures, unclean shutdowns, failed sign-ins, journald's own rate-limiting (so gaps are honest), apt package history, crash artefacts in `/var/crash`, pending-reboot state (flag file + kernel version + the `needrestart`-style deleted-library scan) |
| **Sessions** | Sign-in history from logind's journal paired on session id, current sessions with **lock state readable unprivileged** (the inverse of Windows), boots and shutdowns |
| **Sync** | A plugin chain: Syncthing (REST), rclone (rc), abraunegg onedrive (user unit + journal), Nextcloud, Dropbox — plus an **inotify watch-exhaustion** panel, the failure mode that silently breaks sync while every status light stays green |
| **Trends** | Everything above rolled up on disk, so you can ask what was happening at 14:20 yesterday |

---

## The Lag Doctor

Resource *usage* is not the same as a *problem*. A process holding 6 GB on a
machine with 40 GB free is not hurting anyone, and ranking by raw memory puts
it at the top every time. So scoring is two-stage:

1. A **0..1 pressure per resource**. Where the kernel has PSI (≥ 4.20 with
   `CONFIG_PSI=y`), pressure *is* the kernel's measured stall time — the honest
   version of what the Windows build had to approximate from utilisation,
   queues and latency. The derived model remains as a labelled fallback and as
   the explanatory sub-signals. One deliberate exception: low MemAvailable
   still raises memory pressure even while PSI is quiet, because PSI only
   fires once reclaim already hurts.
2. Each process scored by its **share of each resource, gated by that
   resource's pressure** (floor 0.3, so an idle machine still shows its top
   consumers without pretending they are a problem). Scheduler run delay is
   folded into the CPU term — direct evidence of starvation Windows could not
   see — and sustained D-state scores ungated, because a process stuck in
   uninterruptible sleep is being made to wait regardless of any counter.

Findings only fire after N consecutive samples (default 5), each names its
evidence and how long it held, and culprits are ranked by *that* resource —
with one refusal built in: when per-process IO is permission-gated, the disk
finding shows **no** culprits rather than a made-up ranking.

There is no "not responding" signal here: window responsiveness does not exist
for a headless box or a Wayland session, and faking it would be worse than
saying so. The kernel-level substitutes (D-state + wchan, run delay, hung-task
journal reports, PSI `full`) are arguably more direct evidence anyway.

---

## Multi-node: host + agents

The host is the machine you just installed. Every other server runs an
**agent**: the same collectors and the same honesty rules, but no dashboard,
no FastAPI, no open ports — its only dependency is psutil, and its only
network behaviour is an outbound gzipped POST to the host every second
(delta-compressed: unchanged sections are not resent, so the steady-state
report is a few KB). The dashboard's Refresh control retunes a selected
agent's cadence live — the host piggybacks the request on its response to
the agent's next report, so agents stay strictly push-only.

**Enroll on the host** (prints the token exactly once — only its hash is
stored):

```
.venv/bin/python -m culprit agents add web-01
```

**Deploy on the target server** from the separate, self-contained
[culprit-agent](https://github.com/olayzen/culprit-agent) repo — it carries its
own copy of the runnable package, so nothing from this repo is needed:

```
git clone https://github.com/olayzen/culprit-agent.git
cd culprit-agent
./agent.sh https://<host>:8787 web-01.<secret>     # first run saves agent.json
cp culprit-agent.service ~/.config/systemd/user/   # run it permanently
systemctl --user enable --now culprit-agent
loginctl enable-linger $USER
```

The token is shown in the host dashboard's **Nodes** view (or `agents add`),
which also renders a ready-to-paste deploy command — its address and runner
(e.g. `sudo ./agent.sh`) are configurable in **Settings › Agent deployment**.

The dashboard grows a node picker in the title bar: every view — Overview,
Lag Doctor, Processes, Services, Ports, Events, Trends — renders whichever node
is selected. Remote data carries its age; if an agent goes silent, the title bar
says how stale the numbers are instead of letting them pass as live. Per-node
history rolls into the same SQLite pipeline, so Trends answers "what was
happening on web-01 at 14:20" too.

**Full parity, including actions.** Everything you can do to the host you can
do to an agent — live process detail (command line, sockets, PSS, per-thread
times, open files), End task, renice, and killing whatever holds a port from
the Ports view. Agents still never open a port: a
command is *queued* on the host, the agent picks it up in the response to its
next report (the same channel that carries settings), runs it with the
identical collector code the host runs on itself, and posts the result
straight back. Round-trip is about one report interval — ~0.2s at the 1s
default. The same guards apply remotely (PID 1, kernel threads, critical
processes and the agent itself are refused), and an agent honours its own
`allow_process_actions` config, so a read-only deployment is still one setting
away. `agents revoke <name>` cuts a node off immediately; rotating its token
does the same.

### Security model

* **Dashboard**: username/password (scrypt-hashed in SQLite), HMAC-signed
  session cookies (HttpOnly, SameSite=Lax, 7 days), login rate-limited per
  source address. Every API route and the SSE stream sit behind the session
  gate; only the login page, health check and agent ingest are open.
* **Agents**: per-node bearer tokens, SHA-256-hashed at rest, constant-time
  verification, revocable individually. Reports are size-capped.
* **Database**: `data/culprit.db` holds the credential hashes and is
  chmod 600. No plaintext secret is ever stored — a stolen database yields
  scrypt hashes and token hashes, not passwords or tokens.
* **Transport**: plain HTTP means tokens and cookies cross the wire readable.
  On anything but a trusted LAN, run TLS — either
  `python -m culprit --ssl-certfile cert.pem --ssl-keyfile key.pem` or a
  reverse proxy — and point agents at `https://`. For a self-signed
  certificate, `./agent.sh --insecure …` skips verification (the agent logs a
  warning every start, because it should).

---

## Privilege — granular, and named

There is no "run as administrator" here. Every gated source names exactly what
would unlock it, and `install.sh` prints the whole matrix up front:

| Wanted | Needs |
|---|---|
| System journal (events, sessions) | `systemd-journal` or `adm` group |
| Other users' `/proc/<pid>/io`, FD counts, open files | `CAP_SYS_PTRACE` (also gated by `yama/ptrace_scope`) |
| SMART / NVMe health | `CAP_SYS_RAWIO` or root, plus smartmontools |
| DMI serial numbers, `/var/log/btmp`, pstore | root |
| i915 PMU GPU counters | `CAP_PERFMON` or relaxed `perf_event_paranoid` |

Unreadable is never rendered as zero: per-process IO you cannot read shows an
em dash and the payload counts how many processes were gated.

---

## Performance

Measured on the dev machine — a 4-core KVM guest (Xeon Gold 6150, 4 GB RAM,
rotational QEMU disk), ~230 processes, 209 systemd units, 1.3 GB journal:

| Tier | Interval | Steady-state cost |
|---|---|---|
| fast (cpu, mem, PSI, gpu, disk, net) | 1 s | ~2–4 ms |
| proc (full table + lag scoring) | 2 s | ~25–40 ms |
| slow (units + cgroups, mounts, sockets, probes, sync) | 20 s | ~0.5–1.2 s |
| events (journal, crash files, pending reboot) | 120 s | ~0.6–1 s warm; the agent's **first** tick pays the cold journal cache (~10 s here) — the dashboard shows skeletons until it lands |

Total: well under 5% of one core, ~65 MB resident.

### Measurements that shaped the design

* **Direct `/proc` beats psutil for the table, 8 ms vs 45 ms** for a full scan
  of 230 processes — and the raw files carry things psutil's iterator does not
  surface (schedstat run delay, majflt, wchan). psutil keeps the jobs it is
  genuinely good at: the single-process detail panel, network counters,
  terminate/renice. (On Windows the same choice was 105 ms of PDH vs 13.5
  *seconds* of psutil; on Linux the gap is small enough that it had to be
  re-measured rather than assumed.)
* **`systemctl -o json` beats a D-Bus binding on total cost.** ListUnits via
  busctl and via subprocess both measure ~12 ms; three spawns per 20 s tick do
  not justify a jeepney dependency and D-Bus marshalling code.
* **journalctl has two performance cliffs**, both found by measurement and
  documented in `linux.py`: a `+` match disjunction silently disables cursor
  seeking (26 s instead of 16 ms), and `--after-cursor` combined with `-n`
  hangs outright. The auth-failure query — a needle in 56k sshd lines on this
  box — is incremental on a stored cursor for exactly this reason.

---

## Layout

```
culprit/
  config.py            defaults + config.json overrides + validation
  linux.py             /proc, /sys, cgroup, journal, systemctl helpers
  util.py              rate maths, ring buffer, sustain counters
  state.py             snapshot store + SSE fan-out
  db.py                SQLite: history rollups + users + agent tokens
  auth.py              sessions, password hashing, the request gate
  nodes.py             host-side registry of agent snapshots + rollups
  sampler.py           the four sampling loops
  main.py              FastAPI routes
  collectors/
    cpu_mem.py         /proc/stat, meminfo, vmstat, PSI      (fast tier)
    gpu.py             fdinfo / NVML / amdgpu backend chain  (fast tier)
    disks.py           diskstats + mountinfo/statvfs         (fast + slow)
    network.py         rates + config + sockets + probes     (fast + slow)
    processes.py       direct /proc scan + psutil detail     (proc tier)
    lag.py             pressures, scoring, findings
    services.py        systemd units + per-unit cgroup stats (slow tier)
    ports.py           listening-port map + kill attribution (slow tier)
    sync.py            sync-client plugins + inotify         (slow tier)
    events.py          journald, boots, sessions, reboots    (events tier)
    sysinfo.py         identity, virt/container, privilege map
web/                   no-build ES-module frontend
    index.html         shell + a static boot skeleton (painted before any JS)
    css/               base (tokens) · shell (chrome, grids) · ui (components) · mobile
    js/stream.js       SSE client + per-node store; js/app.js routing + chrome
    js/ui.js           primitives: dialog, banner, combobox, skeleton slots …
    js/views/          one module per view; shared.js = section/figure/pill/…
tools/                 smoketest, module-graph check, API-contract check
docs/                  ux-rules.md (uxgoodpatterns UI reference)
install.sh  run.sh  culprit.service          # host artifacts
```

The report-only agent is a **separate repo** —
[culprit-agent](https://github.com/olayzen/culprit-agent) — carrying its own
copy of the runnable package (collectors, sampler, db, state, config, linux,
util, agent). It is a duplicate of the shared modules above minus the host-only
`main.py` / `auth.py` / `nodes.py`; that repo's `sync-package.sh` refreshes it
from a host checkout after shared-code changes.

---

## Verifying it still works

```
.venv/bin/python tools/smoketest.py        # every collector against the real
                                           # machine, with timings and a
                                           # per-source availability matrix
.venv/bin/python tools/check_frontend.py   # ES module graph (no bundler exists
                                           # to catch a bad import)
.venv/bin/python tools/check_contract.py   # every field the views read is in
                                           # the live API. Since the host serves
                                           # no metrics of its own, the metric
                                           # views are validated against a
                                           # reporting agent node (--node, or the
                                           # first online one); add --user/--password
                                           # when auth is on
```

The smoketest asserts process coverage against `len(psutil.pids())` — ground
truth, not assumption. Destructive actions are refused for PID 1, kernel
threads, critical system processes and Culprit itself, and require an explicit
confirm flag.

---

## Notes and limits

* **Window responsiveness is not measurable.** X11 could best-effort
  `_NET_WM_PING`; on Wayland only the compositor knows, and on a headless box
  the concept does not exist. The UI relies on the kernel-level signals above
  and says so rather than quietly omitting a panel.
* **Per-process GPU coverage varies by driver.** DRM fdinfo needs kernel
  ≳ 5.19 and driver support; NVML needs `nvidia-ml-py` and a loaded driver;
  amdgpu sysfs is adapter-level only. Whatever is missing, the GPU panel says
  which backends were tried and why each declined.
* **Containers make `/proc` lie.** `systemd-detect-virt --container` (plus
  `/.dockerenv` and `/proc/1/cgroup`) is checked at startup; when containerised
  the UI warns that /proc-derived numbers may be the host's unless lxcfs is
  mounted.
* **Pending reboot is distro-specific.** Debian/Ubuntu flag file, running
  kernel vs newest installed, and the universal deleted-library scan are
  implemented; `dnf needs-restarting` (RHEL) would slot into
  `events.pending_reboot()`.
* **`%util` and queue depth are weak signals on multi-queue NVMe** — hardware
  queues overlap. Latency and PSI lead everywhere in the UI.
* **Journal persistence matters.** With only `/run/log/journal` (volatile),
  event history dies at reboot; the events view says which kind this machine
  has.
* Commit charge is shown always but **alerted on only under strict overcommit**
  (`vm.overcommit_memory=2`) — under the default heuristic policy,
  `Committed_AS` exceeding `CommitLimit` is normal on a healthy machine, and
  alarming on it would be confident nonsense.
