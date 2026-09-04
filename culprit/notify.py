"""Notify on diagnoses, never on thresholds (host side).

Culprit is not an alerting tool and this does not make it one. There is no
"CPU > 90%" trigger and none can be configured: the only thing that can page
someone is a *finding* -- a diagnosis that has already survived the doctor's
sustain window and names its evidence and, when there is one, its culprit.
A finding marked expected is never sent.

Delivery is deliberately dull: ntfy (a topic URL), a generic JSON webhook, and
SMTP, all via the standard library, run on one worker thread so the ingest
path never blocks on a network call. One message per (node, finding) while it
holds, one more if it escalates from warn to critical, and one when it
resolves (after a grace period, so a flapping finding does not spam). A node
going quiet is notified too, because an agent that stops reporting at 2 a.m.
is the other thing worth knowing.
"""

from __future__ import annotations

import json
import logging
import queue
import smtplib
import ssl
import threading
import time
import urllib.error
import urllib.request
from email.message import EmailMessage
from typing import Any

from . import config as config_module

log = logging.getLogger("culprit.notify")

RESOLVE_GRACE_S = 120.0    # absent this long before "resolved" goes out
SILENT_DROP_S = 900.0      # a node silent this long: forget its findings quietly
OFFLINE_AFTER_S = 180.0    # a node unseen this long is reported offline
RATE_LIMIT = (20, 600.0)   # at most N messages per window (per host)
_ACTIVE = ("warn", "critical")
_RANK = {"warn": 1, "critical": 2}


def _channels(cfg: config_module.Config) -> list[str]:
    out = []
    if cfg.notify_ntfy_url.strip():
        out.append("ntfy")
    if cfg.notify_webhook_url.strip():
        out.append("webhook")
    if cfg.notify_smtp_host.strip() and cfg.notify_smtp_to.strip():
        out.append("smtp")
    return out


