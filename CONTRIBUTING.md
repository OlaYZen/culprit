# Contributing to Culprit

Thanks for your interest in improving Culprit. Bug reports, ideas, docs, and
pull requests are all welcome. This guide covers how the project works and what
a good contribution looks like.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Found a bug or a wrong number?** Open an issue using the templates. For a
  metric that looks incorrect, please include the output of a standard tool
  (`top`, `iostat -x`, `systemctl status`, and so on) so we can see the gap.
- **Have an idea or a question?** Start a discussion (Q&A, Ideas, or Show and
  tell) rather than an issue.
- **Found a security vulnerability?** Do not open a public issue or pull
  request. Report it privately: see [SECURITY.md](SECURITY.md).
- **Want to write code or docs?** Read the rest of this guide, then open a pull
  request. For anything large, please open an issue or discussion first so we
  can agree on the shape before you invest the time.

## The philosophy (please read)

Two principles run through the whole codebase. A change that breaks either of
them will be asked to change, however useful it is otherwise:

1. **Honesty over completeness.** Every optional source degrades to an explicit
   `available: false` plus a `reason`, never a blank panel or a lying zero.
   Missing is never rendered as zero, and a gated source names the exact group
   or capability that would unlock it. If you add a collector, it must degrade
   this way.
2. **Stay lightweight.** The agent depends only on psutil and the standard
   library and opens no ports. The frontend has no build step: vanilla ES
   modules, no npm, no bundler, no CDN. Please keep it that way.

## Development setup

```bash
git clone https://github.com/OlaYZen/culprit.git
cd culprit
./culprit.sh --install-only   # create the venv, install deps, print the matrix
./culprit.sh --run            # run the dashboard in the foreground
```

Create a throwaway user to sign in with:

```bash
.venv/bin/python -m culprit users add dev   # prompts for a password
```

## Before you open a pull request

Run the checks. There is no unit-test suite by design (what breaks here is
environmental and only the real machine reveals it), so these tools are how we
keep the project honest:

```bash
.venv/bin/python -m pyflakes culprit tools     # lint
.venv/bin/python tools/smoketest.py            # every collector on this machine
.venv/bin/python tools/check_frontend.py       # ES-module import graph
.venv/bin/python tools/check_contract.py       # payload fields the views read
.venv/bin/python tools/audit_security.py       # static security checks
.venv/bin/python tools/check_auth.py           # credential logic (offline)
```

If your change touches auth, the report ingest path, or the network trust
rules, also run the live security scans (`tools/check_security.py`,
`tools/check_ingest.py`). Each tool's header comment explains what it proves and
which flags it takes.

## Project-specific rules

These keep the moving parts in sync. A reviewer will look for them:

- **Payload fields.** If you add or rename a field that the frontend reads,
  update `tools/check_contract.py` in the same change, or the UI degrades
  silently.
- **Security invariants.** If you touch authentication (`auth.py`), the report
  sanitiser (`nodes.py`), or the response hardening (`main.py`), update the
  matching security tool (`audit_security.py` / `check_security.py` /
  `check_auth.py`) in the same commit. The tools pin these invariants on
  purpose.
- **Shared collector code.** The agent is a separate, self-contained repo that
  carries a synced copy of the runnable package. If you change shared code (a
  collector, the sampler, `db`/`state`/`config`/`linux`/`util`), note in your PR
  that it needs syncing to the agent bundle (`sync-package.sh`).
- **Frontend.** Canvas charts read colours from CSS custom properties so they
  follow the theme; the process table reconciles rows by PID rather than
  rebuilding. Values put into HTML must be escaped. Keep to the existing
  vocabulary in `web/js/views/shared.js` and `ui.js` rather than ad-hoc markup.

## Commit and pull request style

- Use **conventional commit messages**: `feat:`, `fix:`, `docs:`, `build:`,
  `refactor:`, `chore:`, and so on, with a short imperative subject and a body
  that explains the why.
- Keep each commit to one logical change, and keep pull requests focused.
- Fork the repo, branch off `main`, and open your pull request against `main`.
- Fill in the pull request template and make sure the checks above pass.
- Be responsive to review. We aim to be responsive back.

## License

Culprit is licensed under the [GNU General Public License v3.0](LICENSE). By
contributing, you agree that your contributions are licensed under the same
terms.
