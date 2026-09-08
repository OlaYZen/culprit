"""Offline check of the Prognosis: the rules against fixtures.

    .venv/bin/python tools/check_prognosis.py

No server, no hardware and no subprocess is trusted. `smartctl` is replaced
with saved JSON (a healthy WD Red, the same drive with pending sectors
rising, a Seagate whose packed raw value would otherwise read as twelve
billion reallocated sectors, a drive in standby, a healthy Samsung NVMe, one
whose reliability bit is set, one at 91 % endurance, and a USB bridge
smartctl cannot open), and sysfs is replaced with a temporary tree laid out
as /sys so the ATA links, the EDAC controllers, the PCIe AER counters, the
batteries and the block devices can all be driven.

What it pins, in the order the module states them:

1. parsing -- every judged counter by id, vendor extras kept but never judged
2. the rules of 6.1-6.8: rising beats non-zero beats absent
3. principle 1 -- every command line carries `-n standby` unless the operator
   opted in, and none of them ever carries `-t`
4. principle 4 -- a virtual disk is never judged, and a guest says so
5. the ring -- a restart still sees "rising", it is capped, and a corrupt
   file is ignored rather than fatal
6. the host side -- one wear row per device per day, the forecast's window,
   "unchanged since", and the prune
7. the sentences -- numbers and attribute ids in, hedges out
8. the joins -- a storage finding gains hardware context and keeps its culprits
9. the notifier fold
10. the contract entry
11. the real machine: the collector against this box's own sysfs
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from culprit import linux  # noqa: E402
from culprit import config as config_module  # noqa: E402
from culprit.collectors import lag as lag_mod  # noqa: E402
from culprit.collectors import outage as outage_mod  # noqa: E402
from culprit.collectors import prognosis  # noqa: E402
from culprit import nodes as nodes_mod  # noqa: E402
from culprit import wear as wear_mod  # noqa: E402
from culprit.db import History  # noqa: E402

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m"
failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = f"{GREEN}ok  {RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"{mark} {label}{f'  {DIM}{detail}{RESET}' if detail else ''}")
    if not ok:
        failures.append(label)


def head(title: str) -> None:
    print(f"\n{YELLOW}{title}{RESET}")


# --------------------------------------------------------------- fixtures
ATA_NAMES = {
    1: "Raw_Read_Error_Rate", 5: "Reallocated_Sector_Ct", 7: "Seek_Error_Rate",
    9: "Power_On_Hours", 187: "Reported_Uncorrect", 188: "Command_Timeout",
    194: "Temperature_Celsius", 197: "Current_Pending_Sector",
    198: "Offline_Uncorrectable", 199: "UDMA_CRC_Error_Count",
    231: "SSD_Life_Left",
}


def ata(attrs, passed=True, selftest=("Completed without error", True),
        hours=28104, temp=41, model="WDC WD40EFRX-68N32N0",
        serial="S4EVNF0M123456", extra=()):
    """One `smartctl -j` object for an ATA drive. `attrs` is
    (id, raw value, when_failed) triples; `extra` adds rows with a raw string
    that disagrees with the raw value (the packed-vendor case)."""
    table = [{"id": i, "name": ATA_NAMES.get(i, f"Attr_{i}"), "value": 200,
              "worst": 200, "thresh": 140, "when_failed": wf or "-",
              "raw": {"value": v, "string": str(v)}} for i, v, wf in attrs]
    for i, value, string in extra:
        table.append({"id": i, "name": ATA_NAMES.get(i, f"Attr_{i}"), "value": 100,
                      "worst": 100, "thresh": 0, "when_failed": "-",
                      "raw": {"value": value, "string": string}})
    return {
        "device": {"name": "/dev/sda", "type": "sat", "protocol": "ATA"},
        "model_name": model, "serial_number": serial, "firmware_version": "82.00A82",
        "user_capacity": {"bytes": 4000787030016}, "rotation_rate": 5400,
        "smart_status": {"passed": passed},
        "ata_smart_attributes": {"revision": 16, "table": table},
        "ata_smart_self_test_log": {"standard": {"table": [
            {"type": {"string": "Short offline"},
             "status": {"string": selftest[0], "passed": selftest[1]},
             "lifetime_hours": hours - 20}]}},
        "power_on_time": {"hours": hours},
        "temperature": {"current": temp},
        "smartctl": {"exit_status": 0, "messages": []},
    }


def nvme(used=1, warning=0, spare=100, spare_floor=10, media_errors=0,
         serial="S6PXNX0T234567", written=812345678):
    return {
        "device": {"name": "/dev/nvme0", "type": "nvme", "protocol": "NVMe"},
        "model_name": "Samsung SSD 980 PRO 1TB", "serial_number": serial,
        "firmware_version": "5B2QGXA7", "user_capacity": {"bytes": 1000204886016},
        "smart_status": {"passed": warning == 0, "nvme": {"value": warning}},
        "nvme_smart_health_information_log": {
            "critical_warning": warning, "temperature": 38,
            "available_spare": spare, "available_spare_threshold": spare_floor,
            "percentage_used": used, "data_units_written": written,
            "media_errors": media_errors, "unsafe_shutdowns": 12,
            "power_on_hours": 9100, "num_err_log_entries": 0,
        },
        "smartctl": {"exit_status": 0, "messages": []},
    }


STANDBY = {"device": {"name": "/dev/sdb", "type": "sat"},
           "smartctl": {"exit_status": 2,
                        "messages": [{"string": "Device is in STANDBY mode, exit(2)",
                                      "severity": "information"}]}}
NO_BRIDGE = {"device": {"name": "/dev/sdc", "type": "scsi"},
             "smartctl": {"exit_status": 2, "messages": [
                 {"string": "Unknown USB bridge [0x1234:0x5678]", "severity": "error"}]}}


def media(name, model, serial, transport="sata", rotational=True):
    return {"name": name, "model": model, "serial": serial, "interface": transport,
            "media_type": "HDD (rotational)" if rotational else "SSD",
            "size": 4000787030016, "firmware": "82.00A82"}


class FakeSmart:
    """Stands in for `smartctl`: one recorded answer per /dev name, and every
    command line it was asked to run, so principle 1 can be checked."""

    def __init__(self, answers: dict[str, tuple[int, dict]]):
        self.answers = answers
        self.commands: list[list[str]] = []

    def run_status(self, argv, timeout=10.0):
        self.commands.append(list(argv))
        name = argv[-1]
        if name not in self.answers:
            return 2, json.dumps(NO_BRIDGE)
        code, payload = self.answers[name]
        return code, json.dumps(payload)

    def run_json(self, argv, timeout=10.0):
        if argv[:2] == ["smartctl", "--scan-open"]:
            return {"devices": [{"name": name, "type": "sat"}
                                for name in self.answers]}
        return None


def install(answers: dict[str, tuple[int, dict]]) -> FakeSmart:
    fake = FakeSmart(answers)
    linux.run_status = fake.run_status          # type: ignore[assignment]
    linux.run_json = fake.run_json              # type: ignore[assignment]
    prognosis.smart_access = lambda: {          # type: ignore[assignment]
        "ok": True, "installed": True, "privileged": True,
        "needs": "CAP_SYS_RAWIO or root for SMART health", "reason": None}
    return fake


def collector(tmp: str, answers: dict[str, tuple[int, dict]]) -> tuple:
    fake = install(answers)
    return prognosis.PrognosisCollector(data_dir=tmp), fake


def volumes(*rows):
    return {"available": True, "media": list(rows)}


def item_of(payload, key_prefix):
    return next((i for i in payload["items"] if i["key"].startswith(key_prefix)), None)


# ------------------------------------------------------------- sysfs tree
def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text if text.endswith("\n") else text + "\n")


def build_sysfs(root: Path, *, link_speed="3.0 Gbps", link_max="6.0 Gbps",
                ce=0, ue=0, dimm_ce=0, dimm_ue=0, correctable=0, nonfatal=0,
                fatal=0, battery=(44_000_000, 65_000_000, 512),
                net_speed=100) -> None:
    """A /sys good enough for every source the collector reads."""
    sysfs = root / "sys"
    # An ATA link on port 3, carrying sda.
    ata_dir = sysfs / "devices" / "ata3"
    write(ata_dir / "link3" / "sata_spd", link_speed)
    write(ata_dir / "link3" / "sata_spd_max", link_max)
    (sysfs / "class" / "ata_link").mkdir(parents=True, exist_ok=True)
    os.symlink(ata_dir / "link3", sysfs / "class" / "ata_link" / "link3")
    target = ata_dir / "host0" / "target0" / "0:0:0:0"
    write(target / "model", "WDC WD40EFRX-68N32N0")
    write(target / "serial", "S4EVNF0M123456")
    write(target / "rev", "82.00A82")
    (sysfs / "block" / "sda").mkdir(parents=True, exist_ok=True)
    os.symlink(target, sysfs / "block" / "sda" / "device")
    write(sysfs / "block" / "sda" / "size", "7814037168")
    write(sysfs / "block" / "sda" / "queue" / "rotational", "1")

    # One memory controller with one module.
    mc = sysfs / "devices" / "system" / "edac" / "mc" / "mc0"
    write(mc / "mc_name", "Skylake Socket#0 IMC#0")
    write(mc / "ce_count", str(ce))
    write(mc / "ue_count", str(ue))
    write(mc / "dimm0" / "dimm_label", "DIMM_A2")
    write(mc / "dimm0" / "dimm_ce_count", str(dimm_ce))
    write(mc / "dimm0" / "dimm_ue_count", str(dimm_ue))
    write(mc / "dimm0" / "dimm_mem_type", "DDR4")

    # A PCIe endpoint with AER counters and a driver.
    pci = sysfs / "bus" / "pci" / "devices" / "0000:01:00.0"
    write(pci / "aer_dev_correctable",
          f"RxErr 0\nBadTLP 0\nBadDLLP 0\nRollover 0\nTimeout 0\n"
          f"NonFatalErr 0\nCorrIntErr 0\nHeaderOF 0\nTOTAL_ERR_COR {correctable}\n")
    write(pci / "aer_dev_nonfatal", f"Undefined 0\nTOTAL_ERR_NONFATAL {nonfatal}\n")
    write(pci / "aer_dev_fatal", f"Undefined 0\nTOTAL_ERR_FATAL {fatal}\n")
    write(pci / "vendor", "0x144d")
    write(pci / "device", "0xa80a")
    write(pci / "class", "0x010802")
    (sysfs / "bus" / "pci" / "drivers" / "nvme").mkdir(parents=True, exist_ok=True)
    os.symlink(sysfs / "bus" / "pci" / "drivers" / "nvme", pci / "driver")

    # A battery.
    if battery:
        full, design, cycles = battery
        bat = sysfs / "class" / "power_supply" / "BAT0"
        write(bat / "type", "Battery")
        write(bat / "energy_full", str(full))
        write(bat / "energy_full_design", str(design))
        write(bat / "cycle_count", str(cycles))
        write(bat / "status", "Discharging")
        write(bat / "capacity", "44")
        write(bat / "manufacturer", "LGC")
        write(bat / "model_name", "5B10W13");

    # One physical interface, one bridge (which must be ignored).
    eth = sysfs / "class" / "net" / "eth0"
    (eth / "device").mkdir(parents=True, exist_ok=True)
    write(eth / "operstate", "up")
    write(eth / "speed", str(net_speed))
    write(eth / "duplex", "full")
    (sysfs / "bus" / "pci" / "drivers" / "igb").mkdir(parents=True, exist_ok=True)
    os.symlink(sysfs / "bus" / "pci" / "drivers" / "igb", eth / "device" / "driver")
    write(sysfs / "class" / "net" / "br0" / "operstate", "up")


# ============================================================ 1. parsing
def check_parsing() -> None:
    head("Parsing: every judged counter by id, everything else kept unread")
    parsed = prognosis.parse_smartctl(ata(
        [(5, 27, None), (187, 0, None), (188, 0, None), (197, 14, None),
         (198, 0, None), (199, 3, None), (9, 28104, None)],
        extra=((1, 12345678901, "12345678901"),)))
    check("the six judged ATA ids are extracted",
          sorted(parsed["attributes"]) == ["187", "188", "197", "198", "199", "5"],
          str(sorted(parsed["attributes"])))
    check("attribute 197's raw value is read", parsed["attributes"]["197"]["raw"] == 14)
    check("an unjudged vendor attribute lands in raw, never in attributes",
          "1" not in parsed["attributes"]
          and any(a["id"] == 1 for a in parsed["raw"]["vendor_attributes"]))
    check("power-on hours and temperature are read",
          parsed["power_on_hours"] == 28104 and parsed["temperature_c"] == 41)
    check("the drive's own status and last self-test are read",
          parsed["passed"] is True and parsed["selftest_passed"] is True)

    packed = prognosis.parse_attribute(
        {"id": 5, "name": "Reallocated_Sector_Ct", "raw":
         {"value": 12884901899, "string": "11 (Average 9)"}})
    check("a packed raw value takes the first integer of the string, and says so",
          packed["raw"] == 11 and packed["packed"] is True, str(packed["raw"]))
    plain = prognosis.parse_attribute(
        {"id": 5, "name": "Reallocated_Sector_Ct", "raw": {"value": 27, "string": "27"}})
    check("an unpacked raw value is not marked packed",
          plain["raw"] == 27 and plain["packed"] is False)
    check("when_failed '-' means never", plain["when_failed"] is None)
    flagged = prognosis.parse_attribute({"id": 5, "when_failed": "FAILING_NOW",
                                         "raw": {"value": 3, "string": "3"}})
    check("when_failed is carried through", flagged["when_failed"] == "FAILING_NOW")

    log = prognosis.parse_smartctl(nvme(used=91, warning=0x04))
    check("the NVMe health log is read by field",
          log["nvme"]["percentage_used"] == 91 and log["nvme"]["media_errors"] == 0)
    check("critical_warning bits are named in words",
          log["nvme"]["critical_warning_bits"] == [
              "reliability is degraded: the media is wearing out or has faulted"],
          str(log["nvme"]["critical_warning_bits"]))
    check("data units written become bytes at 512 000 per unit",
          log["nvme"]["bytes_written"] == 812345678 * 512_000)

    aer = prognosis.parse_aer("RxErr 4\nBadTLP 0\nTOTAL_ERR_COR 1240\n")
    check("the AER text parser reads name/count pairs",
          aer == {"RxErr": 4, "BadTLP": 0, "TOTAL_ERR_COR": 1240}, str(aer))
    check("a missing AER file parses as nothing, not as zero",
          prognosis.parse_aer(None) == {})

    counters = prognosis.counters_of(parsed)
    check("the counter set is flat, small and only the judged numbers",
          set(counters) == {"5", "187", "188", "197", "198", "199",
                            "power_on_hours", "temperature_c"}, str(sorted(counters)))


# ============================================================== 2. rules
def check_disk_rules() -> None:
    head("6.1-6.3: rising beats non-zero beats absent")
    with tempfile.TemporaryDirectory() as tmp:
        healthy = ata([(5, 27, None), (187, 0, None), (188, 0, None),
                       (197, 3, None), (198, 0, None), (199, 0, None)])
        risen = ata([(5, 27, None), (187, 0, None), (188, 0, None),
                     (197, 14, None), (198, 0, None), (199, 0, None)])
        vols = volumes(media("sda", "WDC WD40EFRX-68N32N0", "S4EVNF0M123456"))
        col, _ = collector(tmp, {"/dev/sda": (0, healthy)})
        first = col.sample(volumes=vols, now=1000.0)
        item = item_of(first, "disk_failing:")
        check("a non-zero pending count is a warn item even while it is stable",
              item is not None and item["severity"] == "warn"
              and "unreadable right now" in item["detail"], item and item["detail"][:70])
        check("a stable reallocated count says how many reads it held over",
              item is not None and any(s["id"] == "5" for s in item["stable"])
              and "unchanged across the" in item["detail"])
        check("the evidence quotes the attribute id and the name",
              item is not None and any("(197)" in e["label"] for e in item["evidence"]))

        col._smart_at = None
        linux.run_status = FakeSmart({"/dev/sda": (0, risen)}).run_status  # type: ignore
        second = col.sample(volumes=vols, now=2000.0)
        item = item_of(second, "disk_failing:")
        check("a pending count that rose since the last read is critical",
              item is not None and item["severity"] == "critical", item and item["severity"])
        check("the sentence names both numbers and when the old one was read",
              item is not None and "14, up from 3" in item["detail"], item and item["detail"][:90])
        check("rising_since is the previous read, not now",
              item is not None and item["rising_since"] == 1000.0)
        check("a drive that still says PASSED gets that said out loud",
              item is not None and "still says PASSED" in item["detail"])

    with tempfile.TemporaryDirectory() as tmp:
        failing = ata([(5, 27, None), (197, 0, None)], passed=False)
        col, _ = collector(tmp, {"/dev/sda": (8, failing)})
        out = col.sample(volumes=volumes(media("sda", "WDC", "S1")), now=1000.0)
        item = item_of(out, "disk_failing:")
        check("smart_status FAILING is critical on its own",
              item is not None and item["severity"] == "critical"
              and "says FAILING" in item["detail"])

    with tempfile.TemporaryDirectory() as tmp:
        bad_test = ata([(5, 0, None)], selftest=("Completed: read failure", False))
        col, _ = collector(tmp, {"/dev/sda": (0, bad_test)})
        out = col.sample(volumes=volumes(media("sda", "WDC", "S1")), now=1000.0)
        item = item_of(out, "disk_failing:")
        check("a failed self-test in the drive's own log is critical",
              item is not None and item["severity"] == "critical"
              and "read failure" in item["detail"])

    with tempfile.TemporaryDirectory() as tmp:
        flagged = ata([(5, 4, "FAILING_NOW")])
        col, _ = collector(tmp, {"/dev/sda": (8, flagged)})
        out = col.sample(volumes=volumes(media("sda", "WDC", "S1")), now=1000.0)
        item = item_of(out, "disk_failing:")
        check("an attribute the drive flags when_failed is critical",
              item is not None and item["severity"] == "critical"
              and "flagged failed by the drive itself" in item["detail"])

    head("6.2: the cable is not the platter")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S1"))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(199, 2, None)]))})
        col.sample(volumes=vols, now=1000.0)
        col._smart_at = None
        linux.run_status = FakeSmart({"/dev/sda": (0, ata([(199, 9, None)]))}).run_status  # type: ignore
        out = col.sample(volumes=vols, now=2000.0)
        item = item_of(out, "disk_cable:")
        check("a rising CRC count is its own warn item, never critical",
              item is not None and item["severity"] == "warn", item and item["severity"])
        check("it says cable/connector/port, and that no data is lost",
              item is not None and "cable" in item["detail"]
              and "nothing is lost" in item["detail"])
        check("a rising CRC count does not become a failing-disk item",
              item_of(out, "disk_failing:") is None)

    head("6.3: endurance, and what a percentage means")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("nvme0n1", "Samsung SSD 980 PRO 1TB", "S6PXNX0T234567",
                             transport="nvme", rotational=False))
        for used, want in ((50, None), (75, "info"), (91, "warn"), (104, "critical")):
            col, _ = collector(tmp, {"/dev/nvme0n1": (0, nvme(used=used))})
            out = col.sample(volumes=vols, now=1000.0)
            item = item_of(out, "disk_wear:")
            got = item["severity"] if item else None
            check(f"percentage_used {used} -> {want or 'no item'}", got == want, str(got))
        col, _ = collector(tmp, {"/dev/nvme0n1": (0, nvme(used=104))})
        item = item_of(col.sample(volumes=vols, now=1000.0), "disk_wear:")
        check("past 100 % the sentence says the warranty and the error rate, not a guess",
              "no longer characterised" in item["detail"]
              and "probably" not in item["detail"].lower())

    head("6.1: NVMe's own flags")
    # A fresh data dir per case: the ring is deliberately persistent, so
    # sharing one would make the second read of every fixture a "rise".
    for payload, label, want, phrase in (
            (nvme(warning=0x04), "a set critical_warning bit is critical and is named "
             "in words", "critical", "reliability is degraded"),
            (nvme(spare=5, spare_floor=10), "spare below the drive's own floor is "
             "critical", "critical", "below the 10 % floor"),
            (nvme(media_errors=3), "a stable non-zero media_errors is a warning, not a "
             "critical", "warn", "unchanged across")):
        with tempfile.TemporaryDirectory() as tmp:
            vols = volumes(media("nvme0n1", "Samsung", "S2", transport="nvme",
                                 rotational=False))
            col, _ = collector(tmp, {"/dev/nvme0n1": (0, payload)})
            item = item_of(col.sample(volumes=vols, now=1000.0), "disk_failing:")
            check(label, item is not None and item["severity"] == want
                  and phrase in item["detail"],
                  str(item and item["severity"]))

    head("6.4: a sleeping disk is left asleep")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S1"))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(5, 27, None)]))})
        col.sample(volumes=vols, now=1000.0)
        col._smart_at = None
        linux.run_status = FakeSmart({"/dev/sda": (2, STANDBY)}).run_status  # type: ignore
        out = col.sample(volumes=vols, now=2000.0)
        device = out["devices"][0]
        check("standby is reported as asleep, not as a failure",
              device["smart"]["asleep"] is True and device["smart"]["read"] is False)
        check("a sleeping disk produces no item at all",
              not [i for i in out["items"] if i["kind"] == "disk"])
        check("the checks strip counts it as asleep", out["checks"]["smart"]["asleep"] == 1)
        check("its last counters are kept, not thrown away",
              device["smart"].get("attributes", {}).get("5", {}).get("raw") == 27)

    with tempfile.TemporaryDirectory() as tmp:
        col, _ = collector(tmp, {})
        out = col.sample(volumes=volumes(media("sdc", "Some USB disk", "S9")), now=1000.0)
        device = out["devices"][0]
        check("a bridge smartctl cannot open is unread with the reason, not a finding",
              device["smart"]["read"] is False and device["smart"]["asleep"] is False
              and "bridge" in (device["smart"]["reason"] or "").lower(),
              device["smart"]["reason"])


def check_sysfs_rules() -> None:
    head("6.5-6.8: links, interfaces, ECC and PCIe")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build_sysfs(root)
        prognosis.SYSFS_ROOT = str(root)
        col, _ = collector(tmp, {})

        out = col.sample(now=1000.0)
        link = next(link for link in out["links"] if link["ata"] == "link3")
        check("a link is joined to the disk on its ATA port",
              link["disk"] == "sda", str(link))
        item = item_of(out, "sata_downgraded:")
        check("3.0 Gbps on a 6.0 Gbps link is a warn item",
              item is not None and item["severity"] == "warn")
        check("the item says it is a ceiling nothing on the machine chose",
              item is not None and "ceiling" in item["detail"])

        build_sysfs_reset(root)
        build_sysfs(root, link_speed="<unknown>", link_max="")
        out = col.sample(now=1000.0)
        link = next(link for link in out["links"] if link["ata"] == "link3")
        check("an unnegotiated link is a note, never an item",
              link["speed"] is None and item_of(out, "sata_downgraded:") is None
              and "not negotiated" in (link["note"] or ""))

        build_sysfs_reset(root)
        build_sysfs(root, net_speed=1000)
        col2, _ = collector(tmp, {})
        col2.sample(now=1000.0)
        build_sysfs_reset(root)
        build_sysfs(root, net_speed=100)
        out = col2.sample(now=2000.0)
        item = item_of(out, "link_downgraded:")
        check("an interface below the speed this machine has seen it run at warns",
              item is not None and item["severity"] == "warn", str(item and item["title"]))
        check("the ceiling quoted is the machine's own past, with both numbers",
              item is not None and "100 Mbit/s" in item["detail"]
              and "1 Gbit/s" in item["detail"])
        check("a bridge is not a physical interface and is never judged",
              all(n["name"] != "br0" for n in out["nics"]))

        build_sysfs_reset(root)
        build_sysfs(root, net_speed=-1)
        col3, _ = collector(tmp, {})
        out = col3.sample(now=1000.0)
        nic = out["nics"][0]
        check("a driver that reports no speed is a note, not an item",
              nic["speed_mbps"] is None and item_of(out, "link_downgraded:") is None
              and "not reported by the driver" in (nic["note"] or ""))

        build_sysfs_reset(root)
        build_sysfs(root, ue=2, dimm_ue=2)
        col4, _ = collector(tmp, {})
        out = col4.sample(now=1000.0)
        item = item_of(out, "ecc_uncorrected:")
        check("an uncorrected ECC error is critical and names the module",
              item is not None and item["severity"] == "critical"
              and "DIMM_A2" in item["detail"], str(item and item["title"]))

        build_sysfs_reset(root)
        build_sysfs(root, ce=0, dimm_ce=0)
        col5, _ = collector(tmp, {})
        col5.sample(now=1000.0)
        build_sysfs_reset(root)
        build_sysfs(root, ce=3, dimm_ce=3)
        out = col5.sample(now=1000.0 + 86400)
        item = item_of(out, "ecc_rising:")
        check("three corrected errors in a day is a warn item on the module",
              item is not None and item["severity"] == "warn"
              and "DIMM_A2" in item["detail"], str(item and item["title"]))
        check("it says corrected means nothing was lost",
              item is not None and "nothing was lost" in item["detail"])

        build_sysfs_reset(root)
        build_sysfs(root, ce=1000)
        col6, _ = collector(tmp, {})
        out = col6.sample(now=1000.0)
        check("a large lifetime CE count with no rate behind it is not an item",
              item_of(out, "ecc_rising:") is None)

        build_sysfs_reset(root)
        build_sysfs(root, fatal=1)
        col7, _ = collector(tmp, {})
        out = col7.sample(now=1000.0)
        item = item_of(out, "pcie_errors:")
        check("a fatal PCIe error is critical", item is not None
              and item["severity"] == "critical")
        check("the device is named by class and vendor, not by hex alone",
              item is not None and "Samsung" in item["title"], str(item and item["title"]))

        build_sysfs_reset(root)
        build_sysfs(root, correctable=0)
        col8, _ = collector(tmp, {})
        col8.sample(now=1000.0)
        build_sysfs_reset(root)
        build_sysfs(root, correctable=1240)
        out = col8.sample(now=1000.0 + 86400)
        item = item_of(out, "pcie_errors:")
        check("1240 corrected link errors in a day is a warn item",
              item is not None and item["severity"] == "warn")
        check("it says they were retried and succeeded",
              item is not None and "retried and succeeded" in item["detail"])

        build_sysfs_reset(root)
        build_sysfs(root, correctable=4)
        col9, _ = collector(tmp, {})
        col9.sample(now=1000.0)
        build_sysfs_reset(root)
        build_sysfs(root, correctable=8)
        out = col9.sample(now=1000.0 + 86400)
        check("four corrected link errors in a day is below the floor and silent",
              item_of(out, "pcie_errors:") is None)

        build_sysfs_reset(root)
        build_sysfs(root, battery=(44_000_000, 65_000_000, 512))
        col10, _ = collector(tmp, {})
        out = col10.sample(now=1000.0)
        item = item_of(out, "power_worn:")
        check("a battery at 68 % of its design capacity is a warn item",
              item is not None and item["severity"] == "warn", str(item and item["title"]))
        check("it says nothing reports this until the power goes",
              item is not None and "until the power actually goes" in item["detail"])

        build_sysfs_reset(root)
        build_sysfs(root, battery=(60_000_000, 65_000_000, 40))
        col11, _ = collector(tmp, {})
        out = col11.sample(now=1000.0)
        check("a healthy battery is not an item", item_of(out, "power_worn:") is None)

        build_sysfs_reset(root)
        build_sysfs(root, battery=None)
        col12, _ = collector(tmp, {})
        out = col12.sample(now=1000.0)
        check("no battery is a reason, not a missing check",
              out["checks"]["power"]["available"] is False
              and "power_supply" in out["checks"]["power"]["reason"])
    prognosis.SYSFS_ROOT = ""


def build_sysfs_reset(root: Path) -> None:
    shutil.rmtree(root / "sys", ignore_errors=True)


# ================================================== 3. never wake, never test
def check_principle_read_only() -> None:
    head("Principle 1: read only, never a self-test, never a wake-up")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S1"), media("sdb", "WDC", "S2"))
        col, fake = collector(tmp, {"/dev/sda": (0, ata([(5, 0, None)])),
                                    "/dev/sdb": (0, ata([(5, 0, None)]))})
        col.sample(volumes=vols, now=1000.0)
        smart_cmds = [c for c in fake.commands]
        check("every command line carries -n standby",
              smart_cmds and all("-n" in c and "standby" in c for c in smart_cmds),
              f"{len(smart_cmds)} command(s)")
        check("no command line ever carries -t",
              all("-t" not in c for c in smart_cmds))
        col2, fake2 = collector(tmp, {"/dev/sda": (0, ata([(5, 0, None)]))})
        col2.sample(volumes=volumes(media("sda", "WDC", "S1")),
                    settings={"wake_disks": True}, now=1000.0)
        check("only an explicit opt-in drops -n standby",
              fake2.commands and all("-n" not in c for c in fake2.commands))
        check("and even then there is no -t",
              all("-t" not in c for c in fake2.commands))
        check("the argv builder is the one place this is decided",
              "-n" in prognosis.smartctl_argv("sda")
              and "-n" not in prognosis.smartctl_argv("sda", wake_disks=True)
              and "-t" not in prognosis.smartctl_argv("sda", wake_disks=True))
        check("the module contains no self-test invocation anywhere",
              '"-t"' not in Path(prognosis.__file__).read_text()
              and "'-t'" not in Path(prognosis.__file__).read_text())

    head("Cadence: a pass costs one call per disk per interval, not per tick")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S1"))
        col, fake = collector(tmp, {"/dev/sda": (0, ata([(5, 0, None)]))})
        col.sample(volumes=vols, now=1000.0)
        col.sample(volumes=vols, now=1120.0)
        col.sample(volumes=vols, now=1240.0)
        check("three events ticks inside the interval are one smartctl pass",
              len(fake.commands) == 1, f"{len(fake.commands)} call(s)")
        col.sample(volumes=vols, now=1000.0 + 31 * 60)
        check("the pass runs again once the interval has elapsed",
              len(fake.commands) == 2, f"{len(fake.commands)} call(s)")


# ============================================================== 4. a guest
def check_guest() -> None:
    head("Principle 4: a guest says so, and a virtual disk is never judged")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "QEMU HARDDISK", None))
        # A fixture that would be critical on real hardware.
        col, _ = collector(tmp, {"/dev/sda": (8, ata([(197, 40, None)], passed=False))})
        out = col.sample(volumes=vols, system={"virtualization": "kvm"}, now=1000.0)
        check("a QEMU disk is marked virtual", out["devices"][0]["virtual"] is True)
        check("and produces no item even from a failing fixture",
              not [i for i in out["items"] if i["kind"] == "disk"])
        note = out["checks"]["guest"]["note"] or ""
        check("the guest note names the hypervisor and says where to run the agent",
              "kvm" in note and "hypervisor" in note, note[:80])
        out = col.sample(volumes=volumes(media("sda", "Samsung SSD 870", "S1")),
                         system={}, now=1000.0)
        check("on metal there is no guest note",
              out["checks"]["guest"]["note"] is None)


# =============================================================== 5. the ring
def check_ring() -> None:
    head("The ring: rising survives a restart, is capped, and cannot be fatal")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S4EVNF0M123456"))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(197, 3, None)]))})
        col.sample(volumes=vols, now=1000.0)
        check("the ring file is written beside the recorder",
              os.path.exists(os.path.join(tmp, "prognosis.json")))
        check("and is not world-readable",
              oct(os.stat(os.path.join(tmp, "prognosis.json")).st_mode)[-3:] == "600")
        # A whole new collector: the process restarted.
        linux.run_status = FakeSmart({"/dev/sda": (0, ata([(197, 14, None)]))}).run_status  # type: ignore
        fresh = prognosis.PrognosisCollector(data_dir=tmp)
        out = fresh.sample(volumes=vols, now=2000.0)
        item = item_of(out, "disk_failing:")
        check("a restarted agent still sees the rise",
              item is not None and item["severity"] == "critical"
              and "14, up from 3" in item["detail"])

        for index in range(20):
            fresh._ring.push("S4EVNF0M123456", {"197": index}, 3000.0 + index)
        check(f"the ring keeps at most {prognosis.RING_DEPTH} reads per subject",
              len(fresh._ring.reads("S4EVNF0M123456")) == prognosis.RING_DEPTH)

        Path(tmp, "prognosis.json").write_text("{not json at all")
        broken = prognosis.PrognosisCollector(data_dir=tmp)
        check("a corrupt ring file is ignored, never fatal",
              broken._ring.previous("S4EVNF0M123456") is None)
        Path(tmp, "prognosis.json").write_text('["a list, not an object"]')
        broken = prognosis.PrognosisCollector(data_dir=tmp)
        check("a ring file of the wrong shape is ignored too",
              broken._ring.previous("S4EVNF0M123456") is None)

    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S1"))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(5, 27, None)]))})
        col.sample(volumes=vols, now=1000.0)
        col._smart_at = None
        linux.run_status = FakeSmart({"/dev/sda": (2, STANDBY)}).run_status  # type: ignore
        col.sample(volumes=vols, now=2000.0)
        check("a standby read does not overwrite the values a rise is measured against",
              col._ring.previous("S1")["counters"]["5"] == 27)


# ============================================================ 7. sentences
def check_sentences() -> None:
    head("Sentences: numbers in, hedges out")
    hedges = ("probably", "likely", "may fail", "might fail", "could be failing",
              "seems", "appears to")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build_sysfs(root, ue=1, dimm_ue=1, fatal=1)
        prognosis.SYSFS_ROOT = str(root)
        vols = volumes(media("sda", "WDC", "S1"),
                       media("nvme0n1", "Samsung", "S2", transport="nvme", rotational=False))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(197, 9, None), (199, 4, None)])),
                                 "/dev/nvme0n1": (0, nvme(used=91))})
        out = col.sample(volumes=vols, now=1000.0)
        prognosis.SYSFS_ROOT = ""
        check("the fixtures produce several items to read",
              len(out["items"]) >= 4, f"{len(out['items'])} items")
        for item in out["items"]:
            lowered = item["detail"].lower()
            check(f"{item['key']}: no hedge in the detail",
                  not any(h in lowered for h in hedges))
            check(f"{item['key']}: the detail carries a number",
                  any(ch.isdigit() for ch in item["detail"]))
            check(f"{item['key']}: the title names the subject",
                  bool(item["title"]) and not item["title"].endswith("."))
        disk = item_of(out, "disk_failing:")
        check("an ATA sentence quotes the attribute id in brackets",
              "(197)" in disk["detail"], disk["detail"][:60])
        check("every item carries since and a changes list",
              all("since" in i and isinstance(i["changes"], list) for i in out["items"]))
        check("an item on the first sample is marked as predating the record",
              all(i["since_start"] for i in out["items"]))


def check_since() -> None:
    head("since: stable while the item holds, dropped when it goes")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S1"))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(197, 9, None)]))})
        first = col.sample(volumes=vols, now=1000.0)
        since = item_of(first, "disk_failing:")["since"]
        second = col.sample(volumes=vols, now=1120.0)
        check("since holds across ticks", item_of(second, "disk_failing:")["since"] == since)
        col._smart_at = None
        linux.run_status = FakeSmart({"/dev/sda": (0, ata([(197, 0, None)]))}).run_status  # type: ignore
        third = col.sample(volumes=vols, now=1000.0 + 31 * 60)
        check("a cleared counter drops the item and its since",
              item_of(third, "disk_failing:") is None and not col._since)


# ========================================================== 6. the host side
def check_host_side() -> None:
    head("The host's record: one row per device per day, and what it adds")
    with tempfile.TemporaryDirectory() as tmp:
        history = History(Path(tmp) / "t.db", enabled=True)
        record = wear_mod.Wear(history)
        day = wear_mod.day_of(time.time())

        with tempfile.TemporaryDirectory() as agent_dir:
            vols = volumes(media("sda", "WDC", "S4EVNF0M123456"))
            col, _ = collector(agent_dir, {"/dev/sda": (0, ata([(5, 27, None),
                                                                (197, 0, None)]))})
            section = col.sample(volumes=vols, now=time.time())
        record.annotate("n1", section)
        rows = history.wear_rows("n1", "disk", "S4EVNF0M123456", since=0)
        check("the first report writes one row for the disk", len(rows) == 1, str(rows))
        record.annotate("n1", section)
        record.annotate("n1", section)
        rows = history.wear_rows("n1", "disk", "S4EVNF0M123456", since=0)
        check("three reports the same day are still one row", len(rows) == 1)
        check("the row holds the judged counters and nothing else",
              set(rows[0]["counters"]) <= set(wear_mod.DISK_KEYS), str(rows[0]["counters"]))
        check("the device gains a history block naming how long it has been watched",
              (section["devices"][0].get("history") or {}).get("days") == 1,
              str(section["devices"][0].get("history")))

        # Ninety days of a drive filling up at a known rate.
        for index in range(90):
            history.write_wear("n1", day - (89 - index) * 86400,
                               [("disk", "NV1", {"percentage_used": 10 + index * 0.5})])
        series = history.wear_rows("n1", "disk", "NV1", since=0)
        forecast = wear_mod.fit_forecast(series, "percentage_used")
        check("a 90-day series is fitted and quotes its window",
              forecast is not None and forecast["fitted_days"] == 90
              and forecast["points"] == 90, str(forecast and forecast["fitted_days"]))
        check("the slope is the planted one",
              forecast is not None and abs(forecast["per_day"] - 0.5) < 0.01,
              str(forecast and forecast["per_day"]))
        planted = day + ((100 - (10 + 89 * 0.5)) / 0.5) * 86400
        check("and the date it reaches 100 % is the arithmetic one",
              forecast is not None and abs(forecast["reaches_at"] - planted) < 86400,
              str(forecast and forecast["reaches_at"]))

        check("fewer than 14 points is no forecast at all, not a shaky one",
              wear_mod.fit_forecast(series[-13:], "percentage_used") is None)
        for index in range(30):
            history.write_wear("n2", day - (29 - index) * 86400,
                               [("disk", "FLAT", {"percentage_used": 40})])
        flat = wear_mod.fit_forecast(history.wear_rows("n2", "disk", "FLAT", since=0),
                                     "percentage_used")
        check("a flat series says not rising rather than naming a date",
              flat is not None and flat["rising"] is False and flat["reaches_at"] is None)

        for index in range(30):
            value = 12 if index < 20 else 27
            history.write_wear("n3", day - (29 - index) * 86400,
                               [("disk", "S9", {"5": value})])
        rows = history.wear_rows("n3", "disk", "S9", since=0)
        since, watched_all = wear_mod.unchanged_since(rows, "5", 27)
        check("unchanged_since finds the day the counter last moved",
              since == day - 9 * 86400 and watched_all is False,
              time.strftime("%d %b", time.localtime(since)) if since else "none")
        since, watched_all = wear_mod.unchanged_since(
            history.wear_rows("n2", "disk", "FLAT", since=0), "percentage_used", 40)
        check("a counter that never moved says so is only as old as the record",
              watched_all is True)
        check("a value that is not the current one has no since",
              wear_mod.unchanged_since(rows, "5", 3) == (None, False))

        head("The sentence the host rewrites")
        item = {"says": ["Something happened."],
                "stable": [{"id": "5", "label": "Reallocated_Sector_Ct (5)", "value": 27,
                            "reads": 8, "since_day": None}], "closing": None}
        agent_form = prognosis.build_detail(item)
        check("the agent's form counts its own reads",
              "unchanged across the 8 reads this agent has made" in agent_form,
              agent_form)
        item["stable"][0].update({"since_day": day - 9 * 86400, "since_all": False})
        host_form = prognosis.build_detail(item)
        check("the host's form names the date instead",
              "unchanged since" in host_form and "reads this agent" not in host_form,
              host_form)
        item["stable"][0]["since_all"] = True
        watched_form = prognosis.build_detail(item)
        check("and says so when the run reaches the start of the record",
              "as long as this host has watched it" in watched_form, watched_form)
        item2 = {"says": ["percentage_used is 91."], "stable": [], "closing": None,
                 "forecast": {"per_day": 0.09, "unit": "%", "target": 100,
                              "fitted_days": 90, "reaches_at": time.time() + 90 * 86400}}
        forecast_form = prognosis.build_detail(item2)
        check("a forecast sentence always states the window it was fitted over",
              "over the last 90 days" in forecast_form, forecast_form)

        head("A hostile report cannot make the record grow without limit")
        hostile = {"available": True, "items": [], "devices": [
            {"subject": f"X{i}", "kind": "disk", "smart": {"read": True},
             "counters": {"5": i}} for i in range(50_000)]}
        record.annotate("hostile", hostile)
        subjects = history.wear_subjects("hostile")
        check(f"a report claiming 50 000 disks writes at most {wear_mod.MAX_SUBJECTS} rows",
              len(subjects) <= wear_mod.MAX_SUBJECTS, f"{len(subjects)} row(s)")
        check("and only that many devices were annotated",
              sum(1 for d in hostile["devices"] if "history" in d) <= wear_mod.MAX_SUBJECTS)

        head("Retention and forgetting")
        history.write_wear("n4", day - 500 * 86400, [("disk", "OLD", {"5": 1})])
        history._last_wear_prune = 0.0
        history.prune_wear(400)
        check("rows past the retention are dropped",
              history.wear_rows("n4", "disk", "OLD", since=0) == [])
        record.forget("n1")
        check("forgetting a node clears what was memoised for it",
              not any(k[0] == "n1" for k in record._written))
        history.close()


# ========================================================= 9. notifier fold
def check_notifier_fold() -> None:
    head("The notifier and the node meta read the section without a second pass")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S1"))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(197, 14, None)]))})
        section = col.sample(volumes=vols, now=1000.0)
    payload = nodes_mod._notifiable({"prognosis": section})
    keys = [f["key"] for f in payload["findings"]]
    check("items come through namespaced under prognosis:",
          any(k.startswith("prognosis:disk_failing:") for k in keys), str(keys))
    finding = next(f for f in payload["findings"] if f["key"].startswith("prognosis:"))
    check("the resource is the hardware itself", finding["resource"] == "hardware")
    check("and the culprit list is empty by construction",
          finding["culprits"] == [])
    check("the evidence survives as a flat map",
          isinstance(finding["evidence"], dict) and finding["evidence"])

    meta = nodes_mod._prognosis_meta(section)
    check("the node meta carries status, severity and a count",
          meta["prognosis_status"] == "wearing" and meta["prognosis_severity"] == "warn"
          and meta["prognosis_count"] == 1, str(meta))
    with tempfile.TemporaryDirectory() as tmp:
        col, _ = collector(tmp, {"/dev/sda": (8, ata([(5, 1, None)], passed=False))})
        failing = col.sample(volumes=volumes(media("sda", "WDC", "S1")), now=1000.0)
    meta = nodes_mod._prognosis_meta(failing)
    check("a failing disk makes the node's status failing",
          meta["prognosis_status"] == "failing"
          and meta["prognosis_severity"] == "critical", str(meta))
    check("an unavailable section carries nothing rather than zeroes that lie",
          nodes_mod._prognosis_meta({"available": False}) ==
          {"prognosis_status": None, "prognosis_severity": None, "prognosis_count": 0})
    check("prognosis is an accepted report section",
          "prognosis" in nodes_mod.DICT_SECTIONS)
    _, snapshot, dropped = nodes_mod.sanitise_report(
        {"agent": {}, "snapshot": {"prognosis": section}})
    check("and survives sanitise intact", "prognosis" in snapshot and not dropped,
          str(dropped))


# ================================================================ 8. joins
def check_joins() -> None:
    head("Joins: the disk under a storage finding, named -- and the culprits kept")
    with tempfile.TemporaryDirectory() as tmp:
        vols = volumes(media("sda", "WDC", "S4EVNF0M123456"))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(197, 14, None)]))})
        section = col.sample(volumes=vols, now=1000.0)

    analyzer = lag_mod.LagAnalyzer()
    cfg = config_module.get()
    processes = [
        {"pid": 900, "name": "postgres", "username": "postgres", "cpu": 4.0,
         "working_set": 400 * 1024 ** 2, "io_bytes_sec": 90 * 1024 ** 2,
         "lag_score": 40.0, "read_bytes_sec": 0, "write_bytes_sec": 90 * 1024 ** 2},
        {"pid": 901, "name": "rsync", "username": "root", "cpu": 1.0,
         "working_set": 40 * 1024 ** 2, "io_bytes_sec": 20 * 1024 ** 2,
         "lag_score": 12.0, "read_bytes_sec": 20 * 1024 ** 2, "write_bytes_sec": 0},
    ]
    snapshot = {"cpu": {"total": 20.0}, "memory": {"percent": 40.0},
                "disk": {"total": {"latency_ms": 400.0, "queue_length": 12.0,
                                   "busy_percent": 99.0}},
                "psi": {"io": {"full": {"avg10": 60.0}, "some": {"avg10": 80.0}}}}
    pressures = {"cpu": 0.2, "memory": 0.4, "disk": 1.0, "gpu": 0.0}
    for _ in range(max(1, cfg.sustain_ticks)):
        diagnosis = analyzer.diagnose(snapshot, processes, pressures, cfg,
                                      prognosis=section)
    findings = {f["key"]: f for f in diagnosis["findings"]}
    latency = findings.get("disk_latency")
    check("a disk_latency finding gains the hardware block",
          latency is not None and latency.get("hardware", {}).get("key",
                                                                  "").startswith("disk_failing:"),
          str(latency and latency.get("hardware")))
    check("and one sentence pointing at the Prognosis",
          latency is not None and "see the Prognosis" in latency["detail"])
    check("and keeps its culprits: a failing disk does not make the writer innocent",
          latency is not None and len(latency.get("culprits") or []) >= 1,
          str(len(latency.get("culprits") or []) if latency else 0))
    check("psi_io gains it too", "hardware" in (findings.get("psi_io") or {}))
    check("a CPU finding does not",
          "hardware" not in (findings.get("psi_cpu") or {"hardware": None})
          or "psi_cpu" not in findings)

    analyzer2 = lag_mod.LagAnalyzer()
    for _ in range(max(1, cfg.sustain_ticks)):
        clean = analyzer2.diagnose(snapshot, processes, pressures, cfg,
                                   prognosis={"available": True, "items": []})
    check("with nothing wearing out, no finding claims hardware context",
          all("hardware" not in f for f in clean["findings"]))
    check("and none of the details mentions the Prognosis",
          all("see the Prognosis" not in f["detail"] for f in clean["findings"]))

    head("The Outage Doctor stops sending the reader to look at SMART")
    collector_o = outage_mod.OutageCollector()
    events = {"crashes": {"events": [{"source_key": "disk_error",
                                      "timestamp": time.time() - 60,
                                      "title": "blk_update_request: I/O error"}]},
              "journal": {"readable": True}}
    plain = collector_o.sample({"available": True, "problems": []},
                               {"available": True, "ports": []}, {}, events, {}, {})
    item = next(i for i in plain["items"] if i["key"] == "disk_errors")
    check("without the Prognosis it still says to check SMART",
          "check SMART" in item["detail"])
    joined = outage_mod.OutageCollector().sample(
        {"available": True, "problems": []}, {"available": True, "ports": []},
        {}, events, {}, {}, prognosis=section)
    item = next(i for i in joined["items"] if i["key"] == "disk_errors")
    check("with it, the item quotes what SMART already said",
          "The Prognosis has the drive's own answer" in item["detail"]
          and "sda" in item["fix"], item["detail"][-90:])


# =========================================================== 10. the contract
def check_contract_entry() -> None:
    head("The contract: every field the view reads is in the section")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import check_contract  # noqa: PLC0415 -- a tool importing a tool, deliberately

    paths = check_contract.CONTRACT.get("prognosis", {}).get("node:prognosis")
    check("check_contract.py has a prognosis entry", bool(paths),
          f"{len(paths or [])} field(s)")
    if not paths:
        return
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build_sysfs(root, ue=1, dimm_ue=1, fatal=1)
        prognosis.SYSFS_ROOT = str(root)
        vols = volumes(media("sda", "WDC", "S1"),
                       media("nvme0n1", "Samsung", "S2", transport="nvme", rotational=False))
        col, _ = collector(tmp, {"/dev/sda": (0, ata([(197, 9, None), (199, 4, None)])),
                                 "/dev/nvme0n1": (0, nvme(used=91))})
        section = col.sample(volumes=vols, system={}, now=1000.0)
        prognosis.SYSFS_ROOT = ""
        # What the API actually serves is the *annotated* section -- the live
        # check reads /api/nodes/<node>/snapshot, which has been through
        # Wear.annotate -- so the fixture goes through it too, or the
        # host-added fields would look like a contract the agent breaks.
        history = History(Path(tmp) / "contract.db", enabled=True)
        wear_mod.Wear(history).annotate("n", section)
        history.close()
    missing = [path for path in paths if not check_contract.dig(section, path)[0]]
    check("every contracted field is present on a fixture-built section",
          not missing, ", ".join(missing[:6]))


# ============================================================ 11. this machine
def check_real_machine() -> None:
    head("This machine: every source degrades with a reason")
    import importlib
    importlib.reload(linux)
    importlib.reload(prognosis)
    from culprit.collectors import sysinfo
    with tempfile.TemporaryDirectory() as tmp:
        col = prognosis.PrognosisCollector(data_dir=tmp)
        system = sysinfo.collect()
        started = time.perf_counter()
        out = col.sample(system=system)
        cost = (time.perf_counter() - started) * 1000
        check("the collector runs against real sysfs without raising",
              out["available"] is True)
        for name, entry in (out["checks"] or {}).items():
            if name == "guest":
                continue
            check(f"checks.{name} says available or names a reason",
                  bool(entry.get("available")) or bool(entry.get("reason")),
                  str(entry.get("reason"))[:60])
        check("nothing is claimed ok without something having been read",
              out["status"] != "ok" or any(
                  (d["smart"] or {}).get("read") for d in out["devices"])
              or bool((out["memory"] or {}).get("controllers")) or bool(out["power"]))
        print(f"{DIM}     pass cost {cost:.1f} ms · {len(out['devices'])} disk(s) · "
              f"{len(out['links'])} link(s) · {len(out['nics'])} nic(s) · "
              f"{len(out['pci'])} PCIe device(s){RESET}")


def main() -> int:
    check_parsing()
    check_disk_rules()
    check_sysfs_rules()
    check_principle_read_only()
    check_guest()
    check_ring()
    check_sentences()
    check_since()
    check_joins()
    check_host_side()
    check_notifier_fold()
    check_contract_entry()
    check_real_machine()

    print("-" * 72)
    if failures:
        print(f"\n{RED}{len(failures)} check(s) failed.{RESET}\n")
        for name in failures[:20]:
            print(f"  {RED}·{RESET} {name}")
        print()
        return 1
    print(f"\n{GREEN}All Prognosis checks passed.{RESET}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