class Notifier:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # (node, key) -> state for findings currently held
        self._active: dict[tuple[str, str], dict[str, Any]] = {}
        self._node_seen: dict[str, float] = {}
        self._node_offline: set[str] = set()
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=200)
        self._sent_times: list[float] = []
        self.stats: dict[str, Any] = {"sent": 0, "failed": 0, "dropped": 0,
                                      "last_sent": None, "last_error": None,
                                      "last_title": None}
        self._worker = threading.Thread(target=self._run, name="culprit-notify",
                                        daemon=True)
        self._worker.start()

    # ------------------------------------------------------------ observing
    def observe(self, node: str, diagnosis: dict[str, Any], now: float) -> None:
        """Called with each diagnosis a node reports."""
        cfg = config_module.get()
        with self._lock:
            self._node_seen[node] = now
            if node in self._node_offline:
                self._node_offline.discard(node)
                back = True
            else:
                back = False
        if back and cfg.notify_offline and _channels(cfg):
            self._enqueue(_message("online", node, {"title": "Agent is reporting again"},
                                   cfg))
        raw = diagnosis.get("findings") if isinstance(diagnosis, dict) else None
        findings = [f for f in (raw if isinstance(raw, list) else [])
                    if isinstance(f, dict) and f.get("severity") in _ACTIVE
                    and not f.get("expected")]
        seen: set[tuple[str, str]] = set()
        min_rank = _RANK.get(cfg.notify_min_severity, 1)
        channels = _channels(cfg)
        for finding in findings:
            key = (node, str(finding.get("key")))
            seen.add(key)
            sev = str(finding.get("severity"))
            event = None
            with self._lock:
                state = self._active.get(key)
                if state is None:
                    state = {"first": now, "last": now, "severity": sev,
                             "sent": False, "finding": finding, "absent_since": None}
                    self._active[key] = state
                state["last"] = now
                state["absent_since"] = None
                state["finding"] = finding
                escalate = _RANK.get(sev, 0) > _RANK.get(state["severity"], 0)
                if escalate:
                    state["severity"] = sev
                # Only a finding at or above the configured floor is sent,
                # once while it holds and once more if it gets worse -- and
                # "sent" is only recorded when a channel actually exists, so
                # configuring one later still reports what is active then.
                if channels and _RANK.get(sev, 0) >= min_rank \
                        and (not state["sent"] or escalate):
                    event = "escalated" if state["sent"] else "finding"
                    state["sent"] = True
            if event:
                self._enqueue(_message(event, node, finding, cfg,
                                       held=now - state["first"]))
        # Findings that were active and are not in this diagnosis start their
        # resolve grace period; sweep() sends the resolution.
        with self._lock:
            for key, state in self._active.items():
                if key[0] == node and key not in seen and state["absent_since"] is None:
                    state["absent_since"] = now

    def sweep(self, now: float | None = None) -> None:
        now = now or time.time()
        cfg = config_module.get()
        channels = _channels(cfg)
        resolved: list[tuple[str, dict[str, Any]]] = []
        offline: list[str] = []
        with self._lock:
            for key, state in list(self._active.items()):
                node = key[0]
                absent = state.get("absent_since")
                silent = now - self._node_seen.get(node, now)
                if silent > SILENT_DROP_S:
                    self._active.pop(key, None)       # node vanished: no verdict
                    continue
                if absent is not None and now - absent >= RESOLVE_GRACE_S:
                    self._active.pop(key, None)
                    if state["sent"]:
                        resolved.append((node, state["finding"]))
            for node, seen in self._node_seen.items():
                if now - seen > OFFLINE_AFTER_S and node not in self._node_offline:
                    self._node_offline.add(node)
                    offline.append(node)
        if not channels:
            return
        if cfg.notify_resolved:
            for node, finding in resolved:
                self._enqueue(_message("resolved", node, finding, cfg))
        if cfg.notify_offline:
            for node in offline:
                self._enqueue(_message("offline", node, {
                    "title": "Agent stopped reporting",
                    "detail": f"No report from {node} for {OFFLINE_AFTER_S:.0f} s. "
                              "The machine may be down, or the agent may have "
                              "stopped -- either way, its numbers are stale.",
                }, cfg))

    def forget_node(self, node: str) -> None:
        with self._lock:
            for key in [k for k in self._active if k[0] == node]:
                self._active.pop(key, None)
            self._node_seen.pop(node, None)
            self._node_offline.discard(node)

    # -------------------------------------------------------------- testing
    def send_test(self) -> dict[str, Any]:
        """Deliver a test message on every configured channel, synchronously,
        and report per-channel success -- the Settings page's Send test."""
        cfg = config_module.get()
        channels = _channels(cfg)
        if not channels:
            return {"ok": False, "channels": {},
                    "error": "no channel configured: set an ntfy topic URL, a "
                             "webhook URL, or an SMTP server and recipient"}
        message = _message("test", "culprit", {
            "title": "Test notification",
            "detail": "If you can read this, Culprit can reach you here. Real "
                      "messages carry the node, the finding, its evidence and "
                      "the named culprit.",
            "severity": "info",
        }, cfg)
        results: dict[str, Any] = {}
        for channel in channels:
            try:
                _deliver(channel, message, cfg)
                results[channel] = {"ok": True}
            except Exception as exc:  # noqa: BLE001 -- reported, not raised
                results[channel] = {"ok": False, "error": str(exc)[:300]}
        return {"ok": all(r["ok"] for r in results.values()), "channels": results}

    def status(self) -> dict[str, Any]:
        cfg = config_module.get()
        with self._lock:
            active = len(self._active)
        return {**self.stats, "channels": _channels(cfg), "active_findings": active,
                "queue": self._queue.qsize()}

    # --------------------------------------------------------------- worker
    def _enqueue(self, message: dict[str, Any]) -> None:
        now = time.time()
        limit, window = RATE_LIMIT
        self._sent_times = [t for t in self._sent_times if now - t < window]
        if len(self._sent_times) >= limit:
            self.stats["dropped"] += 1
            log.warning("notification dropped (rate limit %d/%.0fs): %s",
                        limit, window, message.get("title"))
            return
        self._sent_times.append(now)
        try:
            self._queue.put_nowait(message)
        except queue.Full:
            self.stats["dropped"] += 1

    def _run(self) -> None:
        while True:
            message = self._queue.get()
            cfg = config_module.get()
            for channel in _channels(cfg):
                try:
                    _deliver(channel, message, cfg)
                    self.stats["sent"] += 1
                    self.stats["last_sent"] = time.time()
                    self.stats["last_title"] = message.get("title")
                    self.stats["last_error"] = None
                except Exception as exc:  # noqa: BLE001 -- keep the worker alive
                    self.stats["failed"] += 1
                    self.stats["last_error"] = f"{channel}: {str(exc)[:300]}"
                    log.warning("notification via %s failed: %s", channel, exc)


