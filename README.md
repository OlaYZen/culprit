<div align="center">

# Culprit

### Stop watching graphs. Find out what's actually slowing your machines down.

**A self-hosted Linux health dashboard that names the process (or systemd unit) making a machine slow, tells you whether the number is even a problem, and lets you fix it from the browser.**

</div>

---

> Your monitoring turns a tile red: **CPU 92%**. It doesn't tell you *which*
> process is responsible, whether 92% is actually hurting anything, or let you
> do a single thing about it. So you SSH in and start the detective work:
> `top`, `iotop`, `ss -tulpn`, `journalctl`, `systemctl status`, and the rest.
>
> **Culprit does that work for you, in a browser, across every machine you run,
> then hands you the kill switch.**

---

> **Try it before you install anything:** **[olayzen.github.io/culprit](https://olayzen.github.io/culprit/)**
> is the real dashboard running in your browser on a recording of a real five-machine
> fleet -- no backend, nothing leaves the page. Every few minutes an ffmpeg transcode
> saturates one node: watch the Lag Doctor name it, end it from the process dialog,
> and read the verdict. Actions are simulated there, and the banner says so.

---

## Contents

- [Why Culprit](#why-culprit) · [How it compares](#how-it-compares) · [Quick start](#quick-start) · [Watch more machines](#watch-more-machines)
- [What it watches](#what-it-watches) · [The Lag Doctor](#the-lag-doctor) · [Security & privacy](#security--privacy)
- [Privilege, named](#privilege-named) · [Performance](#performance) · [Notes & limits](#notes--limits)

---

## Why Culprit

Every monitoring tool answers *"how busy is this machine?"* Culprit answers the
question you actually have at 2 a.m.: **"what is making it slow, and does it
matter?"**

Three things make that possible, and they're the whole product:

### 1. It names the culprit, automatically

Culprit doesn't hand you twelve graphs and wish you luck. Its **Lag Doctor**
ranks the processes and services on each box by how much they're contributing to
a *real* bottleneck, and states its evidence: *"`postgres` (pid 2411): 74% of
disk pressure for the last 40 s."* No correlation, no guessing, no second tool.

### 2. It knows "busy" from "hurting"

A process pinning 6 GB on a machine with 40 GB free is not a problem, and
ranking by raw usage puts it at the top every time. Culprit scores every
resource by the kernel's own **Pressure Stall Information (PSI)**, the measured
fraction of time work is actually *stalled* waiting on CPU, memory or IO, so a
machine that's flat-out but keeping up stays calm, and one that's quietly
thrashing lights up. That's the difference between a threshold and a diagnosis.

### 3. It never lies to you

Every source that isn't available says **why**, and names the exact group or
capability that would unlock it. Per-process IO it can't read shows a dash, not
a `0`, and the payload counts how many processes were gated: **missing is never
rendered as zero.** In a field full of dashboards that quietly show `0` when
they can't read something, this is the feature that earns trust.

And when you've found the culprit, you **act on it**: End task, renice,
**throttle** (cap the whole unit's CPU and IO, reversibly), or kill whatever
holds a port, on any machine in the fleet, right from the same screen. Then
Culprit **tells you whether it worked**: it keeps sampling after every action
and states the verdict in plain words ("IO pressure fell 100% → 5%; the finding
cleared in 40 s", or "no change: `bash` was not the culprit, the next candidate
is `rsync`").

Ten more things follow from that loop:

- **It names the container, not the shim.** A runaway process inside Docker,
  Podman or Kubernetes is labelled with its container (and image, and compose
  service) wherever it appears, read from the cgroup path for free and from the
  runtime's socket when the agent may read it.
- **It says when nobody is at fault.** CPU steal from a noisy hypervisor
  neighbour, thermal or power throttling, swap on a spinning disk, processes
  stuck on an unanswering NFS server: these are reported as *outside this
  machine*, with no invented process ranking, and the same finding on several
  nodes at once is folded into one **shared cause** on the fleet view.
- **It pages on a diagnosis, never on a threshold.** ntfy, a webhook or e-mail
  gets one message per finding while it holds, with the node, the evidence and
  the named culprit, one more if it escalates, and a follow-up when it clears.
- **You can tell it what's normal.** Mark a finding as *expected* (nightly
  backup, 02:00–03:00, led by `borg`) and it reads as expected instead of as a
  problem, until it overruns its window. Nothing is inferred; a person wrote it
  down.
- **It sees pressure inside one unit.** cgroup v2 keeps the same PSI files
  for every service and container, so an idle machine with one service
  crawling is diagnosed as *"`nginx.service` is stalled on IO 40% of the time
  while the machine is at 3%"*, ranked among *its* processes. The most common
  reason turns out to be a cap: *"hitting its CPU quota in 100% of periods
  (20% of one core)"* or *"at its memory limit (97% of 512 MB)"*, with the
  cap's origin named, including a runtime `set-property` cap that Culprit's own
  Throttle left behind and nobody released.
- **It tells you what changed.** Units started, stopped or restarted, timers
  that fired, mounts, listeners, logins, package upgrades, quota changes,
  containers, and processes that appeared and stayed are written down with
  their time. Every finding carries what changed in the ten minutes before it
  began, labelled *coincides with, not proof of cause*; incidents in Trends
  carry the same.
- **It names what breaks next.** Hard limits fail outright, not slowly: a
  process at 3,900 of its 4,096 file descriptors, connection tracking near
  its table size, inotify watches nearly exhausted (the "sync stopped
  working" failure), a unit near its TasksMax. Each is watched against its
  own ceiling with the holder named, from half-way, and becomes a finding at
  80%. Alongside, *if memory runs out*: the kernel's own `oom_score` ranking
  says which process the OOM killer takes first, and the memory findings
  carry it.
- **It forecasts a full disk and names the writer.** Used space per mount is
  fitted over the last hour; *"/var will be full in about 3 h at +240 GB/day"*
  becomes a finding a day ahead, ranking the processes with open files under
  that mount by their write rate, and it points out space held by
  **deleted files still open** (the rotated log a daemon never closed), which
  a restart frees without a reboot.
- **It remembers what worked.** Every process dialog shows the track record
  of earlier actions on that name or unit on that node, judged by their
  verdicts: *"Throttle: helped 3 of 3, last 2 h ago · End task: no change 2 of
  2"*. And a finding that recurred at the same hour on three or more days, led
  by the same process, is offered as a suggested expectation with the window
  pre-filled; a person still confirms.
- **It explains the kernel.** `kworker/u8:3+flush-252:0` at 40% becomes
  *"writeback for device 252:0: the write reaching the disk, later than the
  process that did it"*; `kswapd0` is named a symptom of memory pressure, not
  a culprit; `ksoftirqd/2` pinned becomes *"core 2 is busy servicing
  interrupts for virtio1-input.0"* with the IRQ named; a RAID resync or a
  degraded array, dm-crypt's CPU cost, and a SCSI device being reset are
  reported as what they are, with progress where there is any.

---

## How it compares

Culprit isn't trying to replace your metrics database or your SIEM. It does the
one thing those tools leave to you: **the last mile of diagnosis, and the fix.**

| | **Culprit** | Zabbix / Nagios | Prometheus + Grafana | Netdata | SIEM · Splunk / Wazuh / ELK |
|---|:---:|:---:|:---:|:---:|:---:|
| **The question it answers** | *What's slowing this box, and does it matter?* | *Is a metric past a threshold?* | *Store & query metrics* | *Live metric dashboards* | *What security events happened?* |
| Names the responsible **process / unit** | ● built in | ○ you correlate + SSH | ○ | ○ | ○ |
| Tells **problem** from merely **busy** (kernel PSI) | ● | ○ static thresholds | ○ | ◑ | ○ |
| **Act** from the UI (kill port, End task, renice, throttle) and **verify** the action helped | ● | ○ | ○ | ○ | ○ |
| Names the **container** behind a PID | ● | ○ | ○ | ◑ | ○ |
| Says when the cause is **outside the machine** (steal, thermal, NFS, RAID rebuild, interrupts) | ● | ○ | ○ | ○ | ○ |
| Pressure and caps **inside one unit / container** (cgroup PSI, quota, memory limit) | ● | ○ | ○ | ◑ | ○ |
| Says **what changed** before a finding began | ● | ○ | ○ | ○ | ◑ logs |
| Names **what breaks next** (fd / conntrack / inotify ceilings with the holder, next OOM victim, disk-full ETA with the writer) | ● | ◑ thresholds | ◑ thresholds | ◑ | ○ |
| Shows **clients being turned away** (accept queue full, `ListenOverflows`) and names the listener | ● | ◑ node exporter counter, no port | ◑ counter | ○ | ○ |
| **Remembers** whether an action helped last time; suggests what is routine | ● | ○ | ○ | ○ | ○ |
| Pages on a **diagnosis**, not a threshold; "expected" windows | ● | ○ thresholds | ○ | ○ | ○ |
| Honest about gaps, **no lying zeros** | ● | ○ | ○ | ○ | ○ |
| **Setup** | one script, minutes | server + DB + agents + templates | services + exporters + dashboards | quick | heavy ingest pipeline |
| **Footprint** on a watched box | psutil only, **no open ports**, ~a few KB/s | agent + checks | node_exporter | agent | forwarder + indexers |
| **Purpose** | performance **triage & repair** | infra **alerting** | metrics **TSDB** | live **telemetry** | security **log analytics** |

● yes · ◑ partial · ○ no / not its job

### Why it stands out against a SIEM

A **SIEM** (Splunk, Wazuh, the ELK/Elastic stack, Graylog) exists to *ingest and
correlate logs* for threat detection, audit and compliance. It's powerful and
heavy, an indexing pipeline you feed, tune and pay for, and it answers *security*
questions about the past. It will happily store the logs of a machine grinding
to a halt without ever telling you a runaway `rsync` is the reason, or giving you
a button to stop it. **Different job.** Culprit is the performance doctor, not the
security historian; the two sit side by side.

### Why it stands out against Zabbix, Prometheus & friends

**Threshold monitors** (Zabbix, Nagios) and **metrics stacks** (Prometheus +
Grafana, Netdata) are essential for fleet-wide alerting and long-term trends;
keep them. But they're built around *utilisation*: a number crosses a line, a
tile goes red, a page fires. Then the real work starts, and it's manual: open a
terminal and run the same five commands every engineer runs, on the right box,
under pressure. Culprit is that muscle memory, already executed and reasoned
about:

- **Diagnosis, not dashboards.** It ships the *conclusion* (the named process
  and its evidence), not raw series for you to eyeball.
- **PSI over thresholds.** "90% CPU" is not a problem if nothing is waiting.
  Culprit gates every verdict on measured stall time, so it fires on real pain
  and stays quiet on healthy load: far fewer false alarms than a static line.
- **A verb, not just a view.** Find it *and* kill it, with guardrails (PID 1,
  kernel threads, critical services and Culprit itself are always refused).
- **Zero ceremony.** No query language, no exporters, no dashboards to build, no
  time-series database to operate. One script, one SQLite file, done.

Reach for Culprit when something is slow **right now** and you need the answer,
on one machine or across a fleet, without building anything first.

---

## Quick start

On the machine that will host the dashboard:

```bash
git clone https://github.com/OlaYZen/culprit.git
cd culprit
./culprit.sh
```

That's it. `culprit.sh` creates its own virtualenv, installs dependencies,
prints a matrix of what this machine exposes, and then **offers to install
itself as a systemd service** (start on boot, auto-restart); press **Enter** to
accept and it's enabled and running. Open **<http://localhost:8787>** and sign in
with the `admin` / `admin` account it created for you.

> **Change the default password immediately** in **Settings › Account**.
> Authentication is always on, and the server refuses to bind a public address
> while it has zero users, so an open dashboard with a kill button can never be
> reachable by accident.

Prefer to run it in your terminal instead of as a service? Use `./culprit.sh
--run` (add `--port N` or `--no-browser` as needed). Manage the service as
yourself, never with `sudo` (it's a *user* service):

```bash
systemctl --user status|restart|stop culprit
```

To reach it from other machines, bind all interfaces: `CULPRIT_HOST=0.0.0.0
./culprit.sh`. On anything but a trusted LAN, put TLS in front of it (see
[Security & privacy](#security--privacy)).

### Watch more machines

The host is a pure aggregator: it doesn't monitor its own hardware. Every
machine you want to watch (including the host itself) runs a tiny, report-only
**agent** that pushes snapshots to the host and **opens no ports of its own**.

**1. Enroll it on the host** (the token is shown once; only its hash is stored):

```bash
.venv/bin/python -m culprit agents add web-01
```

**2. Deploy the agent** from its own self-contained repo,
**[culprit-agent](https://github.com/OlaYZen/culprit-agent)**, or, for a
container host, the prebuilt image:

```bash
# native
git clone https://github.com/OlaYZen/culprit-agent.git
cd culprit-agent && sudo ./agent.sh      # asks for the host URL + token, then sets up the service

# docker (monitors the host it runs on)
docker run -d --name culprit-agent --restart unless-stopped --pull always \
  --privileged --pid host --network host \
  -e CULPRIT_HOST=http://<host>:8787 -e CULPRIT_TOKEN=web-01.<secret> \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  ghcr.io/olayzen/culprit-agent:latest
```

(The read-only Docker socket is what lets the agent *name* the containers its
culprits run in; without it they show as `docker <id>` with a note saying so.)

The dashboard's **Nodes** view enrolls agents and shows a ready-to-paste command
(native *and* Docker) with the token already filled in. A node picker appears in
the title bar, and **every view (Overview, Lag Doctor, Processes, Services,
Ports, Events, Trends) renders whichever node you select,** with full remote
action parity: process detail, End task, renice, throttle and port-kill all
work on agents, run by the identical collector code, with the same guards. If an
agent goes quiet, the title bar tells you how stale the numbers are rather than
letting them pass as live (and, if you have set up notifications, tells you).

---

### Try it without installing

The [demo](https://olayzen.github.io/culprit/) is this repository's own `web/`
served as a static site with an in-browser stand-in for the host
(`web/js/demo/`): the same views, charts and dialogs, answered from JSON that
`tools/record_demo.py` recorded off a real fleet and scrubbed (hostnames, users,
public addresses, MACs, machine ids). What it adds is the liveness a recording
cannot hold -- numbers that wander around their recorded values, one scripted
incident that repeats, an agent that went quiet -- and every write (end task,
renice, throttle, expectations, settings) acts on that in-browser world, with
the verdict watch judging the action the way the host would.

To run it yourself: `python3 tools/build_demo.py` writes `dist/demo/`; serve it
with any static server (`python3 -m http.server -d dist/demo 8080`). Any real
host also answers `?demo` on its URL, which is how the demo is developed. The
site on GitHub Pages is rebuilt by `.github/workflows/demo.yml` on every push,
so it never drifts from the frontend it demonstrates.

## What it watches

| Domain | What you get |
|---|---|
| **Processor** | Per-core utilisation from `/proc/stat` with **iowait and steal** broken out (steal matters on VMs), runnable-queue depth, load averages, D-state count, clock, governor, context switches |
| **Pressure (PSI)** | The kernel's own stall accounting from `/proc/pressure/*`: the measured fraction of wall time tasks spent waiting on CPU, memory or IO (`some` vs `full`), and per systemd unit |
| **Memory** | MemAvailable (the honest field), commit charge vs limit, **major-fault rate** (real paging), swap in/out, OOM-kill counter, dirty/writeback |
| **GPU** | A backend chain, DRM fdinfo (cross-vendor, per-PID), NVML (NVIDIA) and amdgpu sysfs, each degrading to an explicit reason when absent |
| **Disk** | Per-device throughput, **in-flight queue and iostat-style await latency** (layered dm/md devices never double-counted), mount capacity by what a *user* can actually write, a **fill forecast** per mount with the **processes writing there** and the space **held by deleted-but-open files**, SSD/HDD identity |
| **Network** | Per-interface throughput, errors and drops, real upstream DNS (not the `127.0.0.53` stub), socket table with honest PID attribution, **WAN IP + VPN detection** (including a router-level VPN, via the exit IP), reachability probes that call a silent gateway *filtered*, never *down* |
| **Ports** | Every listening TCP/UDP port resolved to the **process and systemd unit** behind it, exposed-vs-loopback, live inbound-connection counts, each listener's **accept queue against its backlog** with the kernel's turned-away rate (`ListenOverflows`) so a service that is dropping clients is named, and a **one-click kill** with the same guards as End task |
| **Processes** | A direct `/proc` scan of every process: CPU, block-level disk IO, **scheduler run delay** (runnable but starved of a CPU), major faults, D-state with the blocking kernel function (`wchan`), threads, FDs, PSS |
| **Services** | Every systemd unit (system *and* `--user`) with `Result` naming *why* it failed (oom-kill, timeout, exit-code), restart-loop counts and timers, plus **exact per-unit CPU / memory / IO / PSI from each cgroup**, and a **pressure-and-limits panel**: stall time inside each unit and container, CPU quota and how often it is hit, memory limit and how full it is, runtime caps |
| **Kernel** | What every busy kernel thread *is* (writeback, journal commit, reclaim, softirq, dm-crypt, RAID, ZFS, NFS…) and what it is a symptom of; `/proc/mdstat` sync progress; per-core interrupt and softirq rates naming the device behind a pinned core |
| **Ceilings** | File descriptors per process against its own `nofile` limit, system-wide file handles, threads, PIDs, `nf_conntrack`, inotify watches and instances, TasksMax per unit, each with its current value, its ceiling, its holder and the sysctl that raises it; the OOM killer's own victim ranking |
| **Changes** | A running record of what changed: units, timers, mounts, listeners, interfaces, routes, VPN, containers, quotas, packages, logins, newcomers among processes; attached to findings and incidents as *coincides with* |
| **Events** | From journald: OOM kills, segfaults & core dumps, hung-task reports, disk/filesystem and MCE hardware errors, unit failures, unclean shutdowns, failed sign-ins, package history, crash artefacts, and pending-reboot state |
| **Sessions** | Sign-in history from logind paired on session id, **current sessions with SSH logins named** (user + remote host), lock state, boots and shutdowns |
| **Sync** | Syncthing, rclone, OneDrive, Nextcloud, Dropbox, plus an **inotify watch-exhaustion** panel: the failure that silently breaks sync while every status light stays green |
| **Trends** | Everything above rolled up on disk, per node, so you can ask what was happening on `web-01` at 14:20 yesterday, with findings folded into **incidents** (start, end, peak, who led it for how many minutes, and every action taken with its verdict) |

---

## The Lag Doctor

Resource *usage* is not the same as a *problem*, so scoring is two stages:

1. **A 0-to-1 pressure per resource.** Where the kernel has PSI, pressure *is*
   the kernel's measured stall time; a derived model is the labelled fallback and
   the explanatory sub-signals. (One deliberate exception: low MemAvailable
   raises memory pressure even while PSI is quiet, because PSI only fires once
   reclaim already hurts.)
2. **Each process scored by its share of a resource, gated by that resource's
   pressure** (with a floor, so an idle box still shows its top consumers without
   pretending they're a problem). Scheduler run delay folds into the CPU term
   (direct evidence of starvation), and a process stuck in uninterruptible sleep
   scores regardless of any counter.

Findings fire only after several consecutive samples, each **names its evidence
and how long it held,** and culprits are ranked by *that* resource. When
per-process IO is permission-gated, the disk finding shows **no** culprits rather
than inventing a ranking, because a confident wrong answer is worse than an
honest "I can't see this."

Some findings have **no culprit on the machine at all**, and say so: CPU steal
(the hypervisor's other guests), thermal or power throttling (the CPU cutting its
own clock), swapping to a rotational disk (a hardware verdict, not a process's
fault), and processes stuck in the kernel's NFS, SMB or FUSE client (the file
server, or the network to it). These carry the blame in words and list no
process ranking, except the D-state victims, which are labelled as victims.

**Throttle** sits between renice and End task: it caps the CPU quota and IO
weight of the systemd unit or container scope the process runs in, via
`systemctl set-property --runtime`, so a backup or indexer is slowed rather than
killed and the cap survives forks. It acts on the whole unit, and the dialog
says how many processes that is before you apply it. System units need root or
a polkit rule; the agent reports exactly that when it lacks it.

After **every** action the host keeps watching the node's own findings and gives
a verdict: *helped* (the findings that named the process cleared, or their
resource's pressure halved), *partly* (some cleared; the rest is named, with who
leads it now), *no change* (with the next candidate), or *nothing to verify*
(nothing was under pressure). Verdicts are stored with the action and shown on
the incident in Trends.

**Inside one unit.** Every unit's cgroup carries its own `cpu.pressure`,
`memory.pressure` and `io.pressure`, its `cpu.max` quota with `cpu.stat`'s
count of throttled periods, and `memory.max` with `memory.events`. Three
findings come from that, each confined to the unit and ranking only its own
processes: *hitting its CPU quota* (throttled in ≥25% of scheduling periods;
the detail says whether the cap is the unit's configuration or a runtime
`systemctl set-property` drop-in, which is what Throttle creates and what a
reboot removes), *at its memory limit* (≥95% of `memory.max`, or the kernel
hitting the limit), and *stalled inside* (the unit's stall time over the
machine's threshold while the machine as a whole is under half of it). An OOM
kill confined to a unit is reported as such instead of as a machine-wide one.
When the whole machine is stalled, the machine-level finding lists the units
stalled hardest, from their own PSI, as the victims' side of the same number.

**The kernel, explained.** Kernel threads never rank as culprits (kswapd being
busy is a symptom of memory pressure, not its cause), but they are no longer a
bare name either: each active one carries what it is and what it is a symptom
of, on its row and in its detail. Four kernel-side causes become findings of
their own: a RAID resync / check / recovery / reshape from `/proc/mdstat` (with
percent, speed and ETA; `info` unless disk pressure is up, and *degraded, no
rebuild* is critical), a core pinned by `ksoftirqd` (with the busiest interrupt
on that core named from `/proc/interrupts`), dm-crypt's CPU cost (ranking the
processes doing the IO that is being encrypted), and the SCSI error handler
resetting a device that stopped answering.

**What changed.** Each finding records when it began and carries the change
log's entries from the ten minutes before, as *coincides with*. The change log
is the agent's own record (a ring of the last six hours), built by diffing the
sections the tiers already produce; the host stores what it receives, so an
incident's "what changed just before it began" survives an agent restart.
Nothing is inferred from proximity: a timer that fired 30 s before an IO stall
is listed, not accused.

**Ceilings.** Nothing is slow yet; the next call fails. Each ceiling is
reported from half-way with its holder (a process for its own descriptor
limit or the inotify watches it holds; the machine for file handles, threads,
PIDs and connection tracking; a unit for its task limit), and fires as a
finding at 80%, critical at 95%, ranking exactly one culprit: the holder.
Counts that depend on reading other users' descriptors are marked as lower
bounds and the unlock is named. The OOM victims list is `/proc/<pid>/oom_score`
read for every process: information on the Doctor page, attached to the
memory findings when those fire.

**Disk-fill forecast.** Each mount's used bytes are fitted by least squares
over the last hour (after ten minutes of samples, and never across an agent
restart, which it says); growth within 24 h becomes a finding (warn within
6 h, critical within 1 h), with its fit quality stated so an uneven burst
reads as "rough", ranking the processes that have files open under that mount
by write rate. Deleted-but-open files are listed with their size and holder;
the finding says a restart or a truncate through `/proc/<pid>/fd` frees them.

**Turned-away clients.** A service can be up, attributed and apparently idle
while the kernel refuses connections on its behalf: once its accept queue (the
completed handshakes it has not yet `accept()`ed) reaches the listen backlog,
the next client is dropped before the service sees it, and `ListenOverflows` in
`/proc/net/netstat` ticks. Each TCP port row carries its queue against its
backlog (`ss -ltn`, the one unprivileged place the maximum is exposed; without
`ss` the depth alone comes from `/proc/net/tcp` and the maximum is shown as
unknown), the Ports view carries the overflow rate over the sampling interval,
and a port whose queue is full while the counter ticks is a finding that ranks
exactly the process holding the socket, with its unit named. Overflows with no
full queue at sampling time become one unnamed finding that says the burst had
drained, with no culprit -- only a full queue can overflow, so guessing the
port would be invention. The counters are per network namespace: a container
with its own stack keeps its own.

**Verdict memory.** The verdicts stored with every action are the record: the
process dialog shows, per action, how many tries and how each was judged on
this node, before the same button is offered again. **Suggested expectations**
come from stored incidents: the same finding key led by the same process on
three or more distinct days within a 90-minute band of the clock, not already
covered by an expectation, is offered on the finding card and in Settings with
the window pre-filled (a weekday pattern only when each weekday was seen
twice). Confirming it creates an ordinary expectation; nothing is inferred
into the live diagnosis.

**Expected findings.** A person can mark a finding as expected, for one node or
all, optionally only when a named process leads it, optionally only in a daily
window on chosen weekdays. It stays visible with its evidence, reads as
*expected* (severity info, reason attached), is never notified or written to
history as an incident, and comes back as a real finding, with a note on how far
it overran, once its window has ended.

---

## Security & privacy

Self-hosted and private by design: your data lives in one SQLite file on your own
machine, agents are **outbound-only and open no ports**, and there's no cloud, no
account and no telemetry.

- **Dashboard:** username/password (scrypt-hashed), HMAC-signed session cookies
  (HttpOnly, SameSite=Lax), per-source login rate limiting. Every API route and
  the live stream sit behind the session gate; only login, health and agent
  ingest are open.
- **Agents:** per-node bearer tokens, SHA-256-hashed at rest, constant-time
  verified, individually revocable. Reports are size-capped and strictly
  sanitised before they touch host state.
- **At rest:** the database is `chmod 600` and stores only hashes. A stolen copy
  yields scrypt and token hashes, never passwords or tokens.
- **In transit:** plain HTTP exposes cookies and tokens, so on anything but a
  trusted LAN run TLS (`--ssl-certfile/--ssl-keyfile`, or a reverse proxy) and
  point agents at `https://`.
- **Notifications** carry findings only, over channels you configure: an ntfy
  topic URL, a JSON webhook, or SMTP. The SMTP password lives in `config.json`
  and is never returned by the API. Delivery is rate-limited (20 per 10 min).
- **Reverse proxies are refused until declared.** A forwarding header from an
  undeclared address gets a `400`, not silent trust, so a visitor can never spoof
  the address the login limiter keys on. An optional Host allow-list shuts DNS
  rebinding.

A suite of security tools ships with the host (`tools/audit_security.py`,
`check_security.py`, `check_auth.py`, `check_ingest.py`); run them before you
expose a host, and through any TLS proxy you add. A CRIT/HIGH finding fails their
exit status, so they can gate a deploy.

---

## Privilege, named

There is no "run as administrator." Every gated source names exactly what would
unlock it, and `./culprit.sh` prints the whole matrix up front:

| Wanted | Needs |
|---|---|
| System journal (events, sessions) | `systemd-journal` or `adm` group |
| Other users' `/proc/<pid>/io`, FD counts, open files | `CAP_SYS_PTRACE` (also gated by `yama/ptrace_scope`) |
| SMART / NVMe health | `CAP_SYS_RAWIO` or root, plus smartmontools |
| DMI serials, `/var/log/btmp`, pstore | root |
| i915 GPU counters | `CAP_PERFMON` or relaxed `perf_event_paranoid` |

Run it with whatever privilege you're comfortable giving it; it degrades
honestly and tells you what each level would add.

---

## Performance

Measured on a modest 4-core KVM guest (Xeon Gold 6150, 4 GB RAM, rotational
disk), ~230 processes, 209 systemd units, a 1.3 GB journal:

| Tier | Interval | Steady-state cost |
|---|---|---|
| fast · cpu, mem, PSI, gpu, disk, net | 1 s | ~2-4 ms |
| proc · full table, per-unit cgroups, kernel state + lag scoring | 2 s | ~35-55 ms |
| slow · units + cgroups, mounts, sockets, probes, sync | 20 s | ~0.5-1.2 s |
| events · journal, crash files, pending reboot | 120 s | ~0.6-1 s warm |

**Total: well under 5% of one core, ~65 MB resident.** A watched machine's agent
depends only on psutil and the standard library, opens no ports, and sends a few
KB/s (delta-compressed: unchanged sections aren't resent).

Those numbers are measured, not promised: `tools/perf.py` runs the real sampler
for five minutes and prints each tier's cold, median and p90 tick cost next to
this table (`--compress` shrinks the slow and events cadences for a one-minute
check), so you can see whether the claims hold on your machine.

The engineering leans on measurement, not habit: a direct `/proc` scan beats
psutil for the process table (**8 ms vs 45 ms**) and carries signals its iterator
doesn't (run delay, `majflt`, `wchan`); `systemctl -o json` is measured against a
D-Bus binding and wins on total cost; and two `journalctl` performance cliffs are
documented and designed around.

---

## Notes & limits

Culprit tells you what it *can't* do as plainly as what it can:

- **Window responsiveness isn't measurable** on a headless box or Wayland, so
  Culprit relies on kernel-level signals (D-state + `wchan`, run delay, hung-task
  reports, PSI `full`) instead of faking a "not responding" light.
- **Per-process GPU coverage varies by driver:** the panel says which backends
  it tried and why each declined.
- **Containers make `/proc` lie**; Culprit detects containerisation and warns
  that `/proc`-derived numbers may be the host's unless lxcfs is mounted.
- **Journal persistence matters:** with a volatile-only journal, event history
  dies at reboot, and the Events view says which kind this machine has.
- **Commit charge is shown always but alerted on only under strict overcommit:**
  under the default policy, `Committed_AS` over `CommitLimit` is normal, and
  alarming on it would be confident nonsense.

---

<div align="center">

**Culprit.** The machine tells you who's to blame.

Built for people who run their own Linux boxes and want an answer, not a graph.

</div>
