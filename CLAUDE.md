# CLAUDE.md — the `demo` branch

This branch is the GitHub Pages site, not the product. Pages serves the root
of this branch as-is: `index.html`, `favicon.svg`, `assets/`. The product's
code, its verification tools and its CLAUDE.md live on `main`; this branch is
never merged into `main`, and `main` is never merged into it — it is
*refreshed* from `main` by `tools/build_demo.py`.

## Layout

- `assets/css`, `assets/js` (everything except `js/demo/`): a verbatim copy of
  `main:web/`. **Never edit these here.** Fix the frontend on `main`, then run
  `python3 tools/build_demo.py` on this branch to pull the change in.
- `assets/js/demo/`: the in-browser stand-in for the host — `boot.js` (loaded
  by `index.html` before `app.js`; module scripts run in document order),
  `index.js` (installs the `fetch`/`EventSource` stand-ins synchronously, each
  call waits for the fixtures), `data.js` (loads `../../demo/data/` relative to
  `import.meta.url` and time-shifts epochs under known keys), `world.js` (the
  living fleet, the scripted `psi_cpu` incident on `media`, actions, verdict
  watch, expectations), `routes.js` (every `/api/*` route with main.py's
  shapes and error texts). This is the only JS that belongs to this branch.
- `assets/demo/data/`: the scrubbed recording (`tools/record_demo.py`).
- `tools/build_demo.py`: `git archive <ref> web` → `assets/` (keeping
  `js/demo` and `demo/`), root `index.html` with relative paths and the demo
  script inserted. `tools/record_demo.py`: record + scrub from a live host.

## Rules

- app.js and every other copied file must stay byte-identical to `main`'s;
  demo behaviour goes in `assets/js/demo/` only.
- When a view on `main` starts reading a new payload field (`main`'s
  `tools/check_contract.py` lists them), `world.js` must synthesise it where
  it builds that section, or the demo degrades silently.
- No `innerHTML` in the demo module (main's audit rule); the sticky banner
  saying nothing is live is not optional.
- Fixtures are public: anything re-recorded must be scrubbed and read through
  before it is committed.
- Do the branch's file surgery in a git worktree, never in a checkout that a
  running host serves from — `web/` becomes `assets/` here.

## Verifying

Serve the root (`python3 -m http.server 8080`) and, to cover the Pages
sub-path, a parent directory with a symlink named after the repository. In a
headless browser: walk every `.nav__item`, expect zero console errors and
zero `.sk` skeletons after settle, set `window.__culpritDemo.scenario.nextAt
= 0` to bring the incident forward, end ffmpeg from its dialog, and poll
`/api/nodes/media/actions/1` until `done` with outcome `helped`.

Commits follow main's conventions (conventional types and scopes, no
attribution trailers).