# ---------------------------------------------------------------- messages
def _message(event: str, node: str, finding: dict[str, Any],
             cfg: config_module.Config, held: float | None = None) -> dict[str, Any]:
    severity = str(finding.get("severity") or "info")
    title = str(finding.get("title") or "")
    raw_culprits = finding.get("culprits")
    culprits = [c for c in (raw_culprits if isinstance(raw_culprits, list) else [])
                if isinstance(c, dict)]
    lead = culprits[0] if culprits else None
    lines: list[str] = []
    if event == "resolved":
        heading = f"{node}: resolved -- {title}"
        lines.append("The finding has cleared.")
    elif event == "escalated":
        heading = f"{node}: now {severity.upper()} -- {title}"
    elif event in ("offline", "online", "test"):
        heading = f"{node}: {title}"
    else:
        heading = f"{node}: {title}"
    if finding.get("detail"):
        lines.append(str(finding["detail"]))
    if finding.get("external"):
        lines.append(f"Cause is outside the machine: {finding.get('blame')}.")
    elif lead:
        where = lead.get("container") or {}
        inside = f" in container {where['name']}" if where.get("name") else ""
        lines.append(f"Culprit: {lead.get('name')} (pid {lead.get('pid')}){inside}, "
                     f"{lead.get('share') or ''}".rstrip(", "))
        for other in culprits[1:3]:
            lines.append(f"  then {other.get('name')} ({other.get('share') or ''})")
    if held is not None and event == "finding":
        lines.append(f"Held for {held:.0f} s before this was sent.")
    evidence = finding.get("evidence") or {}
    if isinstance(evidence, dict) and evidence:
        bits = [f"{k.replace('_', ' ')}={v}" for k, v in evidence.items()
                if v is not None and not isinstance(v, (list, dict))]
        if bits:
            lines.append("Evidence: " + ", ".join(bits[:6]))
    return {
        "event": event, "node": node, "severity": severity, "title": heading,
        "body": "\n".join(lines) or heading, "ts": time.time(),
        "finding": {k: finding.get(k) for k in ("key", "title", "detail", "resource",
                                                 "severity", "evidence", "culprits",
                                                 "external", "blame")},
    }


def _deliver(channel: str, message: dict[str, Any], cfg: config_module.Config) -> None:
    if channel == "ntfy":
        _send_ntfy(cfg.notify_ntfy_url.strip(), message)
    elif channel == "webhook":
        _send_webhook(cfg.notify_webhook_url.strip(), message)
    elif channel == "smtp":
        _send_smtp(cfg, message)


def _send_ntfy(url: str, message: dict[str, Any]) -> None:
    priority = {"critical": "5", "warn": "4"}.get(message["severity"], "3")
    if message["event"] in ("resolved", "online"):
        priority = "2"
    tags = {"critical": "rotating_light", "warn": "warning"}.get(message["severity"], "")
    if message["event"] == "resolved":
        tags = "white_check_mark"
    elif message["event"] == "offline":
        tags = "electric_plug"
    headers = {
        "Title": message["title"].encode("ascii", "replace").decode(),
        "Priority": priority,
        "Content-Type": "text/plain; charset=utf-8",
    }
    if tags:
        headers["Tags"] = tags
    request = urllib.request.Request(url, data=message["body"].encode("utf-8"),
                                     method="POST", headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read(1024)


def _send_webhook(url: str, message: dict[str, Any]) -> None:
    payload = {**message, "text": f"{message['title']}\n{message['body']}"}
    request = urllib.request.Request(
        url, data=json.dumps(payload, default=str).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "culprit"})
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read(1024)


def _send_smtp(cfg: config_module.Config, message: dict[str, Any]) -> None:
    mail = EmailMessage()
    mail["Subject"] = f"[culprit] {message['title']}"
    mail["From"] = cfg.notify_smtp_from.strip() or cfg.notify_smtp_user.strip() \
        or "culprit@localhost"
    mail["To"] = cfg.notify_smtp_to.strip()
    mail.set_content(message["body"])
    port = int(cfg.notify_smtp_port or 587)
    host = cfg.notify_smtp_host.strip()
    if port == 465:
        server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=15,
                                                 context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(host, port, timeout=15)
    try:
        server.ehlo()
        if cfg.notify_smtp_tls and port != 465:
            server.starttls(context=ssl.create_default_context())
            server.ehlo()
        if cfg.notify_smtp_user.strip():
            server.login(cfg.notify_smtp_user.strip(), cfg.notify_smtp_password)
        server.send_message(mail)
    finally:
        try:
            server.quit()
        except (smtplib.SMTPException, OSError):
            pass
