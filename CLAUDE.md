# CLAUDE.md — the `demo` branch

This branch is the GitHub Pages site, not the product. Pages serves the root
of this branch as-is: `index.html`, `favicon.svg`, `assets/`. The product's
code, its verification tools and its CLAUDE.md live on `main`; this branch is
never merged into `main`, and `main` is never merged into it — it is
*refreshed* from `main` by `tools/build_demo.py`.

## Layout

- `assets/css`, `assets/js` (everything except `js/demo/`), plus
  `assets/portnames.json` (main's `ports.json`) and `assets/version.json`: a
  verbatim copy from `main`. **Never edit these here.** Fix the frontend on
  `main`, then run `python3 tools/build_demo.py` on this branch to pull the
  change in.
- `assets/js/demo/`: the in-browser stand-in for the host — `boot.js` (loaded
  by `index.html` before `app.js`; module scripts run in document order),
  `index.js` (installs the `fetch`/`EventSource` stand-ins synchronously, each
  call waits for the fixtures), `data.js` (loads `../../demo/data/`, the two
  root files and `deaths.json` relative to `import.meta.url`, and time-shifts
  epochs under known keys plus the recorder rows' first column), `world.js`
  (the living fleet, the scripted `psi_cpu` incident on `media`, the memory
  forecast, process and unit actions with their verdict watches, the users,
  the agents' update state, the deaths), `outage.js` (the Outage Doctor per
  node: unit state the items are derived from, `systemctl` semantics for the
  verbs, the checks strip read from the recorded sections), `map.js` (the
  fleet map's edges, declared and checked against the recording, with the
  chains and the blast radius; `enrichSockets` for the per-process sums),
  `routes.js` (every `/api/*` route with main.py's shapes and error texts).
  This is the only JS that belongs to this branch.
- `assets/demo/data/`: the scrubbed recording (`tools/record_demo.py`) and
  `deaths.json` (`tools/synth_deaths.py`: invented, judged by main's
  `coroner.judge`, prose clock strings replaced with `{{clock}}` for the
  time shift).
- `tools/build_demo.py`: `git archive <ref> web ports.json version.json` →
  `assets/` (keeping `js/demo` and `demo/`), root `index.html` with relative
  paths and the demo script inserted. `tools/record_demo.py`: record + scrub
  from a live host. `tools/synth_deaths.py`: the deaths.

## Rules

- app.js and every other copied file must stay byte-identical to `main`'s;
  demo behaviour goes in `assets/js/demo/` only.
- When a view on `main` starts reading a new payload field (`main`'s
  `tools/check_contract.py` lists them), `world.js` (or `outage.js` /
  `map.js` for those sections) must synthesise it where it builds that
  section, or the demo degrades silently.
- What is invented is labelled as such in the module that invents it, and
  checked against the recording where it can be: a map edge names a process
  that is in the client's table and a port that is in the target's port map,
  or it is dropped; an invented unit also appears in the Services view;
  the checks strip says what the recording said.
- No `innerHTML` in the demo module (main's audit rule); the sticky banner
  saying nothing is live is not optional.
- Fixtures are public: anything re-recorded must be scrubbed and read through
  before it is committed. The deaths are made up end to end, so there is
  nothing in them to scrub — keep it that way.
- Do the branch's file surgery in a git worktree, never in a checkout that a
  running host serves from — `web/` becomes `assets/` here.

## Verifying

Serve the root (`python3 -m http.server 8080`) and, to cover the Pages
sub-path, a parent directory with a symlink named after the repository. In a
headless browser: walk every `.nav__item`, expect zero console errors and
zero `.sk` skeletons after settle, set `window.__culpritDemo.scenario.nextAt
= 0` to bring the incident forward, end ffmpeg from its dialog, and poll
`/api/nodes/media/actions/1` until `done` with outcome `helped`. For the
Outage Doctor: on `edge`, restart `mnt-backup.mount` (the root) and then
`backup-sync.service`, and poll their `verify_id`s until `fixed`; restarting
`recyclarr.service` on `arr` must come back as `recurred`. `POST
/api/nodes/arr/update` takes the node offline for a few seconds and brings
it back on the published version; the Docker nodes refuse with the reason.

Commits follow main's conventions (conventional types and scopes, no
attribution trailers).
