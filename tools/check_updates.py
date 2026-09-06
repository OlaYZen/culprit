"""Offline check of agent self-update: version comparison, the fleet-wide
remote-version fetch, how a report's `update_capable`/`update_reason` folds
into `/api/nodes`, the atomic once-a-day claim, and the sweep loop's decision
to fire (or not fire) the scheduled update command.

    .venv/bin/python tools/check_updates.py

No server, no real GitHub fetch, no real git pull: `urllib.request.urlopen`
is replaced with a fixture for the remote-version check, and `_run_scheduled_
update` is replaced with a recorder for the scheduler check, so this pins the
decision logic -- whose version is newer, whether today's slot is still free,
whether the hour matches -- without ever touching a network or a git
checkout. `POST /api/nodes/{name}/update`'s own fast-fail guards (unknown
node, not yet capable) are `check_security.py --active`'s `check_update_guard`
instead, since they need a live server; the command actually being picked up
and run is `culprit-agent`'s own concern (its own checkout, its own git pull)
and is not covered by any tool in this repository.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import tempfile
import time
import urllib.error
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from culprit import nodes as nodes_mod  # noqa: E402
from culprit.db import History  # noqa: E402

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m"
failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = f"{GREEN}ok  {RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"{mark} {label}{f'  {DIM}{detail}{RESET}' if detail else ''}")
    if not ok:
        failures.append(label)


# ------------------------------------------------------------- version compare
def check_version_compare() -> None:
    print("\n--- version comparison " + "-" * 49)
    is_newer = nodes_mod._is_newer
    check("equal versions are not newer", is_newer("2.1.0", "2.1.0") is False)
    check("remote ahead is newer", is_newer("2.1.1", "2.1.0") is True)
    check("remote behind is not newer (node ahead of published, e.g. an "
          "unpushed local commit)", is_newer("2.0.9", "2.1.0") is False)
    check("a pre-release suffix is ignored, not compared",
          is_newer("2.1.0-beta", "2.1.0") is False)
    check("more version parts still compares", is_newer("2.1.0.1", "2.1.0.0") is True)
    check("an unparsable remote is unknown, not older or newer",
          is_newer("nightly", "2.1.0") is None)
    check("an unparsable local is unknown", is_newer("2.1.0", "unknown") is None)
    check("no local version at all is unknown", is_newer("2.1.0", None) is None)
    check("no remote version at all is unknown", is_newer(None, "2.1.0") is None)
    check("both missing is unknown", is_newer(None, None) is None)
    check("string comparison would get this wrong -- tuple comparison must not",
          is_newer("2.9.0", "2.10.0") is False)  # "2.9.0" > "2.10.0" as strings


# -------------------------------------------------------- remote version fetch
class _FakeResponse:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data

    def __enter__(self):  # type: ignore[no-untyped-def]
        return self

    def __exit__(self, *exc):  # type: ignore[no-untyped-def]
        return False


def check_remote_version_fetch() -> None:
    print("\n--- fleet-wide remote version fetch " + "-" * 35)
    registry = nodes_mod.NodeRegistry.__new__(nodes_mod.NodeRegistry)
    registry._remote_version = None
    registry._remote_version_checked = 0.0

    calls = {"n": 0}

    def fake_urlopen(url, timeout=5):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        return _FakeResponse(b'{"version": "3.2.1"}')

    real_urlopen = nodes_mod.urllib.request.urlopen
    nodes_mod.urllib.request.urlopen = fake_urlopen
    try:
        registry.refresh_remote_version()
        check("first call fetches", calls["n"] == 1)
        check("fetched value is stored", registry._remote_version == "3.2.1")

        registry.refresh_remote_version()
        check("a second call within the refresh window does not refetch",
              calls["n"] == 1)

        registry._remote_version_checked = 0.0  # pretend the window elapsed
        registry.refresh_remote_version()
        check("a call after the window elapsed refetches", calls["n"] == 2)

        def failing_urlopen(url, timeout=5):  # type: ignore[no-untyped-def]
            calls["n"] += 1
            raise urllib.error.URLError("no route to github")

        nodes_mod.urllib.request.urlopen = failing_urlopen
        registry._remote_version_checked = 0.0
        registry.refresh_remote_version()
        check("a fetch failure never raises", True)
        check("a fetch failure keeps the last known-good version "
              "(never flips every node's badge off on a blip)",
              registry._remote_version == "3.2.1")

        def malformed_urlopen(url, timeout=5):  # type: ignore[no-untyped-def]
            return _FakeResponse(b'{"not_version": "x"}')

        nodes_mod.urllib.request.urlopen = malformed_urlopen
        registry._remote_version_checked = 0.0
        registry.refresh_remote_version()
        check("a response with no 'version' key also keeps the last good value",
              registry._remote_version == "3.2.1")
    finally:
        nodes_mod.urllib.request.urlopen = real_urlopen


# ------------------------------------------------- ingest -> node meta fields
def check_ingest_update_fields(history: History) -> None:
    print("\n--- report -> /api/nodes fields " + "-" * 39)
    history.add_agent("update-test-node")
    registry = nodes_mod.NodeRegistry(history)
    registry._remote_version = "2.0.0"

    registry.ingest("update-test-node",
                    {"agent": {"version": "1.0.0", "update_capable": True}})
    meta = next(n for n in registry.status_list() if n["name"] == "update-test-node")
    check("capable + older than remote -> update available",
          meta["update_capable"] is True and meta["update_available"] is True)

    registry.ingest("update-test-node",
                    {"agent": {"version": "2.0.0", "update_capable": True}})
    meta = next(n for n in registry.status_list() if n["name"] == "update-test-node")
    check("at the same version as remote -> not available",
          meta["update_available"] is False)

    registry.ingest("update-test-node",
                    {"agent": {"version": "2.0.0", "update_capable": False,
                               "update_reason": "running under Docker"}})
    meta = next(n for n in registry.status_list() if n["name"] == "update-test-node")
    check("agent-reported incapable is honoured, with its reason",
          meta["update_capable"] is False and meta["update_reason"] == "running under Docker")

    # A report that omits update_capable (most of an agent's reports, since
    # it is only worth resending when it changes) must not erase what the
    # last report established.
    registry.ingest("update-test-node", {"agent": {"version": "2.0.0"}})
    meta = next(n for n in registry.status_list() if n["name"] == "update-test-node")
    check("omitting update_capable on a later report keeps the prior value",
          meta["update_capable"] is False)

    # A malformed (non-bool) update_capable must sanitise to unknown, never
    # to a false claim of true or false.
    registry.ingest("update-test-node", {"agent": {"update_capable": "yes"}})
    meta = next(n for n in registry.status_list() if n["name"] == "update-test-node")
    check("a non-bool update_capable sanitises to 'no change', not a false claim",
          meta["update_capable"] is False)  # unchanged from the last real report

    registry.ingest("brand-new-unlisted-node", {"agent": {"version": "9.9.9"}})
    check("an unenrolled node's report does not appear in status_list "
          "(only history.list_agents() is authoritative)",
          all(n["name"] != "brand-new-unlisted-node" for n in registry.status_list()))


# ---------------------------------------------------------- once-a-day claim
def check_mark_auto_updated(history: History) -> None:
    print("\n--- once-a-day claim " + "-" * 50)
    history.add_agent("claim-test-node")
    check("first claim of a day succeeds",
          history.mark_auto_updated("claim-test-node", "2026-01-01") is True)
    check("a second claim of the same day is refused (already done, or a "
          "race with another sweep lost)",
          history.mark_auto_updated("claim-test-node", "2026-01-01") is False)
    check("a new day's claim succeeds",
          history.mark_auto_updated("claim-test-node", "2026-01-02") is True)
    check("an unknown node's claim is refused",
          history.mark_auto_updated("no-such-node", "2026-01-01") is False)


# ----------------------------------------------------------- sweep decision
class _FakeRegistry:
    def __init__(self, nodes: list[dict]) -> None:
        self._nodes = nodes

    def status_list(self) -> list[dict]:
        return self._nodes


class _FakeHistory:
    def __init__(self, refuse: set[str] = frozenset()) -> None:
        self.refuse = refuse
        self.claims: list[tuple[str, str]] = []

    def mark_auto_updated(self, name: str, today: str) -> bool:
        self.claims.append((name, today))
        return name not in self.refuse


def run_sweep(main_mod, registry, history, enabled: bool, hour: int) -> list[str]:  # type: ignore[no-untyped-def]
    """Drive main._maybe_auto_update() with everything it reads faked out,
    and return the node names it actually fired an update for."""
    fired: list[str] = []

    async def fake_run_scheduled_update(name: str) -> None:
        fired.append(name)

    real_history, real_registry = main_mod.history, main_mod.registry
    real_get, real_run = (main_mod.config_module.get, main_mod._run_scheduled_update)
    main_mod.history = history
    main_mod.registry = registry
    main_mod.config_module.get = lambda: SimpleNamespace(
        auto_update_enabled=enabled, auto_update_hour=hour)
    main_mod._run_scheduled_update = fake_run_scheduled_update
    try:
        async def drive() -> None:
            before = asyncio.all_tasks()
            main_mod._maybe_auto_update()
            new = asyncio.all_tasks() - before
            if new:
                await asyncio.gather(*new)
        asyncio.run(drive())
    finally:
        main_mod.history, main_mod.registry = real_history, real_registry
        main_mod.config_module.get, main_mod._run_scheduled_update = real_get, real_run
    return fired


def check_sweep_decision() -> None:
    print("\n--- daily sweep decision " + "-" * 46)
    from culprit import main as main_mod

    ready = {"name": "ready-node", "enabled": True,
             "update_capable": True, "update_available": True}
    now_hour = time.localtime().tm_hour

    fired = run_sweep(main_mod, _FakeRegistry([ready]), _FakeHistory(),
                      enabled=False, hour=now_hour)
    check("disabled schedule never fires, even at the right hour", fired == [])

    fired = run_sweep(main_mod, _FakeRegistry([ready]), _FakeHistory(),
                      enabled=True, hour=(now_hour + 1) % 24)
    check("the wrong hour never fires", fired == [])

    fired = run_sweep(main_mod, _FakeRegistry([{**ready, "enabled": False}]),
                      _FakeHistory(), enabled=True, hour=now_hour)
    check("a disabled (revoked) agent is skipped even if it looks capable", fired == [])

    fired = run_sweep(main_mod, _FakeRegistry([{**ready, "update_capable": False}]),
                      _FakeHistory(), enabled=True, hour=now_hour)
    check("a not-capable agent is skipped", fired == [])

    fired = run_sweep(main_mod, _FakeRegistry([{**ready, "update_capable": None}]),
                      _FakeHistory(), enabled=True, hour=now_hour)
    check("an unknown-capability agent (is not True) is skipped", fired == [])

    fired = run_sweep(main_mod, _FakeRegistry([{**ready, "update_available": False}]),
                      _FakeHistory(), enabled=True, hour=now_hour)
    check("a capable but already-current agent is skipped", fired == [])

    hist = _FakeHistory()
    fired = run_sweep(main_mod, _FakeRegistry([ready]), hist,
                      enabled=True, hour=now_hour)
    check("a qualifying agent fires exactly once", fired == ["ready-node"])
    check("the claim was made for today's date",
          hist.claims and hist.claims[0][1] == time.strftime("%Y-%m-%d"))

    fired = run_sweep(main_mod, _FakeRegistry([ready]),
                      _FakeHistory(refuse={"ready-node"}), enabled=True, hour=now_hour)
    check("losing the claim (already updated today, or another sweep won "
          "the race) does not fire", fired == [])

    two = [ready, {**ready, "name": "other-node"}]
    fired = run_sweep(main_mod, _FakeRegistry(two),
                      _FakeHistory(refuse={"other-node"}), enabled=True, hour=now_hour)
    check("one node's lost claim does not block a different node's",
          fired == ["ready-node"])


def check_update_targets() -> None:
    print("\n--- update-all targets " + "-" * 48)
    ready = {"name": "ready", "enabled": True, "online": True, "container": None,
             "update_capable": True, "update_available": True}
    targets, skipped = nodes_mod.update_targets([ready])
    check("a ready agent is a target", targets == ["ready"] and skipped == [])

    def reason(**over: object) -> str:
        targets, skipped = nodes_mod.update_targets([{**ready, **over}])
        return skipped[0]["reason"] if skipped and not targets else "<targeted>"

    check("revoked is skipped", reason(enabled=False) == "revoked")
    check("offline is skipped", reason(online=False) == "offline")
    check("Docker is skipped even when it claims capability",
          reason(container="docker").startswith("runs in docker"))
    check("containerd / podman are skipped the same way",
          reason(container="containerd").startswith("runs in containerd")
          and reason(container="podman").startswith("runs in podman"))
    check("a non-runtime container word (lxc) does not exclude on its own",
          reason(container="lxc") == "<targeted>")
    check("not capable carries the agent's own reason",
          reason(update_capable=False, update_reason="no git checkout") == "no git checkout")
    check("unknown capability is skipped, never assumed",
          reason(update_capable=None) == "update capability not yet reported")
    check("already current is skipped", reason(update_available=False) == "already up to date")
    check("unknown availability is skipped",
          reason(update_available=None) == "update availability not yet known")
    check("Docker wins over offline in the reason (it never updates this way)",
          reason(container="docker", online=False).startswith("runs in docker"))

    fleet = [ready, {**ready, "name": "dock", "container": "docker"},
             {**ready, "name": "old", "update_available": False},
             {**ready, "name": "two"}, {"name": "", "enabled": True}]
    targets, skipped = nodes_mod.update_targets(fleet)
    check("a fleet yields its targets in order and names every skip",
          targets == ["ready", "two"] and [s["name"] for s in skipped] == ["dock", "old"])


def main() -> int:
    # The refetch-failure and malformed-response checks deliberately trigger
    # nodes.py's own warning log; that is the point, not noise worth printing.
    logging.disable(logging.CRITICAL)
    check_version_compare()
    check_remote_version_fetch()
    check_update_targets()
    with tempfile.TemporaryDirectory(prefix="culprit-updates-") as tmp:
        history = History(Path(tmp) / "t.db", enabled=True)
        check_ingest_update_fields(history)
        check_mark_auto_updated(history)
        history.close()
    check_sweep_decision()

    print("-" * 72)
    if failures:
        print(f"\n{RED}{len(failures)} check(s) failed.{RESET}\n")
        return 1
    print(f"\n{GREEN}All agent-update checks passed.{RESET}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
