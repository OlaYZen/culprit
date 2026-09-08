"""The Prognosis's memory: what the counters have been doing for months.

The agent can only ever say what changed between its own reads. Its ring is
eight deep and dies with the process, so "Reallocated_Sector_Ct rose since
03:10" is within reach and "unchanged since 3 August" and "91 % used, 100 %
around 14 February" are not -- those are statements about a span longer than
an agent's lifetime, and they are the two sentences an operator actually
plans around.

So the host keeps one row per device per day (`wear`, schema v12) and
annotates each incoming section with what that record adds:

* `devices[].history` -- how many days this device has been watched
* `devices[].forecast` / the wear item's forecast -- a least-squares fit of
  the endurance estimate, **only** with at least MIN_POINTS daily points, and
  always quoting how many days it was fitted over. A forecast that does not
  say what it was fitted over is a number with no error bars pretending to be
  a date.
* the *unchanged since* half of a sentence, in place of the agent's
  "unchanged across the 8 reads this agent has made" -- both rendered by
  `prognosis.build_detail`, so the two forms cannot drift apart.

Host-only, like verdict.py / expect.py / pulse.py. It never raises into
ingest: a missing row or a bad number costs a sentence, never a report.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from .collectors import prognosis as prognosis_mod
from .db import History

log = logging.getLogger("culprit.wear")

# A fit needs this many daily points before it may name a date. Two weeks is
# the smallest span over which a write-endurance slope is not mostly noise
# from one busy afternoon.
MIN_POINTS = 14
# And it looks no further back than this: a drive's write rate three months
# ago is not evidence about next month.
FIT_DAYS = 90
# The counters worth keeping a daily row of, per kind. Deliberately short --
# the point of one row per device per day is that a year of it is nothing.
DISK_KEYS = ("5", "187", "188", "197", "198", "199", "percentage_used",
             "media_errors", "available_spare", "power_on_hours", "temperature_c")
# A bound against a hostile or broken report, the same shape as the Pulse's.
# A valid token proves the sender holds a secret, not that its payload is
# sane: a report claiming fifty thousand disks must not turn into fifty
# thousand queries and fifty thousand rows a day.
MAX_SUBJECTS = 256
MAX_ITEMS = 200
# Both maps below are optimisations, not records: an agent that renames its
# subjects every report must not be able to grow them without limit, and
# dropping them costs one query and one redundant write.
MAX_MEMO = 4000


def day_of(ts: float) -> int:
    """Host-local midnight for a timestamp. Local rather than UTC because the
    row is read back as a date a person will say out loud."""
    parts = time.localtime(ts)
    return int(time.mktime((parts.tm_year, parts.tm_mon, parts.tm_mday,
                            0, 0, 0, 0, 0, -1)))


class Wear:
    def __init__(self, history: History) -> None:
        self.history = history
        # (node, kind, subject) -> (day, counters) already written, so the
        # section arriving every 120 s costs one comparison and no write.
        self._written: dict[tuple[str, str, str], tuple[int, dict]] = {}
        # One subject's daily rows, cached briefly: the section arrives every
        # 120 s per node and the answer changes once a day.
        self._cache: dict[tuple[str, str, str], tuple[float, list]] = {}

    # --------------------------------------------------------------- annotate
    def annotate(self, node: str, section: dict[str, Any],
                 now: float | None = None) -> None:
        """Add what only months of rows can say, and store today's numbers.

        Mutates the section in place -- it is host-owned after sanitise, the
        same contract expect.Expectations.annotate works under.
        """
        if not isinstance(section, dict) or not section.get("available"):
            return
        now = time.time() if now is None else now
        today = day_of(now)

        histories: dict[str, list[dict[str, Any]]] = {}
        for device in (section.get("devices") or [])[:MAX_SUBJECTS]:
            if not isinstance(device, dict):
                continue
            subject = str(device.get("subject") or "")
            if not subject:
                continue
            rows = self._rows(node, "disk", subject)
            histories[subject] = rows
            device["history"] = _span(rows)
            device["forecast"] = fit_forecast(rows, "percentage_used")

        for item in (section.get("items") or [])[:MAX_ITEMS]:
            if not isinstance(item, dict):
                continue
            self._annotate_item(node, item, histories, now)

        self._store(node, section, today)

    def _annotate_item(self, node: str, item: dict[str, Any],
                       histories: dict[str, list[dict[str, Any]]],
                       now: float) -> None:
        subject = str(item.get("subject") or "")
        kind = str(item.get("kind") or "")
        rows = histories.get(subject)
        if rows is None:
            rows = self._rows(node, kind or "disk", subject)
        changed = False
        for entry in item.get("stable") or []:
            if not isinstance(entry, dict):
                continue
            day, watched_all = unchanged_since(rows, str(entry.get("id")),
                                               entry.get("value"))
            if day is not None:
                entry["since_day"] = day
                entry["since_all"] = watched_all
                changed = True
        if str(item.get("key") or "").startswith("disk_wear:"):
            forecast = fit_forecast(rows, "percentage_used")
            if forecast:
                item["forecast"] = forecast
                changed = True
        if item.get("rising_since") is None and rows:
            # The agent restarted between the two reads that mattered, so it
            # has no previous read to point at; the daily record does.
            first = first_rise(rows, item)
            if first is not None:
                item["rising_since"] = first
        if changed:
            # One function owns both renderings, so "unchanged across 8 reads"
            # and "unchanged since 3 Aug" can never disagree about the number
            # in front of them.
            item["detail"] = prognosis_mod.build_detail(item)
        item["watched_days"] = _span(rows).get("days")

    # ------------------------------------------------------------------ store
    def _store(self, node: str, section: dict[str, Any], today: int) -> None:
        rows: list[tuple[str, str, dict[str, Any]]] = []
        for device in (section.get("devices") or [])[:MAX_SUBJECTS]:
            if not isinstance(device, dict) or device.get("virtual"):
                continue
            if not (device.get("smart") or {}).get("read"):
                continue        # a standby or unreadable disk writes nothing
            counters = {k: v for k, v in (device.get("counters") or {}).items()
                        if k in DISK_KEYS and isinstance(v, (int, float))}
            if counters:
                rows.append(("disk", str(device.get("subject")), counters))
        for controller in ((section.get("memory") or {}).get("controllers")
                           or [])[:MAX_SUBJECTS]:
            if not isinstance(controller, dict):
                continue
            counters = {k: controller.get(k) for k in ("ce_count", "ue_count")
                        if isinstance(controller.get(k), int)}
            for dimm in controller.get("dimms") or []:
                if isinstance(dimm, dict) and isinstance(dimm.get("ce_count"), int):
                    counters[f"{dimm.get('name')}:ce"] = dimm["ce_count"]
            if counters:
                rows.append(("memory", str(controller.get("name")), counters))
        for device in (section.get("pci") or [])[:MAX_SUBJECTS]:
            if not isinstance(device, dict):
                continue
            counters = {k: device.get(k) for k in ("correctable", "nonfatal", "fatal")
                        if isinstance(device.get(k), int)}
            if any(counters.values()):
                rows.append(("pci", str(device.get("bdf")), counters))
        for supply in (section.get("power") or [])[:MAX_SUBJECTS]:
            if not isinstance(supply, dict):
                continue
            counters = {k: supply.get(k) for k in ("health_pct", "cycle_count")
                        if isinstance(supply.get(k), (int, float))}
            if counters:
                rows.append(("power", str(supply.get("name")), counters))
        for nic in (section.get("nics") or [])[:MAX_SUBJECTS]:
            if isinstance(nic, dict) and isinstance(nic.get("speed_mbps"), int):
                rows.append(("nic", str(nic.get("name")),
                             {"speed_mbps": nic["speed_mbps"]}))

        if len(self._written) > MAX_MEMO:
            self._written.clear()
        fresh = []
        for kind, subject, counters in rows[:MAX_SUBJECTS]:
            key = (node, kind, subject)
            if self._written.get(key) == (today, counters):
                continue        # the same numbers on the same day: nothing to say
            self._written[key] = (today, dict(counters))
            fresh.append((kind, subject, counters))
        if not fresh:
            return
        try:
            self.history.write_wear(node, today, fresh)
        except Exception:  # noqa: BLE001 -- a wear row must never break a report
            log.exception("could not write wear rows for %s", node)
        for kind, subject, _ in fresh:
            self._cache.pop((node, kind, subject), None)

    # ------------------------------------------------------------------- read
    _CACHE_TTL_S = 300.0

    def _rows(self, node: str, kind: str, subject: str) -> list[dict[str, Any]]:
        key = (node, kind, subject)
        cached = self._cache.get(key)
        now = time.monotonic()
        if cached and now - cached[0] < self._CACHE_TTL_S:
            return cached[1]
        try:
            rows = self.history.wear_rows(node, kind, subject)
        except Exception:  # noqa: BLE001
            log.exception("could not read wear rows for %s/%s", node, subject)
            rows = []
        if len(self._cache) > MAX_MEMO:
            self._cache.clear()
        self._cache[key] = (now, rows)
        return rows

    def rows(self, node: str, kind: str | None = None, subject: str | None = None,
             days: int = 400) -> dict[str, Any]:
        """What GET /api/wear serves: one subject's series, or the list of
        subjects when none is named."""
        if not kind or not subject:
            return {"node": node, "subjects": self.history.wear_subjects(node),
                    "ts": time.time()}
        since = time.time() - max(1, int(days)) * 86_400
        rows = self.history.wear_rows(node, kind, subject, since=since)
        return {"node": node, "kind": kind, "subject": subject,
                "rows": rows, "days": len(rows),
                "forecast": fit_forecast(rows, "percentage_used"),
                "ts": time.time()}

    def at_death(self, node: str, died_at: float,
                 days: int = 7) -> list[dict[str, Any]]:
        """The last daily row per disk and memory controller before a node
        died -- the Coroner's hardware context.

        A wearing disk is never a verdict on its own: a machine with a
        reallocating drive can still be unplugged by a cleaner. It is
        evidence for the classes that already claim hardware (hang_io, a
        machine check) and context for the ones that claim nothing.
        """
        out: list[dict[str, Any]] = []
        try:
            subjects = self.history.wear_subjects(node)
        except Exception:  # noqa: BLE001
            return out
        for entry in subjects:
            kind = str(entry.get("kind"))
            if kind not in ("disk", "memory"):
                continue
            subject = str(entry.get("subject"))
            rows = [r for r in self.history.wear_rows(
                node, kind, subject, since=died_at - max(1, days) * 86_400)
                if r["day"] <= died_at]
            if not rows:
                continue
            first, last = rows[0], rows[-1]
            moved = {key: (first["counters"].get(key), value)
                     for key, value in last["counters"].items()
                     if isinstance(value, (int, float))
                     and isinstance(first["counters"].get(key), (int, float))
                     and value > first["counters"][key]
                     and key not in ("power_on_hours", "temperature_c")}
            out.append({"kind": kind, "subject": subject, "day": last["day"],
                        "counters": last["counters"], "rose": moved,
                        "days": len(rows)})
        return out

    def forget(self, node: str) -> None:
        for key in [k for k in self._written if k[0] == node]:
            del self._written[key]
        for key in [k for k in self._cache if k[0] == node]:
            del self._cache[key]

    def prune(self, retention_days: int) -> None:
        try:
            self.history.prune_wear(retention_days)
        except Exception:  # noqa: BLE001
            log.exception("wear prune failed")


# ------------------------------------------------------------------ pure
def _span(rows: list[dict[str, Any]] | None) -> dict[str, Any]:
    if not rows:
        return {"days": 0, "first_seen": None, "last_seen": None}
    return {"days": len(rows), "first_seen": rows[0]["day"],
            "last_seen": rows[-1]["day"]}


def unchanged_since(rows: list[dict[str, Any]] | None, key: str,
                    value: Any) -> tuple[int | None, bool]:
    """(the day this counter last changed to its current value, whether that
    is simply the first day watched).

    The second half matters: "unchanged since 3 August" and "unchanged for as
    long as this host has been watching, which is since 3 August" are
    different claims, and only the record can tell them apart.
    """
    if not rows or value is None:
        return None, False
    run: int | None = None
    for row in reversed(rows):
        if row.get("counters", {}).get(key) != value:
            break
        run = int(row["day"])
    if run is None:
        return None, False
    return run, run == int(rows[0]["day"])


def first_rise(rows: list[dict[str, Any]] | None,
               item: dict[str, Any]) -> float | None:
    """When a counter named in an item's evidence last went up, from the daily
    record. Used only when the agent has no previous read of its own."""
    if not rows or len(rows) < 2:
        return None
    keys = {str(entry.get("id")) for entry in (item.get("stable") or [])
            if isinstance(entry, dict)}
    keys |= set(DISK_KEYS)
    latest = rows[-1].get("counters") or {}
    for previous, current in zip(reversed(rows[:-1]), reversed(rows[1:])):
        before, after = previous.get("counters") or {}, current.get("counters") or {}
        for key in keys:
            a, b = before.get(key), after.get(key)
            if isinstance(a, (int, float)) and isinstance(b, (int, float)) and b > a \
                    and latest.get(key) == b:
                return float(current["day"])
    return None


def fit_forecast(rows: list[dict[str, Any]] | None, key: str,
                 target: float = 100.0) -> dict[str, Any] | None:
    """A least-squares line through the last FIT_DAYS of one counter, and the
    date it reaches `target`.

    Returns None below MIN_POINTS -- rule 5: no date without a window. A flat
    or falling series returns the slope with `reaches_at: None` rather than a
    date, because "not rising" is an answer and an extrapolated date from
    noise is not.
    """
    if not rows:
        return None
    points = [(float(r["day"]), float(r["counters"][key]))
              for r in rows[-FIT_DAYS:]
              if isinstance(r.get("counters", {}).get(key), (int, float))]
    if len(points) < MIN_POINTS:
        return None
    n = len(points)
    base = points[0][0]
    xs = [(x - base) / 86_400.0 for x, _ in points]
    ys = [y for _, y in points]
    mean_x, mean_y = sum(xs) / n, sum(ys) / n
    denominator = sum((x - mean_x) ** 2 for x in xs)
    if denominator <= 0:
        return None
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denominator
    intercept = mean_y - slope * mean_x
    latest_x, latest_y = xs[-1], ys[-1]
    reaches_at = None
    if slope > 1e-9 and latest_y < target:
        days_to_target = (target - (intercept + slope * latest_x)) / slope
        if 0 < days_to_target < 3650:
            reaches_at = points[-1][0] + days_to_target * 86_400
    return {
        "key": key, "per_day": round(slope, 4), "unit": "%",
        "target": target, "reaches_at": reaches_at,
        "fitted_days": int(round(xs[-1] - xs[0])) + 1,
        "points": n, "latest": latest_y,
        "rising": slope > 1e-9,
    }
