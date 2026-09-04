"""Record the demo's fixtures from a live host, scrubbed.

The GitHub Pages demo (`tools/build_demo.py`, `web/js/demo/`) has no backend:
everything the dashboard shows there is replayed from JSON recorded off a real
fleet by this tool, so the demo speaks the product's real vocabulary -- the
`available: False` panels, the gated sources, the honest em dashes -- instead
of invented numbers. Only the liveness (jitter, the scripted incident, the
actions) is synthesised, in the browser.

What it records, per enrolled node: the snapshot (`/api/nodes/<n>/snapshot`),
the suggested expectations, the seven-day history series at the rollup
resolution (the shorter ranges are slices of it), the top processes per range
and the incidents. Plus the host-level reads: node list, fleet, settings,
status, notification status, history stats.

Scrubbing happens before anything is written, because the output is committed
to a public branch: node names and hostnames are renamed (`--rename
Jellyfin=media`), user names aliased (`--alias olayzen=sam`, applied to every
string so home paths and session rows follow), public IPv4/IPv6 addresses
become documentation-range addresses, MACs and link-local IPv6 are
re-derived from a hash, machine ids / boot ids / journal cursors / disk
serials are hashed, and `--replace old=new` handles anything else you spot.
Read the output before committing it -- a journal line can hold anything.

    .venv/bin/python tools/record_demo.py --rename Jellyfin=media --alias olayzen=sam
"""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import ipaddress
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import _auth

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT / "web" / "demo" / "data"

SERIES_COLUMNS = ("cpu_avg", "cpu_max", "mem_percent_avg", "commit_max",
                  "hard_faults_avg", "hard_faults_max", "disk_latency_avg",
                  "disk_latency_max", "gpu_avg", "gpu_max", "net_recv_avg",
                  "net_sent_avg")
RANGES = (3600, 6 * 3600, 24 * 3600, 3 * 86400, 7 * 86400)

# Keys whose values are identifiers of the recording machine, not of the
# product: hashed so the output stays self-consistent but says nothing.
HASHED_KEYS = {"machine_id", "record_id", "_BOOT_ID", "boot_id", "cursor",
               "serial", "_MACHINE_ID", "id_hash"}
HOST_KEYS = {"hostname", "fqdn"}

# Not preceded by a word character, dot or dash: "s6-2.13.2.0/command" is a
# version in a path, not an address.
IPV4 = re.compile(r"(?<![\w.-])(?:\d{1,3}\.){3}\d{1,3}(?![\w-])")
IPV6 = re.compile(r"(?<![\w:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])")
# Where the machine sits on the internet, as reported by the WAN-IP lookup.
GENERIC_KEYS = {"isp": "Example Networks", "org": "Example Networks",
                "asn": "AS64496 Example Networks", "exit_provider": "Example Networks",
                "city": "Somewhere", "region": "Somewhere", "country": "XX"}
MAC = re.compile(r"\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b")


