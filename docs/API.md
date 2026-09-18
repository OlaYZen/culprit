# Culprit HTTP API

Everything the dashboard does, it does through this API, so anything the
dashboard shows or does can be scripted. This file describes **every route the
host serves** — `tools/check_api_docs.py` walks `app.routes` and fails when a
route is missing here, when a heading here names a route that no longer exists,
or when the access level written here differs from the one the route enforces.

The host also serves a machine-readable description of the same surface:
`GET /api/openapi.json`, rendered at `/api/docs` (Swagger UI, with an
**Authorize** button that takes an API key).

- [Conventions](#conventions)
- [Authentication](#authentication) — sessions, **API keys**, agent tokens, roles
- [Quick start](#quick-start)
- [Errors](#errors)
- [Reading a machine: the node snapshot](#reading-a-machine-the-node-snapshot)
- Reference
  - [Session and identity](#session-and-identity)
  - [Account](#account)
  - [API keys](#api-keys)
  - [Users](#users)
  - [Agents: enrollment and ingest](#agents-enrollment-and-ingest)
  - [Nodes and fleet](#nodes-and-fleet)
  - [Process actions](#process-actions)
  - [Unit actions](#unit-actions)
  - [Agent updates and versions](#agent-updates-and-versions)
  - [History](#history)
  - [The Pulse](#the-pulse)
  - [The Prognosis: wear](#the-prognosis-wear)
  - [The Coroner: deaths](#the-coroner-deaths)
  - [The Map](#the-map)
  - [Expectations](#expectations)
  - [Notifications](#notifications)
  - [Settings](#settings)
  - [Patch notes and port names](#patch-notes-and-port-names)
  - [Live stream and host status](#live-stream-and-host-status)
  - [Host-local reads (legacy)](#host-local-reads-legacy)
  - [Pages and static files](#pages-and-static-files)
- [Recipes](#recipes)

---

## Conventions

| | |
|---|---|
| Base URL | wherever the host listens — `http://127.0.0.1:8787` by default, or the address behind your proxy |
| Bodies | JSON in, JSON out (`Content-Type: application/json`). Body fields are top-level keys of one object |
| Times | epoch seconds as floats (`1789731408.29`), UTC by definition. Windows of the day are `"HH:MM"` in the **host's** local time |
| Sizes and rates | bytes and bytes per second unless the field name says otherwise (`_mb`, `_ms`, `_pct`, `percent`) |
| Node names | the name an agent was enrolled under (`web-01`). `local` is reserved and refers to the host, which is **not** a monitored node |
| Missing ≠ zero | a source that could not be read is `available: false` with a `reason`, and a value that could not be measured is `null` — never `0`. Treat `null` as "unknown", not "none" |
| Caching | every `/api/*` response is `Cache-Control: no-store` |
| Versioning | there is no `/v1`. The API moves with the host's version (`config.version` in `/api/settings`); field names are kept stable on purpose and `tools/check_contract.py` pins the ones the dashboard reads |

All reads are served from memory or SQLite. **No read endpoint samples a
machine on demand**, so polling is cheap: a request costs a dict serialisation.
The only routes that reach an agent are the ones that must — a process's detail
and the actions — and those wait for the agent's next report (see
[How a command reaches an agent](#how-a-command-reaches-an-agent)).

---

## Authentication

Three credentials exist, for three kinds of caller.

| Caller | Credential | Sent as | Works on |
|---|---|---|---|
| A person in a browser | session cookie `culprit_session` | `Cookie` (set by `POST /api/login` or the provider sign-in) | every gated route |
| A person's script | **API key** `ck_<id>.<secret>` | `Authorization: Bearer ck_…` | every gated route **except** the credential routes (below) |
| An agent | agent token `<name>.<secret>` | `Authorization: Bearer <name>.…` | `POST /api/agents/report` only |

The credentials do not substitute for one another: an agent token opens nothing
but the ingest, and neither a session nor an API key is accepted there.

**When authentication is off.** A host with no users at all runs
unauthenticated and refuses to bind anything but loopback. In practice this
does not happen: the host creates `admin` / `admin` on first start. While it is
off every route is open and role checks pass.

### Roles

Every account has one role, and each route states the minimum it needs.

| Role | May |
|---|---|
| `viewer` | read everything: snapshots, history, findings, the doctors, the map, settings |
| `operator` | viewer, plus act: end / renice / throttle a process, truncate a deleted file, restart a unit, update agents, mark findings as expected, mark a node as not always on |
| `admin` | operator, plus configure: `PUT /api/settings`, users, agent enrollment and tokens, everyone's API keys, notification test |

A route below with **Access: viewer** needs any valid credential. A request
whose role is too low gets `403 {"detail": "requires operator access"}`.

### API keys

An API key is a standing credential for scripts, dashboards and monitors —
Grafana, a cron job, Home Assistant, `curl`.

```
Authorization: Bearer ck_3017f38dcebf.9BqqzQ0Ej8pjqsl-wu2ViuwSrQ8mfciaTxJPbQVH9u8
```

- **It acts as its owner, under a cap.** A key is created with a role
  (`viewer` by default). What it may do is the *lower* of that role and its
  owner's **current** role, evaluated on every request. Demote a person and
  their keys are demoted with them at once; promote them and their keys stay
  where they were put. `GET /api/auth` with the key tells a script who it is
  and what it may do.
- **It is shown once.** The host stores the SHA-256 of the secret. The token
  appears in the response that minted it and never again; a lost key is
  revoked and replaced. The `ck_<id>` prefix is not secret and is how a key is
  matched to its row in Settings.
- **Creating one re-proves the password.** A key outlives the session that made
  it, so a borrowed, still-signed-in browser must not be able to leave one
  behind. (An account created by a sign-in provider has no password and nothing
  further to prove.)
- **It cannot manage credentials.** The routes marked **session only** — the
  key routes themselves and the account's password, username and provider link
  — answer a key with `403`, whatever its role. A leaked key can therefore
  never mint another key, and revoking it ends what it could do. One honest
  exception follows from what *admin* means: an `admin` key can create users,
  and a user is a credential. Give a key `admin` only when the script really
  configures the host; nearly everything wants `viewer`.
- **It is independent of the password.** Changing a password signs out every
  browser but leaves keys working, so rotating a password does not break the
  backup check. Keys are revoked one by one — by their owner, by an admin, or
  all at once by removing the account. Optional expiry (`expires_days`) bounds
  a key that nobody remembers to revoke.
- **A presented key is judged alone.** A request carrying both a session cookie
  and an API key is authorised as the key. A wrong, expired or revoked key is a
  `401` even beside a valid cookie.
- **Header only.** A key in the query string is ignored (URLs end up in logs
  and browser history). For the same reason, browsers' `EventSource` cannot
  use a key for `/api/stream`; any client that can set a header can.
- Limits: 25 keys per account; names are 1–64 printable characters; expiry is
  1–3650 days or never. `last_used` / `last_addr` are stamped at most once a
  minute per key — they tell you whether a key is still in use, they are not an
  audit log. Writes made with a key are logged by the host with the key's id
  and name, and actions are recorded as `alice (key: grafana)`.

Create keys in **Settings › Account › API keys**, with `POST /api/account/keys`
from a session, or on the host:

```bash
python -m culprit keys add alice "grafana" --role viewer --expires-days 365
python -m culprit keys list [alice]
python -m culprit keys revoke 3017f38dcebf
```

**Behind Cloudflare or another bot-filtering proxy:** a managed challenge
answers a script with an HTML `403` before the request reaches Culprit. Give
API clients (and agents) a path that is not challenged.

### Network trust

Before any credential is looked at, the host checks the network path
(`Settings › Network`): a request carrying forwarding headers
(`X-Forwarded-For`, `Forwarded`, …) from a peer that is not a declared proxy is
refused with `400 {"detail": …, "reason": "untrusted_proxy"}`, and with a
`trusted_hosts` list configured, an unknown `Host` is `400 … "untrusted_host"`.
If your script gets a `400` with a `reason`, that is this, not the API.

---

## Quick start

```bash
HOST=http://127.0.0.1:8787
KEY=ck_3017f38dcebf.9Bqqz…            # Settings › Account › API keys

# Who am I, and what may I do?
curl -s -H "Authorization: Bearer $KEY" $HOST/api/auth

# Which machines are there, and how are they?
curl -s -H "Authorization: Bearer $KEY" $HOST/api/fleet | jq '.nodes[] | {name, online, status, headline}'

# Everything about one machine
curl -s -H "Authorization: Bearer $KEY" $HOST/api/nodes/web-01/snapshot | jq '.diagnosis.findings'

# The last day's incidents on it
curl -s -H "Authorization: Bearer $KEY" "$HOST/api/history/incidents?node=web-01"
```

```python
import requests

s = requests.Session()
s.headers["Authorization"] = f"Bearer {KEY}"
for node in s.get(f"{HOST}/api/fleet", timeout=10).json()["nodes"]:
    print(node["name"], node["status"], node["headline"])
```

Without a key, a script can sign in like a browser: `POST /api/login` and keep
the cookie (`curl -c jar -b jar`). Prefer a key — a session is tied to the
password and expires after seven days.

---

## Errors

Errors are JSON with a `detail`. The status code is the contract; the text is
for people.

| Status | Meaning | Body |
|---|---|---|
| `400` | malformed request (not JSON, `confirm` missing on a destructive action), or the network path is not trusted (`reason` present) | `{"detail": "…"}` |
| `401` | no valid credential. Pages redirect to `/login` with `303` instead | `{"detail": "authentication required"}` |
| `403` | the credential is valid but may not do this: role too low, an API key on a session-only route, or a wrong `current_password` | `{"detail": "requires admin access"}` |
| `404` | no such node, user, key, death, expectation, or watched action | `{"detail": "no agent named 'x'"}` |
| `409` | refused because of current state: duplicate name, last admin, node not update-capable, agent revoked, too many keys | `{"detail": "…"}` |
| `410` | a host-local process route; the host is not a monitored node | `{"detail": "…"}` |
| `413` | agent report too large (8 MB, or 32 MB inflated) | `{"detail": "report too large"}` |
| `422` | validation failed. Generic form: `{"detail": [{"loc": […], "msg": "…", "type": "…"}]}` — the submitted value is **never** echoed. Settings and expectations answer `{"ok": false, "field_errors": {"<field>": "<message>"}}` so a form can place each message | |
| `502` | the agent ran the command and reported failure, or the sign-in provider could not be reached | `{"detail": "<the agent's reason>"}` |
| `503` | a host component is not initialised, or the agent repository mirror is unavailable | `{"detail": "…"}` |
| `504` | the agent did not answer in time — offline, or reporting slowly | `{"detail": "'web-01' did not answer within 8s …"}` |

A wrong password on a credential route is `403`, not `401`, deliberately: `401`
means "sign in again" to every client, and a typo should not do that.

Login failures are limited to 8 per source address per 5 minutes; past that,
`POST /api/login` answers `401` even for the right password until the window
passes. API keys have no such limiter (256 random bits leave nothing to
guess, and a lockout would let one broken script disable everyone's).

---

## Reading a machine: the node snapshot

`GET /api/nodes/{name}/snapshot` is the API's centre of gravity: one object
holding the latest of every section the agent reports. The dashboard's views
are all renderings of it. Sections arrive at different cadences and each is
replaced whole, so a section is internally consistent; `ts` is the agent's
clock at its last fast tick.

| Section | Cadence | What it holds |
|---|---|---|
| `system` | once / on change | `hostname`, `fqdn`, `os{}`, `kernel`, `machine_id`, `cpu{}` (model, cores), `gpus[]`, `machine{}`, `virtualization`, `container`, `cgroup_version`, `psi_available`, `access{}` (which optional sources are readable and **the exact group or capability that unlocks each**), `total_ram`, `boot_time`, `uptime_seconds`, `platform` on Windows nodes |
| `cpu` | 1 s | `total`, `per_core[]`, `user`, `privileged`, `interrupt`, `iowait`, `steal`, `frequency_mhz`, `governor`, `thermal{}`, `queue_length`, `queue_per_core`, `blocked`, `load_1/5/15`, `context_switches` |
| `memory` | 1 s | `total`, `used`, `available`, `percent`, `available_mb`, `committed`, `commit_limit`, `commit_percent`, `commit_enforced`, `overcommit_policy`, `cached`, `hard_faults_sec`, `page_faults_sec`, `swap_*`, `swap_rotational`, OOM-kill counters |
| `psi` | 1 s | `cpu`, `memory`, `io`, each `{some, full}` with `avg10/avg60/avg300` — the kernel's own measure of time spent stalled |
| `gpu` | 1 s | `available`, `reason`, `backends_tried{}`, `adapters[]`, `total`, `engines[]` |
| `disk` | 1 s | `disks[]` (per device: busy %, latency ms, queue, read/write bytes/s, IOPS) and `total{}` |
| `network` | 1 s | `interfaces[]` (rates, errors, drops) and `total{recv_bytes_sec, sent_bytes_sec}` |
| `pressures` | 1 s | `cpu`, `memory`, `disk`, `gpu` as 0..1, `mode` (`psi` or the labelled `derived` fallback), `detail{}` |
| `process_table` | 2 s | `processes[]` (pid, name, user, cpu, memory, IO, state, `unit`, `container`, `lag_score`, `lag_reasons[]`, `kernel{}` for active kernel threads, …), `totals{}`, `by_state{}`, `truncated`, `io_note` (how many processes' IO was gated) |
| `diagnosis` | 2 s | **the Lag Doctor**: `status`, `severity`, `headline`, `findings[]`, `offenders[]`, `pressures{}`, `memory_forecast{}`, `expected_count` — see below |
| `cgroups` | 2 s | per-unit PSI and limits: `units[]`, `total_units`, `emitted` |
| `kernel` | 2 s | `mdstat{}` (RAID sync / degraded), `irq{}` (per-core IRQ and softirq rates) |
| `services` | 20 s | `services[]` (systemd units with cgroup CPU/memory/IO, `lines_sec`), `summary{}`, `problems[]`, `by_pid{}`, `timers[]` (systemd timers and cron jobs with `last`, `next`, `run{}`), journal-rate availability |
| `volumes` | 20 s | `volumes[]` (mounts with usage, the fill `forecast`, `writers[]`, `files[]`, `held[]` deleted-but-open files), `skipped[]`, `media[]` |
| `network_detail` | 20 s | `adapters[]`, `sockets{}` (`established[]` with per-connection RTT / retransmits / queues where `ss -ti` is available, `per_process`), `connectivity{}`, `wan_ip{}`, `vpn{}` |
| `ports` | 20 s | `ports[]` (listeners with pid, name, unit, `accept_queue{current,max,pct}`, `connections`, `turned_away`), `totals{}`, `backlog{}` (listen-overflow and SYN-drop rates) |
| `sync` | 20 s | file-sync clients, `problems[]`, `inotify{}` |
| `ceilings` | 20 s | `limits[]` (fd / thread / pid / conntrack / inotify ceilings with the holder), `conntrack{}`, `oom{next[]}` (who the kernel would kill next) |
| `changes` | 20 s | `events[]` — what changed on the machine (units, timers, mounts, ports, packages, logins, processes appearing), each with `ts`, `exact`, `source`; `recording_since` |
| `outage` | 20 s | **the Outage Doctor**: `status`, `severity`, `items[]` (each with `kind`, `key`, `root{unit,result,line,chain}`, `fix`, `evidence`, `since`, `actions[]`), `checks{}` |
| `events` | 120 s | `journal{}`, `crashes{}`, `updates{}`, `policy{}`, `sessions{}`, `pending_reboot{}` |
| `prognosis` | 120 s | **the Prognosis**: `items[]`, `devices[]` (SMART, `history`, endurance `forecast`), `links[]`, `nics[]`, `memory{}` (ECC), `pci[]` (AER), `power[]`, `checks{}` |
| `node_meta` | host-added | the node's row from `/api/nodes` (online, versions, platform, update state, doctor statuses) |
| `timings`, `errors`, `warm`, `warmup_stage`, `server_started_at`, `now`, `ts` | | the agent's own tick costs, collector errors, and clocks |

### A finding

`diagnosis.findings[]`, and — with a `key` prefix — `outage.items[]`,
`prognosis.items[]` and the Pulse's items share one shape:

```jsonc
{
  "key": "psi_io",                 // stable identity; ":"-separated when it names a subject (space_forecast:/home)
  "severity": "warn",              // info | warn | critical
  "severity_raw": "critical",      // present when an expectation lowered it
  "resource": "disk",              // cpu | memory | disk | network | gpu | limits | hardware …
  "title": "Storage is making programs wait",
  "detail": "…one paragraph, numbers included…",
  "since": 1789731408.2,           // when it began holding
  "culprits": [                    // ranked; [] when nobody on this machine is at fault
    {"pid": 4123, "name": "rsync", "username": "backup", "container": null,
     "share": "71% of the machine's disk IO",    // a sentence, already worded for the resource
     "cpu": 3.1, "working_set": 48211456, "io_bytes_sec": 88211456, "gpu": null,
     "stuck": false, "lag_score": 38.2}
  ],
  "external": false,               // true: caused from outside (steal, thermal, RAID resync…), with "blame"
  "expected": {"id": 3, "reason": "nightly backup"},   // when an expectation matched
  "changes": [ … ],                // what changed on the machine around "since"
  "unit": { … }, "mount": "/home", "port": 443, "holder": { … }, "hardware": { … }   // by finding family
}
```

Two rules are worth knowing before building on this. **`culprits: []` is an
answer, not a gap** — external findings, hardware items and unattributable
overflows name nobody on purpose. And **ranking follows the cause**: a memory
forecast ranks the processes that are *growing*, a full volume ranks the
processes *writing to that mount*, a ceiling names its one holder.

---

# Reference

Each entry gives the route, the minimum role, and whether an API key may call
it. Query parameters are listed with their defaults; body fields are keys of
one JSON object.

## Session and identity

### POST /api/login

**Access:** public

Sign in with a password; sets the `culprit_session` cookie (HttpOnly,
SameSite=Lax, Secure over TLS, seven days).

| Body | | |
|---|---|---|
| `username` | string | required |
| `password` | string | required |

`200` `{"ok": true, "auth": true, "username": "alice"}` ·
`401` wrong credentials **or** the address is rate-limited (the two are not
distinguished, and an unknown username costs the same time as a wrong password).
With authentication off: `{"ok": true, "auth": false, "note": "…"}`.

### POST /api/logout

**Access:** viewer

Clears the cookie in this browser. Sessions are stateless: a *copied* cookie
stays valid until it expires or the password changes. `200 {"ok": true}`.

### GET /api/auth

**Access:** public

Whether authentication is on, and who the caller is. The "who am I" call for a
script.

```jsonc
{"enabled": true,
 "username": "alice", "role": "viewer",        // role is the EFFECTIVE one for a key
 "via": "api_key",                             // "session" | "api_key" | null when not signed in
 "api_key": {"id": "3017f38dcebf", "name": "grafana"},   // null for a session
 "providers": [{"id": "oidc", "label": "Authentik", "start": "/api/auth/oidc/start"}]}
```

### GET /api/auth/oidc/start

**Access:** public

Browser navigation, not an API call: redirects (`303`) to the configured
OpenID Connect provider with PKCE, a nonce and a signed ten-minute state
cookie. `404` when no provider is configured. On failure redirects to
`/login?error=<code>`.

### GET /api/auth/oidc/callback

**Access:** public

Where the provider sends the browser back (`?code=&state=`). Exchanges the
code, resolves the account (linked subject → an admin's verified-e-mail
pre-link → auto-create if allowed), sets the session and redirects to `/`; on
failure to `/login?error=<code>`, or to `/?oidc=<code>#settings/account` when
the round trip was an account link. The codes are a fixed set
(`state`, `expired`, `denied`, `not_linked`, `email_unverified`, `domain`,
`linked_elsewhere`, `taken`, `session`, `rate_limited`, …); provider text never
reaches a URL.

## Account

The signed-in account's own credentials. The four that change something are
**session only** and re-prove the current password.

### GET /api/account

**Access:** viewer

```jsonc
{"username": "alice", "role": "operator",
 "has_password": true,                 // false: created by the sign-in provider
 "identity": {"provider": "oidc", "email": "a@example.org", "display": "Alice",
              "subject": "…", "subject_set": true,      // false: an unclaimed e-mail pre-link
              "linked_at": 1789000000.0, "last_login": 1789731408.2},   // or null
 "providers": [ … ]}
```

### POST /api/account/password

**Access:** viewer · session only

| Body | | |
|---|---|---|
| `current_password` | string | required |
| `new_password` | string | at least 8 characters |

`200 {"ok": true}` and a **re-issued cookie**: session signatures include the
password hash, so the change signs out every other browser of this account and
keeps this one. API keys are not affected. `403` wrong current password.

### POST /api/account/username

**Access:** viewer · session only

| Body | | |
|---|---|---|
| `new_username` | string | 1–48 of letters, digits, `-`, `_`, `.` |
| `current_password` | string | required |

`200 {"ok": true, "username": "…"}` with a cookie for the new name. Keys and
the provider identity follow the rename. `409` name taken.

### POST /api/account/oidc/link

**Access:** viewer · session only

Start connecting this account to the sign-in provider. Body
`{"current_password": "…"}`. Answers `{"ok": true, "url": "https://…"}` — the
browser must *navigate* there — and sets the state cookie in link mode. `404` no
provider configured · `409` already linked · `502` provider unreachable.

### DELETE /api/account/oidc

**Access:** viewer · session only

Disconnect the provider identity. Body `{"current_password": "…"}`.
`409` when the account has no password (it would have no way in).
`200 {"ok": true, "username": "…"}`.

## API keys

See [API keys](#api-keys) above for what a key is. All five routes are
**session only**: a key cannot list, mint or revoke keys.

A key as the API shows it — the secret is never part of it:

```jsonc
{"id": "3017f38dcebf", "prefix": "ck_3017f38dcebf",
 "name": "grafana", "username": "alice",
 "role": "operator",                // the cap it was given
 "effective_role": "viewer",        // what it can do now: min(cap, owner's role)
 "created_at": 1789731408.2, "expires_at": null, "expired": false,
 "last_used": 1789731999.0, "last_addr": "10.0.0.7"}   // stamped at most once a minute
```

### GET /api/account/keys

**Access:** viewer · session only

```jsonc
{"keys": [ … ], "limit": 25,
 "roles": ["viewer", "operator"],   // the caps this account may hand out
 "needs_password": true}            // false for a provider-created account
```

### POST /api/account/keys

**Access:** viewer · session only

Mint a key for the signed-in account. **The only response that ever contains
the token.**

| Body | | |
|---|---|---|
| `name` | string | 1–64 printable characters; what will use it |
| `role` | string | `viewer` (default), `operator`, `admin` — never above your own |
| `expires_days` | int \| null | 1–3650, or `null` / omitted for no expiry |
| `current_password` | string | required when `needs_password` |

```jsonc
{"ok": true, "key": { … },
 "token": "ck_3017f38dcebf.9BqqzQ0Ej8pjqsl-wu2ViuwSrQ8mfciaTxJPbQVH9u8",
 "header": "Authorization: Bearer ck_3017f38dcebf.9Bqqz…",
 "note": "this token is shown once; only its hash is stored"}
```

`403` wrong password, or a role above your own · `409` 25 keys already ·
`422` bad name, role or expiry.

### DELETE /api/account/keys/{key_id}

**Access:** viewer · session only

Revoke one of your own keys; it fails from its next request.
`200 {"ok": true, "id": "…"}` · `404` no such key (someone else's id answers
the same as a made-up one).

### GET /api/keys

**Access:** admin · session only

Every account's keys: `{"keys": [ … ]}`, ordered by owner.

### DELETE /api/keys/{key_id}

**Access:** admin · session only

Revoke any key. `200 {"ok": true, "id": "…"}` · `404`.

## Users

Other people's accounts. Culprit always keeps one admin: the last one cannot be
demoted or removed (`409`).

### GET /api/users

**Access:** admin

`{"users": [{"username", "role", "created_at", "has_password", "identity"}]}` —
`identity` as in `GET /api/account`.

### POST /api/users

**Access:** admin

| Body | | |
|---|---|---|
| `username` | string | 1–48 of letters, digits, `-`, `_`, `.` |
| `password` | string | at least 8 characters |
| `role` | string | `viewer` \| `operator` \| `admin` |

`200 {"ok": true, "username", "role"}` · `409` exists · `422`.

### PUT /api/users/{name}/role

**Access:** admin

Body `{"role": "…"}`. Takes effect on that account's next request, and caps its
API keys at once. `404` · `409` would leave no admin.

### PUT /api/users/{name}/identities/oidc

**Access:** admin

Pre-link an account to an e-mail address: whoever the provider vouches for
under it (with `email_verified`) claims the account at their first sign-in.
Body `{"email": "…"}`. `200 {"ok", "username", "identity"}` · `409` already
linked to a claimed identity.

### DELETE /api/users/{name}/identities/oidc

**Access:** admin

Remove a user's provider identity. For an account with no password this ends
its access: its sessions are revoked and `note` says so.
`200 {"ok", "username", "note"}` · `404`.

### DELETE /api/users/{name}

**Access:** admin

Removes the account, its sessions and **its API keys**. `409` for your own
account or the last admin · `404`.

## Agents: enrollment and ingest

### POST /api/agents

**Access:** admin

Enroll an agent. Body `{"name": "web-01"}` (1–48 of letters, digits, `-`, `_`;
not `local`). The token is shown **once**:

```jsonc
{"ok": true, "name": "web-01", "token": "web-01.Zk3…",
 "deploy_command": "./agent.sh https://host:8787 web-01.Zk3…",
 "deploy_command_windows": ".\\agent.ps1 https://host:8787 web-01.Zk3…",
 "docker_command": "docker run -d --name culprit-agent … ghcr.io/olayzen/culprit-agent:latest",
 "note": "this token is shown once; only its hash is stored"}
```

`409` the name exists (rotate its token instead).

### POST /api/agents/{name}/token

**Access:** admin

Rotate the token (also re-enables a revoked agent). Same response as
enrollment. The old token stops working immediately. `404`.

### POST /api/agents/{name}/revoke

**Access:** admin

Reject this agent's reports from now on (`401` to the agent). The remote
process keeps running. `200 {"ok", "name"}` · `404`.

### DELETE /api/agents/{name}

**Access:** admin

Remove the agent and its token. Stored history for the node is kept.
`200 {"ok", "name", "note"}` · `404`.

### POST /api/agents/report

**Access:** agent token

The ingest: the one route open to the network without a session, and the only
one that takes an agent token (`Authorization: Bearer <name>.<secret>`).
Agents are push-only; **this response is the only downlink to them.** You do
not call this unless you are writing an agent.

Request: a JSON object, optionally `Content-Encoding: gzip`; at most 8 MB on
the wire and 32 MB inflated (bounded — a gzip bomb costs the ceiling and is
refused `413`).

```jsonc
{"agent": {"report_interval": 1.0, "interval_fast": 1.0, "version": "0.21.3-b",
           "platform": "linux",                       // "windows" for the Windows agent
           "update_capable": true, "update_reason": null,
           "update_refs": true, "update_branch": "main"},
 "snapshot": {"cpu": { … }, "memory": { … }},          // only the sections that changed
 "command_results": [{"id": "…", "ok": true, "result": { … }}]}
```

Reports are **delta-compressed**: a section is sent when it changed, and the
host merges per section. Everything is sanitised before it touches node state
— allow-listed sections only, dict-typed, depth ≤ 24, integers that fit a
float, no `NaN`/`Infinity`, intervals clamped to 0.2–60 s. A bad report is a
`400`, never a `500`, and changes nothing.

```jsonc
{"ok": true,
 "known": true,                  // false after a host restart: send a full snapshot next
 "settings": {"interval_fast": 0.5, …},               // what the host wants this agent to run with
 "commands": [{"id": "…", "action": "terminate", "payload": {"pid": 4123, "force": false}}]}
```

`401` invalid or revoked token (checked before the body is read) · `413` ·
`400`.

## Nodes and fleet

### GET /api/nodes

**Access:** viewer

```jsonc
{"nodes": [{
   "name": "web-01", "enabled": true, "online": true,
   "last_seen": 1789731408.2, "age_seconds": 0.6, "enrolled_at": 1780000000.0, "last_addr": "10.0.0.7",
   "report_interval": 1.0, "interval_fast": 1.0,
   "hostname": "web-01", "os": "Ubuntu 24.04", "platform": "linux", "container": null,
   "intermittent": false,                       // the operator's "not always on"
   "severity": "ok",                            // the Lag Doctor's
   "pulse_status": "ok", "pulse_severity": "ok", "pulse_count": 0,
   "prognosis_status": "ok", "prognosis_severity": "ok", "prognosis_count": 0,
   "agent_version": "0.21.3-b", "remote_version": "0.21.3-b", "remote_branch": "main",
   "update_available": false, "update_capable": true, "update_reason": null,
   "update_refs": true, "update_branch": "main", "update_self_broken": false,
   "branch_switch_supported": true, "pinned_version": null, "pinned_ref": null}],
 "published": {"branch": "main", "linux": "0.21.3-b", "windows": null,
               "checked_at": 1789730000.0, "every_seconds": 1800.0}}
```

`published` is what GitHub says the agents should be on; `checked_at` is
stamped only by a *successful* fetch, so a run of failures shows an ageing
answer rather than a fresh-looking one.

### GET /api/fleet

**Access:** viewer

One compact row per node — everything in `/api/nodes` plus `status`,
`headline`, `findings` (count), `offender`, `cpu`, `memory`, `disk_busy` — and
`shared`: causes active on two or more online nodes at once (a shared NFS
server, a hypervisor stealing from all its guests), reported once rather than
as N culprits. `{"nodes": [ … ], "shared": [ … ], "ts": …}`.

This is the right endpoint for a status board or an uptime monitor.

### GET /api/nodes/{name}/snapshot

**Access:** viewer

The node's latest full snapshot — see
[Reading a machine](#reading-a-machine-the-node-snapshot). `404` when the agent
is unknown, or enrolled but not heard from since the host started.

### PUT /api/nodes/{name}/settings

**Access:** viewer

The title bar's Refresh control: ask an agent to sample faster or slower
*right now*. Not configuration — in memory on both sides, reverted by a restart
of either. Body `{"interval_fast": 0.5}` (0.25–60 s; the only settable key).
`200 {"ok", "name", "settings", "note": "applies on the agent's next report"}` ·
`404` · `422`.

### PUT /api/nodes/{name}/availability

**Access:** operator

The operator's word that a machine is not always on (a desktop that sleeps),
so being offline is expected: not badged, not counted, not notified. Body
`{"intermittent": true}`. The host never infers this — a machine that goes
quiet every night and one that died at night look identical from here.
`200 {"name", "intermittent"}` · `404` · `422`.

### GET /api/nodes/{name}/processes/{pid}

**Access:** viewer

Full detail for one process, fetched **from the agent** (one report interval
of latency). Query `extras`: comma-separated `files`, `threads` to include
open files and per-thread rows (expensive, off by default).

`pid`, `name`, `exe`, `cmdline`, `cwd`, `username`, `status`, `ppid`,
`create_time`, `num_threads`, `num_handles`, `priority`, `cpu_times{}`,
`memory{working_set, private, shared, virtual, text, pss, swap_pss}`,
`io{}`, `run_delay_total_ms`, `wchan`, `cgroup`, `oom_score`, `container`,
`unit{name, manager, cgroup, process_count, cpu_quota_pct, io_weight, throttled}`,
`parent`, `children[]`, `connections[]`, `environ_count`, `open_files`,
`threads`, `extras_loaded[]`, `cpu_avg`, `cpu_peak`, `stuck`.

`404` no such agent or pid · `409` agent revoked · `504` agent did not answer.

### GET /api/nodes/{name}/actions/{action_id}

**Access:** viewer

Progress and verdict of an action taken on this node (`verify_id` from an
action's response). Poll it until `done`.

```jsonc
{"id": 41, "node": "web-01", "action": "terminate", "pid": 4123, "name": "rsync",
 "started": 1789731408.2, "done": true,
 "verdict": {"outcome": "helped", "elapsed": 41, "text": "…one sentence…", "note": null},   // null until done
 "progress": {"samples": 20, "of": 20, "elapsed": 41.0,
              "pressures": {"disk": {"before": 0.82, "now": 0.11}},
              "cleared": ["psi_io"], "watching": ["Storage is making programs wait"]}}
```

Outcomes — process actions: `helped` · `partial` · `no_change` · `moot` ·
`unknown`; unit actions from the Outage Doctor: `fixed` · `recurred` ·
`partial` · `no_change` · `moot` · `unknown`; from the Pulse: `came_back` ·
`still_quiet` · `went_quiet_again` · `partial` · `moot` · `unknown`. Watches
are kept 15 minutes; after that the verdict is in `/api/history/actions`. `404`.

## Process actions

### How a command reaches an agent

Agents open no port. The host queues the command, the agent collects it in the
response to its next report, runs it with the same guarded functions the
dashboard would (never PID 1, kernel threads, critical system processes, or
the agent itself) and posts the result back — about one report interval,
usually well under a second. The request blocks until then, up to
`min(45, max(8, 2 × interval + 3))` seconds, then `504`.

All actions sit behind the agent's own `allow_process_actions` switch; an agent
that has it off refuses, and the refusal comes back as the error. Process
actions return the agent's result plus **`verify_id`**: the host snapshots the
node's diagnosis before the action and watches the next ≥ 20 diagnoses / ≥ 30 s
to say whether it helped (`GET /api/nodes/{name}/actions/{id}`).

### POST /api/nodes/{name}/processes/{pid}/terminate

**Access:** operator

| Body | | |
|---|---|---|
| `confirm` | bool | must be `true` (`400` otherwise) |
| `force` | bool | `false`: SIGTERM · `true`: SIGKILL (`TerminateProcess` on Windows) |

### POST /api/nodes/{name}/processes/{pid}/priority

**Access:** operator

Body `{"level": "…"}` — `idle` (nice 19) · `below_normal` (10) · `normal` (0) ·
`above_normal` (−5) · `high` (−10). An unprivileged agent can only lower
priority.

### POST /api/nodes/{name}/processes/{pid}/throttle

**Access:** operator

Cap the CPU and IO of the **whole systemd unit or container scope** the process
runs in (`systemctl set-property --runtime`: `CPUQuota` scaled by core count so
it means a share of the machine, plus `IOWeight`; a Job Object on Windows). Body
`{"level": "half" | "quarter" | "release"}`. Runtime only — gone at the unit's
restart. `422` unknown level.

### POST /api/nodes/{name}/processes/{pid}/truncate

**Access:** operator

Free the space a **deleted-but-still-open** file holds, through the holder's
own descriptor. The agent refuses unless the file is still deleted (link count
0), regular, and the one named — a live file is never truncated.

| Body | | |
|---|---|---|
| `path` | string | absolute, ≤ 4096; as listed in the volume's `held[]` |
| `confirm` | bool | must be `true` |

### POST /api/processes/{pid}/terminate

**Access:** viewer

Always `410`. The host is not a monitored node and exposes no action against
its own processes; kept so an old client gets a clear answer.

### POST /api/processes/{pid}/priority

**Access:** viewer

Always `410`, as above.

## Unit actions

### POST /api/nodes/{name}/units/{unit}/{verb}

**Access:** operator

Run `systemctl <verb> <unit>` on the agent (`Restart-Service` and friends on
Windows). `verb` is `restart` · `start` · `reload-or-restart` · `reset-failed`
— there is no `stop`: nothing the doctors report is fixed by stopping
something.

| Body | | |
|---|---|---|
| `confirm` | bool | must be `true` |
| `manager` | string | `system` (default) or `user`; Windows services are `system` only |
| `origin` | string | `outage` (default) or `pulse` — which doctor's items the verdict is watched against |

`unit` must look like a unit name (`…​.service|.socket|.timer|.mount|.path|.target`)
on Linux, or an SCM service name on a Windows node. The agent additionally
refuses `init.scope`, D-Bus, journald, logind, udevd, the slices, `user@*` and
its own unit. The result states the unit's state before and after
(`failed → active (running), pid N`) and carries `verify_id`; the timeout is a
fixed 60 s because a restart may legitimately take the unit's `TimeoutStopSec`.
`422` bad verb, manager, unit or origin · `400` no `confirm`.

## Agent updates and versions

An agent updates itself by `git fetch` + `git reset --hard` in its own
checkout, then restarting — so only an agent running under systemd, from a
clean git checkout with an `origin`, with `allow_remote_update` on, and not in
a container, is `update_capable`. The host decides *whether* an update exists
(one fetch of the published `version.json` for the whole fleet); the agent only
says whether it *can*. The repository is never configurable — an agent pulls
only from its own origin.

### POST /api/nodes/check-updates

**Access:** operator

Ask GitHub now, instead of waiting for the half-hourly check. Floors at a few
seconds so a button cannot become a request per click.

```jsonc
{"published": { … }, "previous": { … }, "changed": false,
 "asked": true,        // false: asked too recently, nothing was fetched
 "reached": true,      // false with asked=true: GitHub did not answer; the last value is kept
 "updatable": ["web-01"],
 "skipped": [{"name": "db-01", "reason": "pinned to v0.20.0-b"}]}
```

### POST /api/nodes/{name}/update

**Access:** operator

Update one agent to the tip of the configured branch and restart it (timeout
120 s). Clears any version pin. `404` · `409` with the node's own reason when
it is not update-capable.

### POST /api/nodes/update-all

**Access:** operator

The same command to every agent that is enabled, online, capable, behind, not
pinned and not containerised — queued together, so the fleet updates in
parallel. `{"targets": […], "results": [{"name", "ok", "result" | "error"}],
"skipped": [{"name", "reason"}]}`.

### POST /api/nodes/{name}/version

**Access:** operator

Move an agent to a chosen version (usually a downgrade). Body
`{"version": "0.20.0-b"}`, resolved to the newest commit that carried it in the
host's mirror of the agent repository. Any version other than the published one
**pins** the node so the schedule and Update all leave it alone.
`{"version", "sha", "pinned", "result"}` · `404` unknown node or version ·
`409` not capable, already on it, or an agent older than 0.20.0-b · `503` the
mirror is unavailable.

### DELETE /api/nodes/{name}/pin

**Access:** operator

Clear the pin without touching the agent. `{"name", "pinned": false}` · `404`.

## History

Rolled-up samples in SQLite (`rollup_seconds` buckets, `retention_days`). Every
route takes `node`; **pass it** — the default is `local`, the host, which
records nothing.

### GET /api/history/series

**Access:** viewer

| Query | Default | |
|---|---|---|
| `node` | `local` | agent name |
| `since` | 6 h ago | epoch seconds |
| `until` | now | |
| `columns` | all | comma-separated subset |

`{"available", "reason", "node", "ts": […], "series": {"cpu_avg": […], …}, "count"}`
— parallel arrays. Columns: `cpu_avg` `cpu_max` `cpu_queue_avg` `cpu_queue_max`
`mem_percent_avg` `mem_available_min` `commit_avg` `commit_max`
`hard_faults_avg` `hard_faults_max` `gpu_avg` `gpu_max` `disk_busy_avg`
`disk_busy_max` `disk_queue_avg` `disk_queue_max` `disk_latency_avg`
`disk_latency_max` `disk_read_avg` `disk_write_avg` `net_recv_avg`
`net_sent_avg` `lag_severity`. A metric the node cannot measure is `null` per
bucket, not `0`.

### GET /api/history/top

**Access:** viewer

Heaviest processes over a window. Query `node`, `since` (6 h), `until`, `limit`
(20, 1–100). `processes[]`: `name`, `buckets`, `cpu_avg`, `cpu_max`, `mem_avg`,
`mem_max`, `io_avg`, `lag_max`, `lag_avg`.

### GET /api/history/processes

**Access:** viewer

The stored process rows of one bucket. Query `ts` (required, a bucket
timestamp from `series`), `node`. `{"ts", "node", "processes": […]}`.

### GET /api/history/findings

**Access:** viewer

Raw stored findings, one row per bucket a finding was active in. Query `node`,
`since` (24 h), `limit` (200, ≤ 1000). Rows: `ts`, `key`, `severity`,
`resource`, `title`, `detail`, `culprits[]`. Includes the Pulse's items under
`pulse:<key>`.

### GET /api/history/incidents

**Access:** viewer

The same rows folded at read time: consecutive buckets of one key become one
incident. Query `node`, `since` (24 h), `limit` (100, ≤ 500). There is no
`until` — clamp on `start` client-side.

```jsonc
{"since": …, "node": "web-01", "bucket_seconds": 60,
 "incidents": [{"id": "…", "key": "psi_io", "resource": "disk", "severity": "warn",
   "title": "…", "detail": "…",
   "start": …, "end": …, "duration_seconds": 840, "ongoing": false,
   "buckets": 14, "peak_ts": …,
   "culprits": [ … ], "lead": { … },          // who led, by bucket count
   "actions": [ … ],                          // what was done meanwhile, with verdicts
   "changes": [{"…", "offset_seconds": -212}]}]}   // what changed in the 10 min before it began
```

### GET /api/history/actions

**Access:** viewer

Actions taken and their verdicts. Query `node` (all nodes when omitted),
`since` (24 h), `limit` (100, ≤ 500). Rows carry who acted — `alice`, or
`alice (key: grafana)` for a script.

### GET /api/history/record

**Access:** viewer

How earlier actions on the same process name or unit went — what the dialogs
show before offering the same action again. Query `node` (required) and `name`
or `unit`; the last 90 days.

```jsonc
{"record": {"terminate": {"tries": 4, "outcomes": {"helped": 3, "no_change": 1},
                          "last_ts": …, "last_outcome": "helped", "last_text": "…",
                          "same_unit": false}},
 "total": 4}
```

An action whose watch has not finished counts under `pending`.

### GET /api/history/events

**Access:** viewer

Stored journal / event-log entries. Query `node`, `since`, `kinds`
(comma-separated), `limit` (300, ≤ 2000). Rows: `ts`, `kind`, `source_key`,
`event_id`, `severity`, `title`, `payload{}`.

### GET /api/history/stats

**Access:** viewer

`{"available", "recording", "path", "size_bytes", "rows": {"samples": …, "findings": …, …}, "oldest", "newest"}`.

## The Pulse

The doctor for *absence*: what stopped happening. Judged on the host once a
minute per node from activity the reports already carry.

### GET /api/pulse

**Access:** viewer

Query `node` (required). `status` is `learning` (with `learning_seconds` and
`checks.baseline.needs_days`) until there is a baseline — never an empty page
implying health.

`{"available", "reason", "node", "generated_at", "enabled", "status", "severity", "count", "items": […], "folded": […], "checks": {"baseline", "sources", "window", "gaps", "suppressed"}, "learning_seconds"}`.
Items are findings (`went_quiet:<kind>:<id>`, `machine_quiet`,
`schedule_overdue|failed|long|overlap|hollow:<timer>`) with `baseline`, `now`,
`runs[]`, `run_stats`, and `actions[]` — the verbs the agent will accept.

### GET /api/pulse/rhythm

**Access:** viewer

Query `node` (required), `kind` (`listener` | `unit` | `machine`), `subject`,
`weeks` (5, 1–5). Without `subject`: the subjects this node has a rhythm for.
With one: the 7 × 24 grid and today. A cell with no buckets is *not observed*,
never zero.

### GET /api/pulse/fleet

**Access:** viewer

`{"nodes": {"web-01": {"status", "severity", "count"}, …}, "ts"}`.

## The Prognosis: wear

The live verdict is the snapshot's `prognosis` section; the host keeps the
daily record behind it.

### GET /api/wear

**Access:** viewer

Query `node` (required), `kind` (`disk` | `memory` | `pci` | `power` | `nic`),
`subject` (serial, controller, BDF, interface), `days` (400, 1–3650). Without a
subject: `{"node", "subjects": […], "ts"}`. With one: its daily rows and, for
endurance, a forecast that always states the days it was fitted over and is
refused below 14 points.

## The Coroner: deaths

How a node died — a machine that went down, or an agent that stopped — judged
from the previous boot's journal, pstore and the agent's flight recorder.

### GET /api/deaths

**Access:** viewer

Query `node`, `since` (90 days), `limit` (50, ≤ 200). Newest first, without
recorder frames: `id`, `node`, `uid`, `kind` (`machine` | `agent`), `died_at`,
`detected_at`, `class`, `severity`, `title`, `verdict{}`.

Classes: `clean_reboot` `clean_poweroff` `kernel_panic` `hardware_error`
`lockup` `hang_memory` `thermal` `hang_io` `abrupt_stop` `agent_oom`
`agent_killed` `agent_crashed` `agent_stopped` `agent_died`. A class is claimed
only from evidence in the record; *stopped without warning* (`abrupt_stop`) is
the honest default, never a guess between power loss and a lockup.

### GET /api/deaths/{death_id}

**Access:** viewer

One death in full: the list fields plus `verdict{summary, because[], context[],
unverified[], cause, confidence, host{}}`, `evidence{journal, boots, markers[],
tail[], pstore, packages[], notes[], agent}` and `recorder{window_seconds,
fast{}, proc[]}` — the last minutes of metrics before it died. `404`.

## The Map

Who talks to whom across the fleet, joined at read time from the nodes' own
socket and listener tables. Entirely passive: nothing here sends a probe.

### GET /api/map

**Access:** viewer

`{"ts", "nodes": […], "edges": […], "external": […], "chains": […], "coverage": {…}}`.
An edge is one (client node, client process, target node, port), counted from
the client side: `from`, `from_name`, `from_unit`, `from_pid`, `to`, `to_port`,
`to_name`, `to_unit`, `to_pid`, `listening`, `connections`, `send_bytes_sec`,
`recv_bytes_sec`, `rtt_ms`, `rtt_min_ms`, `retrans_total`, `retrans_sec`,
`tx_queue`, `rx_queue`, `stalled`, `health{}` (the target's findings and the
client kernel's own signs), `node_severity`. `chains` states "depends on a
service under a finding" — and "is feeling it" only with client-side signs.

### GET /api/map/radius

**Access:** viewer

Who would feel an action on a process. Query `node`, `pid` (required).
`{"node", "pid", "unit", "known", "connections_in", "nodes_in": […], "depended_on_by": […], "depends_on": […]}`.

## Expectations

A finding you expect — the nightly backup saturating the disk — marked so it
reads as `info` with your reason and does not notify, while still being
recorded.

### GET /api/expectations

**Access:** viewer

`{"expectations": [{"id", "node", "key", "culprit", "reason", "days", "start", "end", "created_by", "created_at"}]}`.

### GET /api/expectations/suggested

**Access:** viewer

Query `node` (required). Findings that recurred at the same time of day on ≥ 3
distinct days within a 90-minute band over the last 14, led by the same
process, and not already covered. A person still decides.

### POST /api/expectations

**Access:** operator

| Body | | |
|---|---|---|
| `node` | string | an agent name, or `*` for every node |
| `key` | string | the finding key (`psi_io`, `space_/home`, `pulse:went_quiet:unit:x.service`) |
| `culprit` | string \| null | only when led by this process name |
| `reason` | string | required; shown beside the finding |
| `days` | int[] | weekdays, `0` = Monday … `6` = Sunday; empty = every day |
| `start`, `end` | `"HH:MM"` | both or neither; host-local; may wrap midnight |

`200 {"ok": true, "id", …cleaned fields}` · `422 {"ok": false, "field_errors": {…}}` ·
`409` at 200 expectations.

### DELETE /api/expectations/{expectation_id}

**Access:** operator

`200 {"ok": true, "id"}` · `404`.

## Notifications

### GET /api/notify/status

**Access:** viewer

`{"sent", "failed", "dropped", "last_sent", "last_error", "last_title", "channels": […], "active_findings", "queue"}`.

### POST /api/notify/test

**Access:** admin

Send a test message on every configured channel (ntfy, webhook, SMTP) and
report each channel's result.

## Settings

### GET /api/settings

**Access:** viewer

```jsonc
{"config": { …every setting…, "version": "0.54.0-b",
             "notify_smtp_password": "", "notify_smtp_password_set": true,   // secrets are write-only
             "oidc_client_secret": "",  "oidc_client_secret_set": false,
             "history_enabled": true, "history_error": null},
 "limits": {"interval_fast": [0.25, 60.0], …},      // [min, max] per numeric setting
 "editable": ["interval_fast", …],                  // what PUT accepts
 "access": {"peer", "client", "via_proxy", "host", "scheme", "runtime_proxies", "always_hosts"}}
```

`access` describes how *this request* reached the host — what the Network
trust panel shows. Host, port and database path are not editable over the API.

### PUT /api/settings

**Access:** admin

A patch: any subset of `editable`. Query `persist` (default `true`; `false`
applies to the running host without writing `config.json`).

`200 {"ok": true, "persisted", "config"}` ·
`422 {"ok": false, "field_errors": {"cpu_high": "must be between 1 and 100"}, "errors": […], "config"}`.

- The two secrets are write-only: `""` leaves one as it is, `null` clears it.
- A patch to `trusted_proxies` / `trusted_hosts` that would refuse the very
  connection saving it is rejected as a field error, as is `oidc_enabled: false`
  from an account that can only sign in through the provider.

### POST /api/oidc/test

**Access:** admin

Settings › Sign-in's *Check issuer*: fetch the provider's discovery document
and report the endpoints found (or why not) plus the redirect URI this host
will present. `{"ok", "redirect_uri", "configured", "missing": […], …}` or
`{"ok": false, "error", "redirect_uri"}`. No secret is involved.

## Patch notes and port names

### GET /api/changelog

**Access:** viewer

The commit log as a change log, grouped by the version each commit landed in.
Query `repo` (`host` | `agent` | `agent-windows`, default `host`), `branch`
(default: the running branch / the configured update branch).

`{"available", "reason", "repo", "branch", "running", "running_branch" | "configured_branch", "current", "tip", "fetched_at", "stale_reason", "commits": [{"sha", "short", "ts", "subject", "type", "scope", "breaking", "summary", "body", "version", "bumped_to"}]}`.
`available: false` with a reason on a host without a git checkout (the
container image) or without the agent mirror. `422` bad branch name.

### GET /api/changelog/branches

**Access:** viewer

Query `repo` (default `agent`), `refresh` (fetch first if older than a minute).
`{"available", "reason", "repo", "branches": […], "hidden": […], "default", "running", "fetched_at", "stale_reason"}`.

### GET /api/portnames

**Access:** viewer

`ports.json`: `{"tcp": {"443": {"name": "https", "desc": "…"}, …}, "udp": {…}}`.
A hint about a number, never a claim about the process behind it.

## Live stream and host status

### GET /api/stream

**Access:** viewer

Server-Sent Events (`text/event-stream`). Works with an API key from any client
that can set a header (`curl -N -H "Authorization: Bearer …"`).

| Event | When | Data |
|---|---|---|
| `snapshot` | once, on connect | the host's state: `config`, `auth`, `nodes`, `elevated` |
| `nodes` | whenever any agent reports, or a node is changed | the `nodes` array of `/api/nodes` |
| `: keepalive` | every 15 s of silence | an SSE comment; not dispatched |

The stream carries *node status*, not node metrics: to follow one machine,
poll `GET /api/nodes/{name}/snapshot` at its `report_interval`, which is what
the dashboard does.

### GET /api/snapshot

**Access:** viewer

The host's cold-start state, the same object as the stream's first frame:
`config`, `auth{enabled, username, role}`, `nodes[]`, `elevated`, `warm`.

### GET /api/status

**Access:** viewer

The host process's own cost: `{"warm", "warmup_stage", "elevated", "overhead": {"pid", "cpu_percent", "working_set", "threads", "uptime_seconds"}, "sampler", "config"}`.

### GET /api/healthz

**Access:** public

Liveness for a load balancer or container health check:
`{"ok": true, "warm": true, "stage": "Ready"}`. Says nothing about the fleet —
use `/api/fleet` for that.

### GET /api/openapi.json

**Access:** viewer

The OpenAPI 3 schema, with the `apiKey` (bearer) and `session` (cookie)
security schemes.

### GET /api/docs

**Access:** viewer

Swagger UI over that schema. **Authorize** takes an API key; a key entered
there is used instead of your session for the calls you try.

## Host-local reads (legacy)

These serve the *host's own* sampler store. The host stopped monitoring itself
— it aggregates agents — so they answer with an empty or "not sampled yet"
shape. They remain for old clients. **Read a node's snapshot instead**; the
section named in each row is where the data lives now.

### GET /api/processes

**Access:** viewer

→ snapshot `process_table`. Answers `{"processes": [], "totals": {}, "warm": true}`.

### GET /api/processes/{pid}

**Access:** viewer

Always `410`. → `GET /api/nodes/{name}/processes/{pid}`.

### GET /api/diagnosis

**Access:** viewer

→ snapshot `diagnosis`.

### GET /api/services

**Access:** viewer

→ snapshot `services`.

### GET /api/events

**Access:** viewer

→ snapshot `events`.

### GET /api/sync

**Access:** viewer

→ snapshot `sync`.

### GET /api/network

**Access:** viewer

`{"rates", "detail"}` → snapshot `network` and `network_detail`.

### GET /api/ports

**Access:** viewer

→ snapshot `ports`.

### GET /api/storage

**Access:** viewer

`{"volumes", "activity"}` → snapshot `volumes` and `disk`.

### GET /api/live

**Access:** viewer

The host's in-memory ring for live sparklines. Query `keys` (comma-separated;
`400` lists the valid ones). `{"ts": [], "series": {…}, "window_seconds"}` —
empty on an aggregating host.

## Pages and static files

### GET /

**Access:** viewer

The dashboard shell. Without a session: `303` to `/login`.

### GET /login

**Access:** public

The sign-in page.

### GET /favicon.svg

**Access:** public

### GET /assets/{path}

**Access:** public

The dashboard's JavaScript and CSS — code, not data; the same files as the
public repository. Served with revalidation forced.

---

## Recipes

**An uptime / status monitor** (Uptime Kuma, a cron job): `GET /api/fleet` with
a `viewer` key. Alert when a node has `online: false` and not `intermittent`,
or `status` is `critical`.

```bash
curl -fsS -H "Authorization: Bearer $KEY" $HOST/api/fleet \
  | jq -e '[.nodes[] | select((.online | not) and (.intermittent | not))] | length == 0'
```

**Grafana** (Infinity / JSON API data source): add the header
`Authorization: Bearer ck_…`, then chart `/api/history/series?node=web-01&columns=cpu_avg,mem_percent_avg`
— `ts` and each series are parallel arrays.

**Home Assistant** (RESTful sensor):

```yaml
sensor:
  - platform: rest
    name: web-01 status
    resource: http://culprit.lan:8787/api/fleet
    headers: { Authorization: "Bearer ck_…" }
    value_template: "{{ (value_json.nodes | selectattr('name','eq','web-01') | first).status }}"
    scan_interval: 30
```

**What is wrong right now, fleet-wide:**

```bash
for n in $(curl -s -H "Authorization: Bearer $KEY" $HOST/api/nodes | jq -r '.nodes[] | select(.online) | .name'); do
  curl -s -H "Authorization: Bearer $KEY" $HOST/api/nodes/$n/snapshot \
    | jq -r --arg n "$n" '.diagnosis.findings[] | select(.severity != "info") | "\($n)\t\(.severity)\t\(.title)\t\(.culprits[0].name // "-")"'
done
```

**Restart a failed unit and wait for the verdict** (an `operator` key):

```bash
ID=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d '{"confirm": true}' $HOST/api/nodes/web-01/units/nginx.service/restart | jq .verify_id)
until curl -s -H "Authorization: Bearer $KEY" $HOST/api/nodes/web-01/actions/$ID | jq -e .done >/dev/null; do sleep 10; done
curl -s -H "Authorization: Bearer $KEY" $HOST/api/nodes/web-01/actions/$ID | jq .verdict
```

**Follow node status without polling:**

```bash
curl -N -H "Authorization: Bearer $KEY" $HOST/api/stream
```

**Rotate a key:** create the new one (Settings, or `POST /api/account/keys`
from a session), deploy it, watch the old key's `last_used` stop moving, then
revoke the old one.
