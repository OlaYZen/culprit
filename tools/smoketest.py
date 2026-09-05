"""Exercise every collector once and report shape, cost and degradation.

Run after any change to the collectors:

    .venv/bin/python tools/smoketest.py

It is deliberately not a unit-test suite. The things that break in this codebase
are environmental -- a sysfs path a distro moved, a journal that needs a group,
a cgroup v1 host, a kernel without PSI -- and those only show up against the
real machine. This prints what each collector actually produced so those
failures are visible rather than silently becoming nulls on a dashboard.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from culprit import config as config_module  # noqa: E402
from culprit import linux  # noqa: E402
from culprit.collectors import ceilings, cgroups, disks, events, gpu, kernel, network  # noqa: E402
from culprit.collectors import ports, processes, services, sync, sysinfo  # noqa: E402
from culprit.collectors.changes import ChangeLog  # noqa: E402
from culprit.collectors.cpu_mem import CpuMemoryCollector  # noqa: E402
from culprit.collectors.lag import LagAnalyzer  # noqa: E402

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m"
failures: list[str] = []


def timed(label: str, fn, budget_ms: float = 250):  # type: ignore[no-untyped-def]
    started = time.perf_counter()
    try:
        result = fn()
    except Exception as exc:
        elapsed = (time.perf_counter() - started) * 1000
        print(f"{RED}FAIL{RESET} {label:<38} {elapsed:8.1f}ms  "
              f"{type(exc).__name__}: {exc}")
        failures.append(f"{label}: {exc}")
        import traceback
        traceback.print_exc()
        return None
    elapsed = (time.perf_counter() - started) * 1000
    colour = GREEN if elapsed < budget_ms else YELLOW
    print(f"{colour}ok{RESET}   {label:<38} {elapsed:8.1f}ms")
    return result


def note(text: str) -> None:
    print(f"       {DIM}{text}{RESET}")


def matrix() -> None:
    """Per-source availability, so a bug report can start from this output."""
    print("\n--- availability matrix " + "-" * 48)

    def row(label: str, ok: bool | None, why: str = "") -> None:
        mark = (f"{GREEN}yes{RESET}" if ok else
                f"{YELLOW}no{RESET} " if ok is False else f"{DIM}?{RESET}  ")
        print(f"  {label:<40} {mark}  {DIM}{why}{RESET}")

    journal = linux.journal_access()
    caps = linux.capabilities()
    row("PSI (/proc/pressure)", linux.psi_available(),
        "" if linux.psi_available() else "derived pressure model in use")
    row("cgroup v2 per-unit attribution", linux.cgroup_version() == 2,
        f"cgroup v{linux.cgroup_version()}")
    row("journal readable", bool(journal["readable"]),
        journal["reason"] or "")
    row("journal persistent", bool(journal["persistent"]),
        "" if journal["persistent"] else "volatile: history dies at reboot")
    row("delay accounting (blkio waits)",
        linux.read_int("/proc/sys/kernel/task_delayacct") == 1,
        "echo 1 > /proc/sys/kernel/task_delayacct to enable")
    row("schedstat (run delay)",
        linux.read_text("/proc/self/schedstat") is not None)
    row("smaps_rollup (PSS)",
        linux.read_text("/proc/self/smaps_rollup") is not None,
        "own processes only without CAP_SYS_PTRACE")
    row("other users' /proc/<pid>/io", os.geteuid() == 0
        or "CAP_SYS_PTRACE" in caps,
        f"ptrace_scope={linux.ptrace_scope()}")
    row("SMART", os.geteuid() == 0 or "CAP_SYS_RAWIO" in caps,
        "needs CAP_SYS_RAWIO/root plus smartmontools")
    container = linux.in_container()
    row("not containerised", container is None,
        f"inside {container}: /proc may show the host" if container else "")
    drm = os.path.isdir("/dev/dri")
    row("DRM devices present", drm, "" if drm else "no GPU nodes")


def main() -> int:
    cfg = config_module.load()
    print(f"\nculprit smoke test   euid={os.geteuid()}   "
          f"python={sys.version.split()[0]}\n" + "-" * 72)

    info = timed("sysinfo.collect", sysinfo.collect)
    if info:
        os_info = info["os"]
        note(f"{os_info.get('product')} kernel {os_info.get('build_full')}")
        note(f"{info['cpu']['name']} - {info['cpu']['logical_cores']} logical / "
             f"{info['cpu']['physical_cores']} physical cores")
        for adapter in info["gpus"]:
            note(f"GPU: {adapter['name']}")
        note(f"virt={info['virtualization']} container={info['container']} "
             f"uptime {info['uptime_seconds'] / 3600:.1f}h")

    matrix()

    print("\n--- init " + "-" * 63)
    cpu_mem = timed("CpuMemoryCollector.__init__", CpuMemoryCollector)
    if cpu_mem is None:
        return 1
    for key, reason in cpu_mem.degraded.items():
        note(f"{YELLOW}degraded{RESET} {key}: {reason}")

    gpu_collector = timed("GpuCollector.__init__ (probes backends)",
                          lambda: gpu.GpuCollector(info["gpus"] if info else []))
    disk_collector = timed("DiskCollector.__init__", disks.DiskCollector)
    net_collector = timed("NetworkRateCollector.__init__", network.NetworkRateCollector)
    proc_collector = timed("ProcessCollector.__init__ (primes rates)",
                           processes.ProcessCollector)

    # Rate counters need a gap before they mean anything.
    time.sleep(1.2)

    print("\n--- fast tier (budget: a few ms) " + "-" * 39)
    sample = timed("cpu_mem.sample", cpu_mem.sample, budget_ms=20)
    gpu_sample = timed("gpu.sample", gpu_collector.sample, budget_ms=50) \
        if gpu_collector else None
    disk_sample = timed("disk.sample", disk_collector.sample, budget_ms=20) \
        if disk_collector else None
    net_sample = timed("net.sample", net_collector.sample, budget_ms=20) \
        if net_collector else None

    if sample:
        cpu = sample["cpu"]
        memory = sample["memory"]
        note(f"CPU {cpu['total']}%  iowait={cpu['iowait']}%  steal={cpu['steal']}%  "
             f"runnable={cpu['queue_length']}  blocked={cpu['blocked']}  "
             f"load={cpu['load_1']}")
        note(f"per-core: {cpu['per_core']}")
        note(f"RAM {memory['percent']}%  avail={memory['available_mb']}MB  "
             f"major faults={memory['hard_faults_sec']}/s  "
             f"commit={memory['commit_percent']}% "
             f"(enforced={memory['commit_enforced']})")
        psi = sample.get("psi")
        if psi:
            note("PSI avg10: " + "  ".join(
                f"{res} some={((psi.get(res) or {}).get('some') or {}).get('avg10')}"
                f" full={((psi.get(res) or {}).get('full') or {}).get('avg10')}"
                for res in ("cpu", "memory", "io")))
        else:
            note(f"{YELLOW}PSI unavailable{RESET}")
    if gpu_sample:
        if gpu_sample["available"]:
            note(f"GPU backend={gpu_sample.get('backend')} total={gpu_sample['total']}%  "
                 f"per-process entries: {len(gpu_collector.per_pid)}")
        else:
            note(f"{YELLOW}GPU unavailable{RESET}: {gpu_sample['reason']}")
    if disk_sample:
        total = disk_sample["total"]
        note(f"disk busy={total['busy_percent']}%  queue={total['queue_length']}  "
             f"await={total['latency_ms']}ms  "
             f"r={_mb(total['read_bytes_sec'])}/s w={_mb(total['write_bytes_sec'])}/s")
        note(f"devices: {[(d['instance'], 'layered' if d['layered'] else ('HDD' if d['rotational'] else 'SSD')) for d in disk_sample['disks']]}")
    if net_sample and net_sample["available"]:
        note(f"net interfaces: {len(net_sample['interfaces'])}  "
             f"down={_mb(net_sample['total']['recv_bytes_sec'])}/s "
             f"up={_mb(net_sample['total']['sent_bytes_sec'])}/s")

    print("\n--- process tier " + "-" * 55)
    result = timed("processes.sample",
                   lambda: proc_collector.sample(
                       gpu_per_pid=gpu_collector.per_pid if gpu_collector else {},
                       limit=cfg.process_count), budget_ms=100)
    if result:
        totals = result["totals"]
        note(f"{totals['count']} processes ({totals['kernel_threads']} kernel "
             f"threads), {totals['threads']} threads, "
             f"{totals['d_state']} in D-state, {totals['zombies']} zombies")
        note(f"states: {result['by_state']}")
        if result["io_note"]:
            note(f"{YELLOW}{result['io_note']}{RESET}")
        if totals.get("containers"):
            named = sum(1 for r in result["processes"]
                        if r.get("container") and r["container"].get("name"))
            note(f"containers: {totals['containers']} with "
                 f"{totals['container_processes']} processes; {named} processes "
                 "carry a container name")
        if result.get("container_note"):
            note(f"{YELLOW}{result['container_note']}{RESET}")
        # psutil.pids() is the ground truth for "did we see every process".
        actual = len(psutil.pids())
        seen = totals["count"]
        marker = GREEN if abs(actual - seen) <= 5 else RED
        note(f"{marker}coverage: {seen} rows vs psutil.pids()={actual}{RESET}")
        if abs(actual - seen) > 5:
            failures.append(f"process coverage: {seen} rows vs {actual} pids")

        snapshot = dict(sample or {})
        snapshot["gpu"] = gpu_sample
        snapshot["disk"] = disk_sample
        snapshot["network"] = net_sample
        analyzer = LagAnalyzer()
        pressures = timed("lag.pressures", lambda: analyzer.pressures(snapshot, cfg))
        timed("lag.score_processes",
              lambda: analyzer.score_processes(result["processes"], snapshot,
                                               pressures or {}, cfg))
        if pressures:
            note(f"pressures ({pressures['mode']}): cpu={pressures['cpu']} "
                 f"mem={pressures['memory']} disk={pressures['disk']} "
                 f"gpu={pressures['gpu']}")
        ranked = sorted(result["processes"],
                        key=lambda p: -float(p.get("lag_score") or 0))[:8]
        print(f"\n       {'PID':>7}  {'NAME':<26} {'SCORE':>6} {'CPU%':>6} "
              f"{'RAM':>9} {'IO/s':>9} {'DELAY':>7}")
        for entry in ranked:
            delay = entry.get("run_delay_ms")
            print(f"       {entry['pid']:>7}  {str(entry['name'])[:26]:<26} "
                  f"{entry.get('lag_score', 0):>6.1f} {entry.get('cpu', 0):>6.1f} "
                  f"{_mb(entry.get('working_set')):>9} "
                  f"{_mb(entry.get('io_bytes_sec')):>9} "
                  f"{'-' if delay is None else f'{delay:.0f}ms/s':>7}")
        if ranked and ranked[0].get("lag_reasons"):
            note(f"top reasons: {ranked[0]['lag_reasons']}")

        # Sustained findings need `sustain_ticks` consecutive hits; feed the same
        # sample repeatedly so any active pressure actually reports here.
        for _ in range(cfg.sustain_ticks):
            diagnosis = analyzer.diagnose(snapshot, result["processes"],
                                          pressures or {}, cfg)
        note(f"verdict: {diagnosis['status']} / {diagnosis['severity']}")
        note(f"headline: {diagnosis['headline']}")
        for finding in diagnosis["findings"][:5]:
            note(f"  [{finding['severity']}] {finding['title']}")

        detail = timed("processes.detail (own pid)",
                       lambda: proc_collector.detail(os.getpid()))
        if detail:
            note(f"detail: pss={_mb(detail['memory'].get('pss'))} "
                 f"fds={detail.get('num_handles')} "
                 f"cgroup={detail.get('cgroup')} "
                 f"run_delay={detail.get('run_delay_total_ms')}ms total")

    print("\n--- slow tier " + "-" * 58)
    volumes = timed("VolumeCollector.sample",
                    lambda: disks.VolumeCollector().sample(
                        processes=result["processes"] if result else None),
                    budget_ms=500)
    if volumes:
        for volume in volumes["volumes"]:
            fc = volume.get("forecast") or {}
            note(f"{volume['mountpoint']:<12} {volume['fstype']:<6} "
                 f"{volume['percent']:>5.1f}% used  free={_mb(volume['free'])} "
                 f"(+{_mb(volume['reserved'])} root-reserved)  growth="
                 f"{fc.get('trend') or fc.get('reason')}  writers="
                 f"{[(w['name'], round(w['write_bytes_sec'])) for w in volume.get('writers', [])][:3]}"
                 f"  held_deleted={len(volume.get('held_deleted', []))}")
        if volumes.get("writers_note"):
            note(f"{YELLOW}{volumes['writers_note']}{RESET}")
        for skip in volumes["skipped"]:
            note(f"{YELLOW}skipped{RESET} {skip['device']}: {skip['reason']}")
        for medium in volumes["media"]:
            note(f"{medium['name']}: {medium['model']} ({medium['interface']}, "
                 f"{medium['media_type']})  smart="
                 f"{medium['smart_reason'] or medium['status'] or 'unknown'}")

    # Per-unit pressure/limits and the kernel's own state (proc tier).
    cg_collector = cgroups.CgroupCollector()
    timed("CgroupCollector.sample (first)", cg_collector.sample, budget_ms=120)
    cg = timed("CgroupCollector.sample (warm)", cg_collector.sample, budget_ms=60)
    if cg:
        if cg["available"]:
            note(f"{cg['total_units']} unit cgroups, {cg['emitted']} notable "
                 f"(stalled, capped or limited)")
            for unit in cg["units"][:4]:
                psi = unit["psi"]
                note(f"  {unit['unit'][:40]}: stall cpu={psi.get('cpu_some')} "
                     f"mem={psi.get('memory_full')} io={psi.get('io_full')} "
                     f"quota={unit['cpu_quota_pct']} throttled={unit['throttled_pct']} "
                     f"mem_limit={unit['memory_limit_pct']} runtime_cap={unit['runtime_cap']}")
        else:
            note(f"{YELLOW}unavailable{RESET}: {cg['reason']}")
    kn_collector = kernel.KernelCollector()
    timed("KernelCollector.sample (first)", kn_collector.sample, budget_ms=20)
    kn = timed("KernelCollector.sample (warm)", kn_collector.sample, budget_ms=10)
    if kn:
        md = kn["mdstat"]
        note(f"mdstat: {'%d array(s)' % len(md['arrays']) if md['available'] else md['reason']}"
             + (f", syncing: {[a['name'] for a in md['syncing']]}" if md.get("syncing") else ""))
        irq = kn["irq"]
        if irq.get("available") and irq.get("cores"):
            note("busiest interrupt per core: "
                 + ", ".join(f"cpu{c['core']}={c['top'][0]['name'] if c['top'] else '-'}"
                             for c in irq["cores"]))
    explained = [(p["name"], p["kernel"]["role"]) for p in
                 (result["processes"] if result else []) if p.get("kernel")]
    note(f"kernel threads explained (active now): {explained[:4] or 'none active'}")

    ceil = timed("CeilingCollector.sample",
                 lambda: ceilings.CeilingCollector().sample(
                     processes=result["processes"] if result else None), budget_ms=80)
    if ceil:
        note(f"{ceil['watched']} ceilings watched, {len(ceil['limits'])} past half-way; "
             f"{ceil['fds_unreadable']} processes' fds not readable; conntrack="
             f"{ceil['conntrack'].get('current')}/{ceil['conntrack'].get('max')}")
        note("OOM killer would take first: "
             + ", ".join(f"{v['name']} (score {v['oom_score']})" for v in ceil["oom"]["next"][:3]))

    svc_collector = services.ServiceCollector()
    svc = timed("ServiceCollector.sample (first)", svc_collector.sample,
                budget_ms=2500)
    svc = timed("ServiceCollector.sample (warm)", svc_collector.sample,
                budget_ms=1200) or svc
    if svc and svc["available"]:
        summary = svc["summary"]
        note(f"{summary['total']} units ({summary.get('user_units', 0)} user), "
             f"{summary.get('status_running', 0)} running, "
             f"{summary.get('status_failed', 0)} failed, "
             f"{len(svc['timers'])} timers, "
             f"cgroup_attribution={svc['cgroup_attribution']}")
        for problem in svc["problems"][:5]:
            note(f"  [{problem['severity']}] {problem['name']}: "
                 f"{problem['detail'][:70]}")

    # The change log: baseline on the first observation, so a second pass
    # over unchanged sections must produce nothing.
    change_log = ChangeLog()
    change_log.observe_services(svc)
    change_log.observe_cgroups(cg)
    change_log.observe_processes(result["processes"] if result else [])
    change_log.observe_services(svc)
    change_log.observe_cgroups(cg)
    changes = change_log.snapshot()
    marker = GREEN if changes["count"] == 0 else RED
    note(f"{marker}change log after an unchanged second pass: {changes['count']} "
         f"event(s) (expected 0){RESET}")
    if changes["count"]:
        failures.append("change log reported changes for identical observations")

    net_detail = timed("NetworkDetailCollector.sample",
                       network.NetworkDetailCollector().sample, budget_ms=2000)
    if net_detail:
        sockets = net_detail["sockets"]
        note(f"sockets total={sockets.get('total')} "
             f"unattributed={sockets.get('unattributed')}")
        note(f"adapters={[(a['description'], a['kind']) for a in net_detail['adapters'] if a['gateways']]}")
        note(f"connectivity={json.dumps(net_detail['connectivity'], default=str)[:180]}")

    # The port map reuses the unit pid->unit map, so feed it what the service
    # collector just produced -- exactly as the sampler's slow tick does.
    ports_collector = ports.PortsCollector()
    port_map = timed("PortsCollector.sample",
                     lambda: ports_collector.sample(
                         service_map=(svc or {}).get("by_pid")), budget_ms=200)
    if port_map and port_map["available"]:
        t = port_map["totals"]
        note(f"listening ports: {t['ports']} ({t['public']} exposed, "
             f"{t['tcp']} tcp / {t['udp']} udp), "
             f"{t['connections']} inbound conns, {t['unattributed']} unattributed")
        for entry in port_map["ports"][:10]:
            procs = entry["processes"]
            who = (procs[0]["name"] if procs
                   else ("(other user)" if entry["unattributed"] else "-"))
            queue = entry.get("accept_queue")
            depth = (f"{queue['current']}/{queue['max'] if queue['max'] is not None else '?'}"
                     if queue else "-")
            note(f"  :{entry['port']:<5} {'/'.join(entry['protocols']):<7} "
                 f"{entry['scope']:<7} {who:<20} kill={entry['killable']} "
                 f"backlog={depth}{' DROPPING' if entry.get('turned_away') else ''}")
        # Turned-away clients: the rates need two readings, so sample again
        # after a beat and report the counters that then have a rate.
        time.sleep(1.0)
        backlog = (ports_collector.sample(service_map=(svc or {}).get("by_pid"))
                   or {}).get("backlog") or {}
        if backlog.get("available"):
            note("turned away: "
                 + ", ".join(f"{k}={backlog.get(f'{k}_sec')}/s"
                             for k in ("overflows", "drops", "syn_drops", "syn_cookies"))
                 + f" over {backlog.get('interval')}s; somaxconn={backlog.get('somaxconn')}; "
                 + ("backlog maxima from ss" if backlog.get("queues_available")
                    else f"{YELLOW}no backlog maxima{RESET}: {backlog.get('queues_reason')}")
                 + (f"; full while overflowing: {backlog['turned_away']}" if backlog.get("turned_away") else ""))
        else:
            note(f"{YELLOW}turned-away counters unavailable{RESET}: {backlog.get('reason')}")
    elif port_map:
        note(f"{YELLOW}port map unavailable{RESET}: {port_map.get('reason')}")

    sync_sample = timed("SyncCollector.sample", sync.SyncCollector().sample,
                        budget_ms=1000)
    if sync_sample:
        note(f"available={sync_sample['available']}  "
             f"reason={sync_sample.get('reason')}")
        for client in sync_sample.get("clients", []):
            note(f"  {client['name']}: {client['status']} - {client.get('detail')}")
        inotify = sync_sample["inotify"]
        note(f"inotify: {inotify['used_watches']}/{inotify['max_watches']} "
             f"watches ({inotify['unreadable_processes']} procs unreadable)")

    print("\n--- events tier (first read pays the cold journal cache) " + "-" * 14)
    event_collector = events.EventCollector()
    payload = timed("EventCollector.sample (first)",
                    lambda: event_collector.sample(
                        lookback_days=cfg.event_lookback_days,
                        max_per_source=cfg.event_max_per_source),
                    budget_ms=20000)
    payload = timed("EventCollector.sample (warm)",
                    lambda: event_collector.sample(
                        lookback_days=cfg.event_lookback_days,
                        max_per_source=cfg.event_max_per_source),
                    budget_ms=3000) or payload
    if payload:
        note(f"journal: readable={payload['journal']['readable']} "
             f"persistent={payload['journal']['persistent']}")
        crashes = payload["crashes"]
        note(f"crash/error events: {crashes['summary']['total']} "
             f"by source={crashes['summary']['by_source']}")
        for event in crashes["events"][:5]:
            when = time.strftime("%Y-%m-%d %H:%M",
                                 time.localtime(event["timestamp"] or 0))
            note(f"  {when}  [{event['severity']:<8}] {str(event.get('title'))[:66]}")
        note(f"crash files: {crashes['crash_files']['count']} "
             f"({crashes['crash_files'].get('reason') or 'present'})")
        note(f"updates: {payload['updates']['summary']}")
        note(f"policy: {payload['policy']['summary']}")
        sessions = payload["sessions"]
        note(f"sessions: {sessions['summary']['sessions']} in timeline, "
             f"{sessions['summary']['open_sessions']} open, "
             f"exact={sessions['exact']}")
        note(f"pending reboot: {payload['pending_reboot']['pending']} "
             f"{payload['pending_reboot']['reasons']}")

    print("\n--- outage doctor (broken, not slow) " + "-" * 34)
    from culprit.collectors import outage as outage_mod
    outage_collector = outage_mod.OutageCollector()
    out = timed("OutageCollector.sample (first: unit walks, TLS, clock)",
                lambda: outage_collector.sample(svc, port_map, volumes, payload, net_detail,
                                                info, changes=change_log), budget_ms=3000)
    out = timed("OutageCollector.sample (warm)",
                lambda: outage_collector.sample(svc, port_map, volumes, payload, net_detail,
                                                info, changes=change_log), budget_ms=80) or out
    if out:
        note(f"status={out['status']} items={[(i['key'], i['severity']) for i in out['items'][:6]]}")
        checks = out["checks"]
        note("checks: " + "  ".join(
            f"{name}={'ok' if c.get('available', True) else 'n/a'}" for name, c in checks.items()))
        tls = checks.get("tls") or {}
        note(f"tls: {tls.get('checked', 0)} listener(s) handshaken; "
             + (tls.get("note") or ", ".join(f":{c['port']} {'cert' if c.get('tls') else c.get('reason')}"
                                              for c in tls.get("certificates") or [])[:200]))
        clock = checks.get("time") or {}
        note(f"clock: synchronized={clock.get('synchronized')} daemon={clock.get('daemon')} "
             f"offset={clock.get('offset_ms')} ms")

    print("\n--- coroner (flight recorder + previous-boot forensics) " + "-" * 14)
    import tempfile
    from culprit.collectors import forensics, recorder
    with tempfile.TemporaryDirectory() as tmp:
        flight = recorder.FlightRecorder(Path(tmp) / "flight.json.gz")
        if sample:
            fast = dict(sample)
            fast["ts"] = time.time()
            fast["pressures"] = {"cpu": 0.1, "memory": 0.1, "disk": 0.1}
            fast["disk"] = disk_sample or {}
            fast["network"] = net_sample or {}
            fast["gpu"] = gpu_sample or {}
            # Ten minutes of frames, so the flush cost is the real one.
            for i in range(600):
                frame = dict(fast)
                frame["ts"] = fast["ts"] - 600 + i
                flight.observe_fast(frame)
        if result:
            for i in range(300):
                flight.observe_proc(result["processes"], {"severity": "ok", "findings": []})
        timed("FlightRecorder.observe_fast", lambda: flight.observe_fast(fast if sample else {}),
              budget_ms=1)
        timed("FlightRecorder.flush (10 min of frames)", flight.flush, budget_ms=80)
        size = (Path(tmp) / "flight.json.gz").stat().st_size
        note(f"recording: {len(flight._fast)} fast + {len(flight._proc)} proc frames, "
             f"{size / 1024:.0f} KB gzipped, rewritten every {recorder.FLUSH_SECONDS:.0f} s")
        death = timed("recorder.detect_death", lambda: recorder.detect_death(
            Path(tmp) / "flight.json.gz", "another-boot"), budget_ms=100)
        if death:
            note(f"would report: kind={death['kind']} gap={death['gap_seconds']}s "
                 f"rows={len(death['recorder']['fast']['rows'])}")
    boots = forensics._boots()
    if len(boots) >= 2:
        prev = boots[-2]
        last = int(prev.get("last_entry") or 0) / 1e6
        evidence = timed("forensics.investigate (previous boot)", lambda: forensics.investigate(
            {"kind": "machine", "died_at": last, "prev_boot_id": prev.get("boot_id"),
             "boot_id": recorder.boot_id(), "agent_pid": 0}), budget_ms=3000)
        if evidence:
            note(f"journal readable={evidence['journal']['readable']} "
                 f"markers={[m['kind'] for m in evidence['markers'][:6]]} "
                 f"tail={len(evidence['tail'])} entries pstore={evidence['pstore']['reason'] or 'readable'}")
            for line in evidence["notes"]:
                note(f"{YELLOW}{line}{RESET}")
    else:
        note(f"{YELLOW}only one boot in the journal: previous-boot forensics not exercised{RESET}")
    evidence = timed("forensics.investigate (agent, this boot)", lambda: forensics.investigate(
        {"kind": "agent", "died_at": time.time() - 60, "prev_boot_id": recorder.boot_id(),
         "boot_id": recorder.boot_id(), "agent_pid": os.getpid()}), budget_ms=2000)
    if evidence:
        note(f"agent unit={evidence['agent']['unit']} note={evidence['agent']['note']}")

    print("\n" + "-" * 72)
    if failures:
        print(f"{RED}{len(failures)} collector(s) failed:{RESET}")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"{GREEN}All collectors returned data.{RESET}\n")
    return 0


def _mb(value: object) -> str:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return "-"
    if number >= 1024 ** 3:
        return f"{number / 1024 ** 3:.1f}G"
    if number >= 1024 ** 2:
        return f"{number / 1024 ** 2:.0f}M"
    if number >= 1024:
        return f"{number / 1024:.0f}K"
    return f"{number:.0f}"


if __name__ == "__main__":
    sys.exit(main())
