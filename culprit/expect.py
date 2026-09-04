"""Expected-busy annotations (host side).

A nightly backup that pins the disk from 02:00 to 03:00 is not a problem, and
a doctor that shouts about it every night trains the operator to ignore the
doctor. So a person can mark a finding as *expected*: this finding key, on
this node (or every node), led by this culprit (or any), during this daily
window (or always), with a reason in their own words.

Two rules keep this honest:

* Nothing is inferred. There is no baseline learning, no "this box is usually
  busy at 02:00"; an expectation exists only because someone wrote it down.
* An expected finding is still shown, with its real evidence. It is reported
  as *expected* (severity downgraded to info, the reason attached) rather
  than hidden -- and when the window ends and the finding is still active,
  it comes back as a real one with a note saying by how much it overran.
  Only real (warn/critical) findings are written to history, so an expected
  one does not become an incident in Trends.

Windows are in the host's local time: an operator reads one clock, and the
agents' clocks are the ones most likely to be wrong.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any

from .collectors.lag import SEVERITY_ORDER, _headline, _overall
from .db import History

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
OVERRUN_WINDOW_MIN = 30      # how long after a window ends "overran" is reported
MAX_REASON = 200
MAX_KEY = 64
MAX_CULPRIT = 128


def _minutes(value: str) -> int:
    match = _TIME_RE.match(value)
    assert match
    return int(match.group(1)) * 60 + int(match.group(2))


def validate(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    """(clean, field errors). Every field is checked; errors are keyed by
    field so the dialog can show them inline."""
    errors: dict[str, str] = {}
    clean: dict[str, Any] = {}

    node = payload.get("node", "*")
    node = str(node).strip() if node is not None else "*"
    if not node:
        node = "*"
    if len(node) > 48 or (node != "*" and not all(c.isalnum() or c in "-_"
                                                   for c in node)):
        errors["node"] = "use an agent name or * for every node"
    clean["node"] = node

    # Finding keys are identifiers (psi_io, cpu_steal) or, for volumes, an
    # identifier plus a mount point (space_/home). Anything that looks like a
    # path trick is refused: it could never match a real key anyway.
    key = str(payload.get("key") or "").strip()
    if not key or len(key) > MAX_KEY or not key[0].isalpha() or ".." in key \
            or not all(c.isalnum() or c in "-_/." for c in key):
        errors["key"] = "a finding key is required (a name such as psi_io or space_/home)"
    clean["key"] = key

    culprit = payload.get("culprit")
    if culprit is not None:
        culprit = str(culprit).strip() or None
        if culprit is not None and len(culprit) > MAX_CULPRIT:
            errors["culprit"] = f"at most {MAX_CULPRIT} characters"
    clean["culprit"] = culprit

    reason = str(payload.get("reason") or "").strip()
    if not reason:
        errors["reason"] = "say why this is expected -- the reason is shown next to the finding"
    elif len(reason) > MAX_REASON:
        errors["reason"] = f"at most {MAX_REASON} characters"
    clean["reason"] = reason

    days_raw = payload.get("days") or []
    days: list[int] = []
    if not isinstance(days_raw, list):
        errors["days"] = "a list of weekdays (0 = Monday .. 6 = Sunday)"
    else:
        for day in days_raw:
            if isinstance(day, bool) or not isinstance(day, int) or not 0 <= day <= 6:
                errors["days"] = "weekdays are 0 (Monday) to 6 (Sunday)"
                break
            if day not in days:
                days.append(day)
    clean["days"] = sorted(days)

    start = payload.get("start")
    end = payload.get("end")
    start = str(start).strip() if start else None
    end = str(end).strip() if end else None
    if (start is None) != (end is None):
        errors["start"] = "give both a start and an end time, or neither"
    for field, value in (("start", start), ("end", end)):
        if value is not None and not _TIME_RE.match(value):
            errors[field] = "use HH:MM (24-hour)"
    if start and end and not errors.get("start") and not errors.get("end") \
            and _minutes(start) == _minutes(end):
        errors["end"] = "the window must not be empty"
    clean["start"], clean["end"] = start, end
    if days and start is None:
        # Days without a window: interpret as "all day on those days".
        clean["start"], clean["end"] = "00:00", "23:59"
    return clean, errors


class Expectations:
    """The saved expectations, matched against live findings at ingest."""

    def __init__(self, history: History) -> None:
        self.history = history
        self._lock = threading.Lock()
        self._rows: list[dict[str, Any]] = []
        self.reload()

    def reload(self) -> None:
        rows = self.history.list_expectations()
        with self._lock:
            self._rows = rows

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._rows]

    # -------------------------------------------------------------- matching
    def match(self, node: str, finding: dict[str, Any],
              now: float) -> tuple[dict[str, Any] | None, str | None]:
        """(expectation, state): state is 'active' inside the window,
        'overrun' shortly after it, or None when nothing applies."""
        key = str(finding.get("key") or "")
        raw = finding.get("culprits")
        names = {str(c.get("name") or "").rsplit("/", 1)[-1]
                 for c in (raw if isinstance(raw, list) else []) if isinstance(c, dict)}
        with self._lock:
            rows = list(self._rows)
        best: tuple[dict[str, Any], str] | None = None
        for row in rows:
            if row["key"] != key:
                continue
            if row["node"] not in ("*", node):
                continue
            if row.get("culprit") and row["culprit"] not in names:
                continue
            state = _window_state(row, now)
            if state == "active":
                return row, "active"
            if state == "overrun" and best is None:
                best = (row, "overrun")
        return best if best else (None, None)

    def annotate(self, node: str, diagnosis: dict[str, Any],
                 now: float | None = None) -> dict[str, Any]:
        """Mark expected findings in place and recompute the verdict.

        The agent's own verdict counted every finding; the host's counts only
        the unexpected ones, so a machine doing its scheduled backup reads as
        "running normally", not "struggling".
        """
        now = now or time.time()
        findings = diagnosis.get("findings")
        if not isinstance(findings, list):
            return diagnosis
        expected = 0
        for finding in findings:
            if not isinstance(finding, dict):
                continue
            finding.pop("expected", None)
            finding.pop("expected_overrun", None)
            if "severity_raw" in finding:
                finding["severity"] = finding.pop("severity_raw")
            row, state = self.match(node, finding, now)
            if row is None:
                continue
            summary = {"id": row["id"], "reason": row["reason"],
                       "window": _window_text(row), "culprit": row.get("culprit")}
            if state == "active":
                finding["expected"] = summary
                finding["severity_raw"] = finding.get("severity")
                finding["severity"] = "info"
                expected += 1
            else:
                minutes = _minutes_past_end(row, now)
                finding["expected_overrun"] = {**summary, "minutes": minutes}
        findings.sort(key=lambda f: (
            -SEVERITY_ORDER.index(str(f.get("severity")))
            if str(f.get("severity")) in SEVERITY_ORDER else 0,
            -float(f.get("sustained_ticks") or 0),
        ))
        real = [f for f in findings if isinstance(f, dict) and not f.get("expected")]
        worst = max((str(f.get("severity")) for f in real),
                    key=lambda s: SEVERITY_ORDER.index(s) if s in SEVERITY_ORDER else 0,
                    default="ok")
        diagnosis["severity"] = worst
        diagnosis["status"] = _overall(worst)
        diagnosis["expected_count"] = expected
        if real:
            diagnosis["headline"] = _headline(worst, real)
        elif expected:
            lead = findings[0]
            diagnosis["headline"] = (f"Only expected activity: {lead['expected']['reason']} "
                                     f"({lead.get('title')}).")
        else:
            diagnosis["headline"] = _headline(worst, [])
        return diagnosis


# ------------------------------------------------------------------ windows
def _local(now: float) -> tuple[int, int]:
    """(weekday Mon=0, minutes since midnight) in the host's local time."""
    struct = time.localtime(now)
    return struct.tm_wday, struct.tm_hour * 60 + struct.tm_min


