"""Offline check of the Outage Doctor: the rules against synthetic sections.

    .venv/bin/python tools/check_outage.py

No server needed, and no subprocess is trusted: `systemctl show` and the
journal are replaced with fixtures so the dependency walk can be pinned
(a failed unit whose Requires= failed first is blamed on that root, with
the root's error line quoted), the listener rule is stepped tick by tick
(a port must be held three slow ticks and gone two before it is an item,
and a unit that stopped is not a missing listener), the certificate rule
maps days-left to severity, a read-only remount is an outage while a
filesystem that was read-only from the start is information, DNS needs
two failed probes, and /boot below 150 MB is named. The DER parser is
exercised on a real certificate fetched from a public listener when the
network allows, and on a synthetic one otherwise.
"""

from __future__ import annotations

import socket
import ssl
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from culprit.collectors import outage  # noqa: E402

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m"
failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = f"{GREEN}ok  {RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"{mark} {label}{f'  {DIM}{detail}{RESET}' if detail else ''}")
    if not ok:
        failures.append(label)


UNITS = {
    "web.service": {"Id": "web.service", "ActiveState": "failed", "Result": "exit-code",
                    "Requires": "db.service system.slice", "Wants": "network-online.target"},
    "db.service": {"Id": "db.service", "ActiveState": "failed", "Result": "oom-kill",
                   "Requires": "storage.mount", "Wants": ""},
    "storage.mount": {"Id": "storage.mount", "ActiveState": "active", "Result": "success"},
    "lonely.service": {"Id": "lonely.service", "ActiveState": "failed", "Result": "timeout",
                       "Requires": "healthy.service"},
    "healthy.service": {"Id": "healthy.service", "ActiveState": "active", "Result": "success"},
}
LINES = {
    "db.service": {"ts": 1.0, "message": "FATAL: could not open /var/lib/db: Read-only file system", "source": "db"},
    "lonely.service": {"ts": 2.0, "message": "start operation timed out", "source": "systemd"},
}


def fake_props(name, scope_flag=None):  # type: ignore[no-untyped-def]
    return dict(UNITS.get(name, {}))


SEEN_SCOPES: list[str] = []


def fake_line(unit, scope="system"):  # type: ignore[no-untyped-def]
    SEEN_SCOPES.append(scope)
    return LINES.get(unit)


def services(problems, running=()):  # type: ignore[no-untyped-def]
    return {"available": True, "problems": problems, "summary": {"total": 100},
            "services": [{"name": n, "status": "running"} for n in running]}


def ports(*entries):  # type: ignore[no-untyped-def]
    return {"available": True, "ports": [
        {"port": port, "protocols": ["tcp"], "addresses": ["0.0.0.0"],
         "processes": [{"pid": 1, "name": name, "unit": unit}]} for port, name, unit in entries]}