class Client:
    def __init__(self, base: str, insecure: bool) -> None:
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        handlers: list = [urllib.request.HTTPCookieProcessor(self.jar)]
        if insecure:
            import ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        self.opener = urllib.request.build_opener(*handlers)

    def get(self, path: str):
        request = urllib.request.Request(self.base + path)
        with self.opener.open(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))

    def login(self, user: str, password: str) -> None:
        body = json.dumps({"username": user, "password": password}).encode()
        request = urllib.request.Request(
            self.base + "/api/login", data=body, method="POST",
            headers={"Content-Type": "application/json"})
        with self.opener.open(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not payload.get("ok"):
            raise SystemExit(f"login failed: {payload}")


# ------------------------------------------------------------------ scrubbing
class Scrubber:
    def __init__(self, renames: dict[str, str], aliases: dict[str, str],
                 replaces: dict[str, str], hostnames: dict[str, str]) -> None:
        self.renames = renames            # node name -> new node name
        self.hostnames = hostnames        # old hostname -> new hostname
        self.aliases = aliases            # user name -> alias
        self.replaces = replaces          # any literal -> literal
        self.ip4: dict[str, str] = {}
        self.ip6: dict[str, str] = {}
        self.counts: dict[str, int] = {}

    def _bump(self, what: str) -> None:
        self.counts[what] = self.counts.get(what, 0) + 1

    def ipv4(self, text: str) -> str:
        try:
            address = ipaddress.IPv4Address(text)
        except ValueError:
            return text
        if (address.is_private or address.is_loopback or address.is_link_local
                or address.is_multicast or address.is_unspecified
                or address.is_reserved or text.startswith("255.")):
            return text
        if text not in self.ip4:
            self.ip4[text] = f"203.0.113.{len(self.ip4) + 1}"
            self._bump("public ipv4")
        return self.ip4[text]

    def ipv6(self, text: str) -> str:
        try:
            address = ipaddress.IPv6Address(text)
        except ValueError:
            return text
        if address.is_link_local:
            # EUI-64 addresses embed the MAC; re-derive rather than keep.
            digest = hashlib.sha1(text.encode()).hexdigest()
            return f"fe80::{digest[:4]}:{digest[4:8]}:{digest[8:12]}:{digest[12:16]}"
        if address.is_loopback or address.is_private or address.is_unspecified:
            return text
        if text not in self.ip6:
            self.ip6[text] = f"2001:db8::{len(self.ip6) + 1}"
            self._bump("public ipv6")
        return self.ip6[text]

    def string(self, text: str, key: str | None) -> str:
        if key in HASHED_KEYS:
            self._bump(f"hashed {key}")
            digest = hashlib.sha256(text.encode()).hexdigest()
            return digest[: min(len(text), 32)] if key != "serial" else f"DEMO{digest[:8].upper()}"
        if key in HOST_KEYS and text in self.hostnames:
            self._bump("hostname")
            return self.hostnames[text]
        if key in GENERIC_KEYS and text:
            self._bump(f"generic {key}")
            return GENERIC_KEYS[key]
        for old, new in self.replaces.items():
            if old in text:
                self._bump(f"replace {old}")
                text = text.replace(old, new)
        for old, new in self.aliases.items():
            if old in text:
                self._bump(f"alias {old}")
                text = re.sub(rf"(?<![A-Za-z0-9]){re.escape(old)}(?![A-Za-z0-9])", new, text)
        # "<hostname>.local" anywhere (avahi, mDNS), bare hostnames only in
        # the Host allow-list -- a bare hostname is often also a process name.
        for old, new in self.hostnames.items():
            if f"{old}.local" in text:
                self._bump("hostname")
                text = text.replace(f"{old}.local", f"{new}.local")
            if key in ("always_hosts", "trusted_hosts") and text == old:
                text = new
        if MAC.search(text):
            def mac(match: re.Match) -> str:
                self._bump("mac")
                digest = hashlib.sha1(match.group(0).lower().encode()).hexdigest()
                return "02:" + ":".join(digest[i:i + 2] for i in range(0, 10, 2))
            text = MAC.sub(mac, text)
        if IPV4.search(text):
            text = IPV4.sub(lambda m: self.ipv4(m.group(0)), text)
        if ":" in text and IPV6.search(text):
            text = IPV6.sub(lambda m: self.ipv6(m.group(0)), text)
        return text

    def walk(self, value, key: str | None = None):
        if isinstance(value, dict):
            # A node status / fleet card / node_meta row: its `name` is the
            # node name. Anywhere else `name` is a process, unit or user.
            is_node = "name" in value and ("online" in value or "hostname" in value)
            out = {}
            for k, v in value.items():
                # Keys can carry names too (a table keyed by unit or user).
                kk = self.string(k, None) if isinstance(k, str) else k
                if isinstance(v, str) and v in self.renames and (k == "node" or (k == "name" and is_node)):
                    self._bump("node name")
                    out[kk] = self.renames[v]
                else:
                    out[kk] = self.walk(v, k)
            return out
        if isinstance(value, list):
            return [self.walk(v, key) for v in value]
        if isinstance(value, str):
            return self.string(value, key)
        return value


# ------------------------------------------------------------------ recording
def record(client: Client, scrub: Scrubber, out: Path, ranges) -> None:
    now = time.time()
    nodes = client.get("/api/nodes")["nodes"]
    if not nodes:
        raise SystemExit("the host has no enrolled agents; nothing to record")
    host = {
        "recorded_at": now,
        "nodes": nodes,
        "fleet": client.get("/api/fleet"),
        "settings": client.get("/api/settings"),
        "status": client.get("/api/status"),
        "notify_status": client.get("/api/notify/status"),
        "history_stats": client.get("/api/history/stats"),
        "expectations": client.get("/api/expectations"),
    }
    # The recording machine's own addresses are what the settings page shows
    # as "always trusted"; the demo host is nowhere, so say loopback only.
    access = host["settings"].get("access") or {}
    for key in ("peer", "client", "host"):
        if key in access:
            access[key] = "127.0.0.1"
    host["history_stats"]["path"] = "/var/lib/culprit/culprit.db"
    host["status"]["overhead"]["pid"] = 4242
    (out / "nodes").mkdir(parents=True, exist_ok=True)
    manifest_nodes = []
    for status in nodes:
        name = status["name"]
        new_name = scrub.renames.get(name, name)
        q = urllib.parse.quote(name)
        print(f"  {name} -> {new_name}: snapshot", end="", flush=True)
        payload = {
            "snapshot": client.get(f"/api/nodes/{q}/snapshot"),
            "suggested": client.get(f"/api/expectations/suggested?node={q}"),
        }
        since = now - max(ranges)
        print(", history", end="", flush=True)
        payload["series"] = client.get(
            f"/api/history/series?since={since}&columns={','.join(SERIES_COLUMNS)}&node={q}")
        payload["incidents"] = client.get(
            f"/api/history/incidents?since={since}&limit=200&node={q}")
        payload["top"] = {}
        for span in ranges:
            payload["top"][str(span)] = client.get(
                f"/api/history/top?since={now - span}&limit=15&node={q}")
        scrubbed = scrub.walk(payload)
        path = out / "nodes" / f"{new_name}.json"
        path.write_text(json.dumps(scrubbed, separators=(",", ":")) + "\n")
        print(f" -> {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")
        manifest_nodes.append({"name": new_name, "file": f"nodes/{new_name}.json"})
    scrubbed_host = scrub.walk(host)
    (out / "host.json").write_text(json.dumps(scrubbed_host, separators=(",", ":")) + "\n")
    (out / "manifest.json").write_text(json.dumps({
        "recorded_at": now, "nodes": manifest_nodes, "host": "host.json",
        "series_columns": list(SERIES_COLUMNS), "top_ranges": list(ranges),
    }, indent=1) + "\n")


def _pairs(values: list[str] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in values or []:
        if "=" not in item:
            raise SystemExit(f"expected old=new, got {item!r}")
        old, new = item.split("=", 1)
        out[old] = new
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", default=None, help="host URL (default http://127.0.0.1:8787)")
    parser.add_argument("--user")
    parser.add_argument("--password")
    parser.add_argument("--insecure", action="store_true", help="accept a self-signed certificate")
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    parser.add_argument("--rename", action="append", metavar="NODE=NEW",
                        help="rename a node (and its hostname) in the output")
    parser.add_argument("--alias", action="append", metavar="USER=ALIAS",
                        help="alias a user name everywhere it appears (paths, sessions, rows)")
    parser.add_argument("--replace", action="append", metavar="OLD=NEW",
                        help="replace a literal in every string value")
    _auth.add_arguments(parser)
    args = parser.parse_args()
    note = _auth.apply(args, uses=("url", "user", "password", "insecure"))
    if note:
        print(f"\033[90m{note}\033[0m")
    url = args.url or "http://127.0.0.1:8787"

    client = Client(url, bool(args.insecure))
    try:
        if args.user and args.password:
            client.login(args.user, args.password)
        nodes = client.get("/api/nodes")["nodes"]
    except urllib.error.HTTPError as exc:
        print(f"{url}: HTTP {exc.code} -- {'sign in with --user/--password' if exc.code == 401 else exc.reason}")
        return 2
    except urllib.error.URLError as exc:
        print(f"{url}: {exc.reason}")
        return 2

    renames = _pairs(args.rename)
    hostnames = {}
    for status in nodes:
        if status["name"] in renames and status.get("hostname"):
            hostnames[status["hostname"]] = renames[status["name"]]
    scrub = Scrubber(renames, _pairs(args.alias), _pairs(args.replace), hostnames)

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"recording {len(nodes)} node(s) from {url} into {args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out}")
    record(client, scrub, args.out, RANGES)
    print("scrubbed: " + ", ".join(f"{k} x{v}" for k, v in sorted(scrub.counts.items())))
    if scrub.ip4:
        print("public IPv4 seen: " + ", ".join(sorted(scrub.ip4)))
    print("Read the output before committing it: grep it for names, domains and paths you recognise.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