def _window_state(row: dict[str, Any], now: float) -> str | None:
    days = row.get("days") or []
    start, end = row.get("start"), row.get("end")
    if not start or not end:
        return "active"           # no window: always expected
    try:
        s, e = _minutes(start), _minutes(end)
    except AssertionError:
        return None
    day, minute = _local(now)
    yesterday = (day - 1) % 7
    on = (lambda d: not days or d in days)
    if s < e:
        if on(day) and s <= minute < e:
            return "active"
        if on(day) and e <= minute < e + OVERRUN_WINDOW_MIN:
            return "overrun"
        return None
    # Wraps midnight: 23:00-01:00 started yesterday for an early-morning check.
    if (on(day) and minute >= s) or (on(yesterday) and minute < e):
        return "active"
    if on(yesterday) and e <= minute < e + OVERRUN_WINDOW_MIN:
        return "overrun"
    return None


def _minutes_past_end(row: dict[str, Any], now: float) -> int | None:
    end = row.get("end")
    if not end:
        return None
    try:
        e = _minutes(end)
    except AssertionError:
        return None
    _, minute = _local(now)
    return (minute - e) % (24 * 60)


def _window_text(row: dict[str, Any]) -> str:
    days = row.get("days") or []
    start, end = row.get("start"), row.get("end")
    if not start or not end:
        return "always"
    when = f"{start}-{end}"
    if not days:
        return f"daily {when}"
    if days == list(range(5)):
        return f"weekdays {when}"
    if days == [5, 6]:
        return f"weekends {when}"
    return ", ".join(DAY_NAMES[d] for d in days if 0 <= d <= 6) + f" {when}"