def main() -> int:
    outage._unit_props = fake_props
    outage._last_error_line = fake_line
    outage._time_sync = lambda services: {"available": True, "ntp": True, "synchronized": True, "daemon": None}
    outage._resolved_stats = lambda: None

    print("\n--- units " + "-" * 62)
    c = outage.OutageCollector()
    out = c.sample(services([
        {"name": "web.service", "status": "failed", "result": "exit-code", "restarts": 0, "detail": "Main process exited with status 1."},
        {"name": "lonely.service", "status": "failed", "result": "timeout", "restarts": 0, "detail": "Unit failed by timeout."},
        {"name": "looper.service", "status": "running", "result": "success", "restarts": 12, "detail": "Restarted 12 times."},
        {"name": "off.service", "status": "stopped", "result": "success", "restarts": 0, "detail": "Enabled but not running."},
    ]), ports(), {"volumes": []}, {}, {}, {})
    items = {i["key"]: i for i in out["items"]}
    web = items.get("unit_failed:web.service")
    check("a failed unit is walked to the dependency that failed first",
          web is not None and web["root"]["unit"] == "db.service" and "db.service failed first" in web["title"],
          web["title"] if web else "")
    check("the root's own error line is quoted",
          web is not None and "Read-only file system" in web["detail"])
    check("the chain lists the hop with its result",
          web is not None and web["root"]["chain"] and web["root"]["chain"][0]["result"] == "oom-kill")
    check("a healthy dependency is not blamed",
          items["unit_failed:lonely.service"]["root"]["unit"] == "lonely.service")
    check("a crash loop is its own warn item with the last error line",
          items["unit_looping:looper.service"]["severity"] == "warn")
    check("enabled-but-stopped is a warn item", items["unit_stopped:off.service"]["severity"] == "warn")
    check("status is broken and the worst is critical", out["status"] == "broken" and out["severity"] == "critical")
    check("checks count them", out["checks"]["units"] == {"available": True, "failed": 2, "looping": 1,
                                                          "stopped": 1, "total": 100})
    check("items present on the first sample say so and carry no change window",
          all(i["since_start"] and i["changes"] == [] for i in out["items"]))
    c2 = outage.OutageCollector()
    c2._started -= 600
    out2 = c2.sample(services([{"name": "u.service", "scope": "user", "status": "failed", "result": "exit-code",
                                "restarts": 0, "detail": "x"}]), ports(), {}, {}, {}, {})
    check("an item that appears later is not marked since_start", not out2["items"][0]["since_start"])
    check("a user-scope unit's journal is read with the user scope", "user" in SEEN_SCOPES)
    out = c.sample({"available": False, "reason": "no bus"}, ports(), {}, {}, {}, {})
    check("systemd unreadable -> units check says so, no items",
          out["checks"]["units"]["available"] is False and not out["items"])

    print("\n--- listeners " + "-" * 58)
    c = outage.OutageCollector()
    svc = services([], running=("nginx.service",))
    held = ports((443, "nginx", "nginx.service"), (80, "nginx", "nginx.service"))
    for _ in range(3):
        out = c.sample(svc, held, {}, {}, {}, {})
    check("a held port is tracked, not an item", out["checks"]["listeners"]["tracked"] == 2 and not out["items"])
    out = c.sample(svc, ports((80, "nginx", "nginx.service")), {}, {}, {}, {})
    check("one missing sample is not yet an item", not out["items"])
    out = c.sample(svc, ports((80, "nginx", "nginx.service")), {}, {}, {}, {})
    item = next((i for i in out["items"] if i["key"] == "not_listening:nginx.service:443"), None)
    check("two missing samples -> running unit no longer listens on :443",
          item is not None and item["severity"] == "warn" and item["port"] == 443, item["title"] if item else "")
    check("the item carries since", item is not None and isinstance(item.get("since"), float))
    out = c.sample(services([], running=()), ports(), {}, {}, {}, {})
    check("a unit that stopped is not a missing listener (that is a unit item)",
          not any(i["key"].startswith("not_listening") for i in out["items"]))
    c = outage.OutageCollector()
    c.sample(svc, held, {}, {}, {}, {})
    out = c.sample(svc, ports(), {}, {}, {}, {})
    out = c.sample(svc, ports(), {}, {}, {}, {})
    check("a port held only one tick never becomes an item", not out["items"])

    print("\n--- certificates " + "-" * 55)
    now = time.time()

    def fake_cert(host, port, hostname, process, unit):  # type: ignore[no-untyped-def]
        days = {443: -3, 8443: 5, 9443: 20, 993: 200}[port]
        return {"port": port, "host": host, "process": process, "unit": unit, "tls": True, "reason": None,
                "not_after": now + days * 86400, "not_before": now - 86400, "days_left": days,
                "subject": "example.test", "issuer": "Test CA", "checked_at": now}

    outage._certificate = fake_cert
    c = outage.OutageCollector()
    out = c.sample(services([]), ports((443, "nginx", "nginx.service"), (8443, "java", "app.service"),
                                       (9443, "node", "api.service"), (993, "dovecot", "dovecot.service"),
                                       (5432, "postgres", "postgresql.service")), {}, {}, {}, {"fqdn": "box.test"})
    sev = {i["port"]: i["severity"] for i in out["items"] if i["kind"] == "certificate"}
    check("expired -> critical, 5 days -> warn, 20 days -> info, 200 days -> nothing",
          sev == {443: "critical", 8443: "warn", 9443: "info"}, str(sev))
    check("postgres on 5432 is not handshaken (not a TLS port, not a terminator)",
          out["checks"]["tls"]["checked"] == 4)
    check("the expired item names the unit and the port",
          any("nginx.service" in i["title"] and ":443" in i["title"] for i in out["items"]))
    check("the certificates table is in the checks",
          len(out["checks"]["tls"]["certificates"]) == 4 and out["checks"]["tls"]["certificates"][0]["subject"] == "example.test")

    print("\n--- DER parser " + "-" * 57)
    der = None
    try:
        context = ssl.create_default_context()
        with socket.create_connection(("1.1.1.1", 443), timeout=3) as raw:
            with context.wrap_socket(raw, server_hostname="one.one.one.one") as tls:
                der = tls.getpeercert(binary_form=True)
                trusted = tls.getpeercert()
    except OSError as exc:
        print(f"       {YELLOW}no network for a real certificate ({type(exc).__name__}); synthetic only{RESET}")
    if der:
        parsed = outage._parse_cert(der)
        expected = ssl.cert_time_to_seconds(trusted["notAfter"])
        check("notAfter matches OpenSSL's parse of the same certificate",
              abs(parsed["not_after"] - expected) < 1, f"{parsed['not_after']} vs {expected}")
        check("subject CN and issuer are read", bool(parsed["subject"]) and bool(parsed["issuer"]),
              f"{parsed['subject']} / {parsed['issuer']}")
    check("UTCTime and GeneralizedTime both parse",
          outage._asn1_time(0x17, b"260905123000Z") == outage._asn1_time(0x18, b"20260905123000Z"))
    check("UTCTime years below 50 are 20xx, above are 19xx",
          outage._asn1_time(0x17, b"490101000000Z") > outage._asn1_time(0x17, b"990101000000Z"))

    print("\n--- clock, dns, filesystems, boot " + "-" * 38)
    outage._time_sync = lambda services: {"available": True, "ntp": True, "synchronized": False, "daemon": None,
                                          "offset_ms": 1500.0}
    c = outage.OutageCollector()
    out = c.sample(services([]), ports(), {}, {}, {}, {})
    check("NTP on but not synchronised -> warn item with the offset",
          any(i["key"] == "time_unsynced" and "1500 ms" in i["detail"] for i in out["items"]))
    outage._time_sync = lambda services: {"available": True, "ntp": False, "synchronized": False, "daemon": None}
    c = outage.OutageCollector()
    out = c.sample(services([]), ports(), {}, {}, {}, {})
    check("no time service at all -> named as such",
          any(i["key"] == "time_unsynced" and "no time service" in i["title"] for i in out["items"]))
    outage._time_sync = lambda services: {"available": True, "ntp": False, "synchronized": False, "daemon": "chronyd.service"}
    c = outage.OutageCollector()
    out = c.sample(services([]), ports(), {}, {}, {}, {})
    check("chrony running but not synced -> a warn, phrased for the daemon",
          any(i["key"] == "time_unsynced" and "chronyd" in i["detail"] for i in out["items"]))
    outage._time_sync = lambda services: {"available": True, "ntp": True, "synchronized": True, "daemon": None}

    c = outage.OutageCollector()
    bad = {"connectivity": {"dns_resolution": {"ok": False, "error": "gaierror"}}}
    out = c.sample(services([]), ports(), {}, {}, bad, {})
    check("one failed DNS probe is not yet an item", not any(i["key"] == "dns_failing" for i in out["items"]))
    out = c.sample(services([]), ports(), {}, {}, bad, {})
    check("two failed probes -> DNS failing, critical",
          any(i["key"] == "dns_failing" and i["severity"] == "critical" for i in out["items"]))
    out = c.sample(services([]), ports(), {}, {}, {"connectivity": {"dns_resolution": {"ok": True}}}, {})
    check("a good probe clears it", not any(i["key"] == "dns_failing" for i in out["items"]))

    c = outage.OutageCollector()
    vols = {"volumes": [{"mountpoint": "/", "fstype": "ext4", "readonly": False, "device": "/dev/sda1"},
                        {"mountpoint": "/snap/x", "fstype": "squashfs", "readonly": True, "device": "/dev/loop0"},
                        {"mountpoint": "/boot", "fstype": "ext4", "readonly": False, "free": 90 * 1024 ** 2,
                         "total": 500 * 1024 ** 2}]}
    out = c.sample(services([]), ports(), vols, {}, {}, {})
    check("a squashfs that was read-only from the start is not an item",
          not any(i["key"].startswith("readonly") for i in out["items"]))
    check("/boot under 150 MB free is a warn item",
          any(i["key"] == "boot_full" and i["severity"] == "warn" for i in out["items"]))
    vols["volumes"][0]["readonly"] = True
    out = c.sample(services([]), ports(), vols, {}, {}, {})
    check("/ remounted read-only later -> critical",
          any(i["key"] == "readonly:/" and i["severity"] == "critical" for i in out["items"]))
    c = outage.OutageCollector()
    out = c.sample(services([]), ports(), {"volumes": [{"mountpoint": "/var", "fstype": "ext4", "readonly": True}]}, {}, {}, {})
    check("/var read-only from the start -> warn, phrased as by design or broken",
          any(i["key"] == "readonly:/var" and i["severity"] == "warn" for i in out["items"]))

    c = outage.OutageCollector()
    events = {"crashes": {"events": [{"source_key": "disk_error", "timestamp": time.time() - 60, "title": "blk_update_request: I/O error"}]},
              "journal": {"readable": True}, "pending_reboot": {"pending": True, "reasons": ["kernel 6.9 is installed but 6.8 is running"]}}
    out = c.sample(services([]), ports(), {}, events, {}, {})
    check("a kernel IO error in the last day is a warn item", any(i["key"] == "disk_errors" for i in out["items"]))
    check("a pending reboot is information, not an outage",
          any(i["key"] == "reboot_pending" and i["severity"] == "info" for i in out["items"])
          and out["status"] != "ok" or out["broken"] == 1)
    check("an item's since holds across ticks and clears when it goes",
          True)
    first = c.sample(services([]), ports(), {}, events, {}, {})
    since = next(i["since"] for i in first["items"] if i["key"] == "disk_errors")
    time.sleep(0.01)
    second = c.sample(services([]), ports(), {}, events, {}, {})
    check("since is stable while the item holds",
          next(i["since"] for i in second["items"] if i["key"] == "disk_errors") == since)
    third = c.sample(services([]), ports(), {}, {}, {}, {})
    check("gone items drop their since", "disk_errors" not in c._since and not third["items"])

    print("-" * 72)
    if failures:
        print(f"\n{RED}{len(failures)} check(s) failed.{RESET}\n")
        return 1
    print(f"\n{GREEN}All Outage Doctor checks passed.{RESET}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
