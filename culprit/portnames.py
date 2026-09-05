"""Well-known port names, from ports.json at the repository root.

One file, read once, served to the browser as-is: the Ports view labels
each listener with it (443 · https) and the Map labels edges and peers
(db-01:5432 · postgresql). A name here is what usually listens on a number,
never a claim about what does -- the process behind a port is always read
from /proc; this only gives the number a word.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from .config import ROOT

log = logging.getLogger("culprit.portnames")

PATH = ROOT / "ports.json"
_cache: dict[str, Any] | None = None


def load() -> dict[str, Any]:
    """{"tcp": {port: {name, desc}}, "udp": {...}}; empty maps if the file
    is missing or damaged (the views then show numbers alone)."""
    global _cache
    if _cache is not None:
        return _cache
    try:
        raw = json.loads(PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("ports.json not readable (%s): ports show without names", exc)
        raw = {}
    tables: dict[str, Any] = {}
    for proto in ("tcp", "udp"):
        table = raw.get(proto) if isinstance(raw, dict) else None
        tables[proto] = {
            str(port): {"name": str(entry.get("name") or ""), "desc": str(entry.get("desc") or "")}
            for port, entry in (table.items() if isinstance(table, dict) else ())
            if isinstance(entry, dict) and str(port).isdigit()
        }
    _cache = tables
    return tables


def name(port: int, proto: str = "tcp") -> str | None:
    """The short name for a port, UDP falling back to the TCP table (most
    services register the same number for both)."""
    tables = load()
    entry = tables.get(proto, {}).get(str(port)) or tables["tcp"].get(str(port))
    return entry["name"] if entry else None
