"""Did it work? The verdict after an action (host side).

End task, renice and throttle are the tool's verbs, and until now they were
fire-and-forget: the dashboard said "postgres ended" and the person was left
watching gauges to work out whether that was the culprit. This closes the
loop with the evidence the doctor already samples.

When an action is taken against a node, the host keeps the node's diagnosis
at that moment as the *baseline* -- the pressures per resource and the active
findings that named the target process -- then watches the node's next
diagnoses. After a fixed window it states what happened in plain terms:

* **helped**: the findings that named the process cleared, or the pressure
  on the resource they were about fell by at least half.
* **partial**: pressure fell, but not by half, and a finding is still active.
* **no change**: nothing moved. The process was not the culprit, and the
  next candidate is named from the still-active finding.
* **moot**: nothing was under pressure when the action was taken, so there
  is nothing to verify against.
* **unknown**: the node stopped reporting before the window closed.

The verdict is persisted next to the action so an incident timeline can
show "End task postgres 14:20 -> helped" later.

Unit actions (the Outage Doctor's restart / start / reload-or-restart /
reset-failed) get their own watch, `_OutageWatch`, judged against the node's
*outage* items rather than its diagnosis: **fixed** when every item that
named the unit cleared and stayed clear, **recurred** when one cleared and
came back within the window (the unit starts and fails again), **partial**,
**no change** (with the root named when it is another unit), and the same
moot / unknown. Truncating a deleted-but-open file rides the ordinary watch
with its own no-change wording.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any

from .db import History

log = logging.getLogger("culprit.verdict")

WINDOW_SAMPLES = 20        # diagnoses to watch (~40 s at the 2 s proc tick)
MIN_SECONDS = 30.0         # and never less wall time: PSI avg10 needs it to decay
MAX_SECONDS = 120.0        # give up waiting for samples after this
KEEP_SECONDS = 900.0       # finished verdicts stay readable this long
_RESOURCES = ("cpu", "memory", "disk", "gpu")
_ACTIVE = ("warn", "critical")
_LABELS = {"cpu": "CPU", "memory": "memory", "disk": "IO", "gpu": "GPU"}


class _Watch:
    def __init__(self, action_id: int, node: str, action: str, pid: int | None,
                 name: str | None, baseline: dict[str, Any], result: dict[str, Any]) -> None:
        self.id = action_id
        self.node = node
        self.action = action
        self.pid = pid
        self.name = name
        self.result = result
        self.started = time.time()
        self.samples: list[tuple[float, dict[str, Any]]] = []
        self.done = False
        self.verdict: dict[str, Any] | None = None
        self.finished_at: float | None = None

        self.base_pressure = _pressures(baseline)
        self.targets: list[dict[str, Any]] = []
        for finding in _findings(baseline):
            if finding.get("expected"):
                continue
            if finding.get("severity") not in _ACTIVE:
                continue
            culprits = [c for c in (finding.get("culprits") or []) if isinstance(c, dict)]
            named = any(c.get("pid") == pid for c in culprits) if pid is not None else False
            self.targets.append({
                "key": finding.get("key"), "title": finding.get("title"),
                "resource": finding.get("resource"), "named": named,
                "culprits": culprits,
            })
        # The findings that named the target matter most; if none did, every
        # active finding is watched (the person may know something we do not).
        if any(t["named"] for t in self.targets):
            self.targets = [t for t in self.targets if t["named"]]
        self.resources = sorted({str(t["resource"]) for t in self.targets
                                 if t["resource"] in _RESOURCES})
        self.min_pressure = dict(self.base_pressure)
        self.cleared_at: dict[str, float] = {}

    # ----------------------------------------------------------- observing
    def observe(self, diagnosis: dict[str, Any], now: float) -> None:
        self.samples.append((now, diagnosis))
        pressures = _pressures(diagnosis)
        for key in self.resources:
            if key in pressures:
                self.min_pressure[key] = min(self.min_pressure.get(key, pressures[key]),
                                             pressures[key])
        active = {str(f.get("key")) for f in _findings(diagnosis)
                  if f.get("severity") in _ACTIVE and not f.get("expected")}
        for target in self.targets:
            key = str(target["key"])
            if key not in active:
                self.cleared_at.setdefault(key, now)
            else:
                self.cleared_at.pop(key, None)   # came back: not cleared after all
        if len(self.samples) >= WINDOW_SAMPLES and now - self.started >= MIN_SECONDS:
            self.finish(now)

    def progress(self) -> dict[str, Any]:
        latest = self.samples[-1][1] if self.samples else {}
        pressures = _pressures(latest)
        return {
            "samples": len(self.samples), "of": WINDOW_SAMPLES,
            "elapsed": round(time.time() - self.started, 1),
            "pressures": {key: {"before": round(self.base_pressure.get(key, 0.0), 3),
                                "now": (round(pressures[key], 3)
                                        if key in pressures else None)}
                          for key in self.resources},
            "cleared": sorted(self.cleared_at),
            "watching": [t["title"] for t in self.targets],
        }

    # -------------------------------------------------------------- verdict
    def finish(self, now: float, reason: str | None = None) -> None:
        if self.done:
            return
        self.done = True
        self.finished_at = now
        self.verdict = self._judge(now, reason)

    def _judge(self, now: float, reason: str | None) -> dict[str, Any]:
        elapsed = round(now - self.started)
        latest = self.samples[-1][1] if self.samples else {}
        exited_note = None
        if self.action == "terminate" and self.result.get("exited") is False:
            exited_note = (f"{self.name or 'the process'} had not exited when "
                           "SIGTERM was sent; it may still be running.")
        if not self.targets:
            return {"outcome": "moot", "elapsed": elapsed,
                    "text": "Nothing was under sustained pressure when you acted, "
                            "so there is nothing to verify the action against.",
                    "note": exited_note}
        if not self.samples:
            return {"outcome": "unknown", "elapsed": elapsed,
                    "text": reason or f"{self.node} sent no diagnosis in "
                                      f"{elapsed} s; the outcome is unknown.",
                    "note": exited_note}

        latest_pressure = _pressures(latest)
        drops: list[str] = []
        biggest_drop = 0.0
        for key in self.resources:
            before = self.base_pressure.get(key)
            after = latest_pressure.get(key)
            if before is None or after is None:
                continue
            drop = (before - after) / before if before > 0 else 0.0
            biggest_drop = max(biggest_drop, drop)
            drops.append(f"{_LABELS[key]} pressure {before * 100:.0f}% -> {after * 100:.0f}%")

        cleared = [t for t in self.targets if str(t["key"]) in self.cleared_at]
        still = [t for t in self.targets if str(t["key"]) not in self.cleared_at]
        clear_times = [self.cleared_at[str(t["key"])] - self.started for t in cleared]

        cleared_text = _list_titles(cleared)
        if cleared and not still:
            when = f" in {max(clear_times):.0f} s" if clear_times else ""
            text = (f"It worked: {cleared_text} cleared{when}"
                    + (f"; {'; '.join(drops)}" if drops else "") + ".")
            return {"outcome": "helped", "elapsed": elapsed, "text": text,
                    "cleared": [t["title"] for t in cleared], "note": exited_note}
        if biggest_drop >= 0.5 and not still:
            text = f"It helped: {'; '.join(drops)}."
            return {"outcome": "helped", "elapsed": elapsed, "text": text,
                    "cleared": [t["title"] for t in cleared], "note": exited_note}
        if cleared or biggest_drop >= 0.2:
            # Some of what was wrong cleared, or pressure fell noticeably, but
            # a finding is still active: name it, and who now leads it.
            nxt = _next_candidate(latest, still, self.pid)
            parts = []
            if cleared:
                parts.append(f"{cleared_text} cleared")
            if drops:
                parts.append("; ".join(drops))
            text = (f"Partly: {'; '.join(parts)}, but '{still[0]['title']}' is "
                    "still active"
                    + (f" -- {nxt['name']} ({nxt['share']}) now leads it." if nxt
                       else ". Its pressure figure is a 10-second average, so "
                            "it may still be decaying."))
            return {"outcome": "partial", "elapsed": elapsed, "text": text,
                    "cleared": [t["title"] for t in cleared], "next": nxt,
                    "note": exited_note}
        nxt = _next_candidate(latest, still, self.pid)
        if self.action == "truncate":
            # Freeing space is not a process verdict: the question is whether
            # the storage finding cleared, and if not, why it could not have.
            freed = self.result.get("freed_bytes")
            text = (f"No change after {elapsed} s: '{still[0]['title']}' is still active"
                    + (f" although {_human_bytes(freed)} was freed" if isinstance(freed, (int, float)) else "")
                    + ". Either that was not enough, or something is still writing there"
                    + (f" -- {nxt['name']} is the top writer now." if nxt else "."))
            return {"outcome": "no_change", "elapsed": elapsed, "text": text,
                    "next": nxt, "note": exited_note}
        text = (f"No change after {elapsed} s"
                + (f" ({'; '.join(drops)})" if drops else "")
                + f": {self.name or 'that process'} was not the culprit of "
                  f"'{still[0]['title']}'."
                + (f" The next candidate is {nxt['name']} ({nxt['share']})."
                   if nxt else " No other process stands out for it."))
        return {"outcome": "no_change", "elapsed": elapsed, "text": text,
                "next": nxt, "note": exited_note}


def _list_titles(targets: list[dict[str, Any]]) -> str:
    titles = [f"'{t['title']}'" for t in targets]
    if len(titles) <= 2:
        return " and ".join(titles)
    return f"{titles[0]} and {len(titles) - 1} more"


def _pressures(diagnosis: Any) -> dict[str, float]:
    """Finite 0..1 pressures per resource, whatever shape an agent sent."""
    if not isinstance(diagnosis, dict) or not isinstance(diagnosis.get("pressures"), dict):
        return {}
    out: dict[str, float] = {}
    for key, value in diagnosis["pressures"].items():
        if key in _RESOURCES and isinstance(value, (int, float)) \
                and not isinstance(value, bool) and math.isfinite(value):
            out[key] = float(value)
    return out


def _findings(diagnosis: Any) -> list[dict[str, Any]]:
    """The dict findings of a diagnosis, whatever shape an agent sent."""
    if not isinstance(diagnosis, dict):
        return []
    findings = diagnosis.get("findings")
    if not isinstance(findings, list):
        return []
    return [f for f in findings if isinstance(f, dict)]


def _next_candidate(latest: dict[str, Any], still: list[dict[str, Any]],
                    pid: int | None) -> dict[str, Any] | None:
    keys = {str(t["key"]) for t in still}
    for finding in _findings(latest):
        if str(finding.get("key")) not in keys:
            continue
        for culprit in finding.get("culprits") or []:
            if isinstance(culprit, dict) and culprit.get("pid") != pid:
                return {"pid": culprit.get("pid"), "name": culprit.get("name"),
                        "share": culprit.get("share"),
                        "container": culprit.get("container")}
    return None


def _human_bytes(value: Any) -> str:
    number = float(value or 0)
    if number >= 1024 ** 3:
        return f"{number / 1024 ** 3:.1f} GB"
    if number >= 1024 ** 2:
        return f"{number / 1024 ** 2:.0f} MB"
    return f"{number / 1024:.0f} KB"


# ------------------------------------------------------------ unit actions
# The Outage Doctor's verbs (restart / start / reload-or-restart /
# reset-failed on a unit) are judged against the *outage* section, not the
# diagnosis: the question is whether the items that named the unit went
# away and stayed away. Outage is a slow-tier section (one sample per ~20 s),
# so the window is counted in samples of it and given a longer floor.
OUTAGE_SAMPLES = 3         # outage frames to watch (~60 s at the 20 s slow tick)
OUTAGE_MIN_SECONDS = 60.0
OUTAGE_MAX_SECONDS = 240.0
_OUTAGE_WORD = {"restart": "Restart", "start": "Start",
                "reload-or-restart": "Reload or restart", "reset-failed": "Reset failed state"}


class _OutageWatch:
    """Same shape as _Watch (id, node, action, pid, name, started, done,
    verdict, finished_at, progress(), finish(), observe()) so ActionVerifier
    keeps one table; fed outage frames instead of diagnoses."""

    def __init__(self, action_id: int, node: str, verb: str, unit: str,
                 baseline: dict[str, Any], result: dict[str, Any]) -> None:
        self.id = action_id
        self.node = node
        self.action = f"unit_{verb}"
        self.verb = verb
        self.pid = None
        self.name = unit
        self.unit = unit
        self.result = result
        self.started = time.time()
        self.samples: list[tuple[float, dict[str, Any]]] = []
        self.done = False
        self.verdict: dict[str, Any] | None = None
        self.finished_at: float | None = None
        self.targets: list[dict[str, Any]] = [
            {"key": item.get("key"), "title": item.get("title"), "kind": item.get("kind")}
            for item in _items(baseline)
            if item.get("severity") in _ACTIVE and _names_unit(item, unit)
        ]
        self.cleared_at: dict[str, float] = {}
        self.recurred: set[str] = set()

    def observe(self, outage: dict[str, Any], now: float) -> None:
        self.samples.append((now, outage))
        active = {str(i.get("key")) for i in _items(outage) if i.get("severity") in _ACTIVE}
        for target in self.targets:
            key = str(target["key"])
            if key not in active:
                self.cleared_at.setdefault(key, now)
            elif key in self.cleared_at:
                # Gone in one sample, back in the next: the restart took and
                # the unit failed again -- the strongest "not the fix" there is.
                self.cleared_at.pop(key, None)
                self.recurred.add(key)
        if len(self.samples) >= OUTAGE_SAMPLES and now - self.started >= OUTAGE_MIN_SECONDS:
            self.finish(now)

    def progress(self) -> dict[str, Any]:
        return {
            "samples": len(self.samples), "of": OUTAGE_SAMPLES,
            "elapsed": round(time.time() - self.started, 1),
            "pressures": {},
            "cleared": sorted(self.cleared_at),
            "watching": [t["title"] for t in self.targets],
        }

    def finish(self, now: float, reason: str | None = None) -> None:
        if self.done:
            return
        self.done = True
        self.finished_at = now
        self.verdict = self._judge(now, reason)

    def _judge(self, now: float, reason: str | None) -> dict[str, Any]:
        elapsed = round(now - self.started)
        word = _OUTAGE_WORD.get(self.verb, self.verb)
        after = self.result.get("after") if isinstance(self.result.get("after"), dict) else {}
        state_note = None
        if after.get("active") and after.get("active") != "active":
            state_note = (f"Right after the {word.lower()}, systemd reported {self.unit} "
                          f"{after.get('active')} ({after.get('sub')}).")
        if not self.targets:
            return {"outcome": "moot", "elapsed": elapsed,
                    "text": (f"No outage item named {self.unit} when you acted, so there "
                             "is nothing to verify the action against."),
                    "note": state_note}
        if not self.samples:
            return {"outcome": "unknown", "elapsed": elapsed,
                    "text": reason or f"{self.node} sent no outage sample in {elapsed} s; "
                                      "the outcome is unknown.",
                    "note": state_note}
        cleared = [t for t in self.targets if str(t["key"]) in self.cleared_at]
        still = [t for t in self.targets if str(t["key"]) not in self.cleared_at]
        recurred = [t for t in self.targets if str(t["key"]) in self.recurred]
        if recurred:
            return {"outcome": "recurred", "elapsed": elapsed,
                    "text": (f"It came back: {_list_titles(recurred)} cleared after the "
                             f"{word.lower()} and returned within {elapsed} s. The unit "
                             "starts and fails again, so the cause is upstream of it -- "
                             "its journal has the reason."),
                    "cleared": [t["title"] for t in cleared], "note": state_note}
        if cleared and not still:
            when = max(self.cleared_at[str(t["key"])] - self.started for t in cleared)
            return {"outcome": "fixed", "elapsed": elapsed,
                    "text": (f"Fixed: {_list_titles(cleared)} cleared in {when:.0f} s and "
                             f"stayed clear for the rest of the {elapsed} s watch."),
                    "cleared": [t["title"] for t in cleared], "note": state_note}
        if cleared:
            return {"outcome": "partial", "elapsed": elapsed,
                    "text": (f"Partly: {_list_titles(cleared)} cleared, but "
                             f"'{still[0]['title']}' is still there after {elapsed} s."),
                    "cleared": [t["title"] for t in cleared], "note": state_note}
        return {"outcome": "no_change", "elapsed": elapsed,
                "text": (f"No change after {elapsed} s: '{still[0]['title']}' is still "
                         f"active. The {word.lower()} did not fix it"
                         + (f" -- the root is {self._root_of(still[0])}, not {self.unit}."
                            if self._root_of(still[0]) not in (None, self.unit) else ".")),
                "note": state_note}

    def _root_of(self, target: dict[str, Any]) -> str | None:
        latest = self.samples[-1][1] if self.samples else {}
        for item in _items(latest):
            if item.get("key") == target["key"]:
                root = item.get("root") if isinstance(item.get("root"), dict) else {}
                return root.get("unit")
        return None


def _items(outage: Any) -> list[dict[str, Any]]:
    if not isinstance(outage, dict) or not isinstance(outage.get("items"), list):
        return []
    return [i for i in outage["items"] if isinstance(i, dict)]


def _names_unit(item: dict[str, Any], unit: str) -> bool:
    if item.get("unit") == unit:
        return True
    root = item.get("root") if isinstance(item.get("root"), dict) else {}
    return root.get("unit") == unit


class ActionVerifier:
    def __init__(self, history: History) -> None:
        self.history = history
        self._lock = threading.Lock()
        self._watches: dict[int, _Watch] = {}

    def start(self, node: str, action: str, pid: int | None, name: str | None,
              unit: str | None, result: dict[str, Any], baseline: dict[str, Any],
              username: str | None) -> int:
        action_id = self.history.record_action(node, action, pid, name, unit,
                                               result, username)
        if not action_id:
            action_id = -int(time.time() * 1000) % 2_000_000_000
        watch = _Watch(action_id, node, action, pid, name, baseline, result)
        if not watch.targets:
            watch.finish(time.time())
            self._persist(watch)
        with self._lock:
            self._watches[action_id] = watch
        return action_id

    def start_outage(self, node: str, verb: str, unit: str, result: dict[str, Any],
                     baseline_outage: dict[str, Any], username: str | None) -> int:
        """A unit action: judged against the node's outage items, not its
        diagnosis. Recorded in the same actions table (action `unit_<verb>`,
        `unit` set, no pid) so the track record covers it too."""
        action_id = self.history.record_action(node, f"unit_{verb}", None, None, unit,
                                               result, username)
        if not action_id:
            action_id = -int(time.time() * 1000) % 2_000_000_000
        watch = _OutageWatch(action_id, node, verb, unit, baseline_outage, result)
        if not watch.targets:
            watch.finish(time.time())
            self._persist(watch)
        with self._lock:
            self._watches[action_id] = watch
        return action_id

    def observe(self, node: str, diagnosis: dict[str, Any], now: float) -> None:
        with self._lock:
            watches = [w for w in self._watches.values()
                       if w.node == node and not w.done and isinstance(w, _Watch)]
        for watch in watches:
            watch.observe(diagnosis, now)
            if watch.done:
                self._persist(watch)

    def observe_outage(self, node: str, outage: dict[str, Any], now: float) -> None:
        with self._lock:
            watches = [w for w in self._watches.values()
                       if w.node == node and not w.done and isinstance(w, _OutageWatch)]
        for watch in watches:
            watch.observe(outage, now)
            if watch.done:
                self._persist(watch)

    def sweep(self, now: float | None = None) -> None:
        """Time out watches whose node went quiet; forget old verdicts."""
        now = now or time.time()
        with self._lock:
            watches = list(self._watches.values())
        for watch in watches:
            limit = OUTAGE_MAX_SECONDS if isinstance(watch, _OutageWatch) else MAX_SECONDS
            if not watch.done and now - watch.started > limit:
                watch.finish(now, reason=f"{watch.node} stopped reporting before "
                                         "the verdict window closed.")
                self._persist(watch)
            if watch.done and watch.finished_at and now - watch.finished_at > KEEP_SECONDS:
                with self._lock:
                    self._watches.pop(watch.id, None)

    def get(self, action_id: int) -> dict[str, Any] | None:
        with self._lock:
            watch = self._watches.get(action_id)
        if watch is None:
            return None
        return {
            "id": watch.id, "node": watch.node, "action": watch.action,
            "pid": watch.pid, "name": watch.name, "started": watch.started,
            "done": watch.done, "verdict": watch.verdict,
            "progress": watch.progress(),
        }

    def _persist(self, watch: _Watch) -> None:
        if watch.verdict and watch.id > 0:
            try:
                self.history.set_verdict(watch.id, watch.verdict)
            except Exception as exc:  # noqa: BLE001 -- a verdict is not worth a crash
                log.warning("could not store verdict for action %s: %s", watch.id, exc)
