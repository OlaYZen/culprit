<!--
Thanks for contributing to Culprit. Please fill in the sections below.
For security issues, do NOT open a pull request; see SECURITY.md.
-->

## Summary

<!-- What does this change do, and why? -->

## Related issue

<!-- e.g. Fixes #123 / Closes #123, or "n/a" -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor, build, or tooling
- [ ] Other (describe above)

## How I tested it

<!--
Which verification tools you ran and the result, plus the machine (OS/kernel,
container or bare metal). There is no unit-test suite by design.
-->

## Checklist

- [ ] `pyflakes` is clean (`.venv/bin/python -m pyflakes culprit tools`)
- [ ] I ran the relevant verification tools (smoketest, check_frontend, check_contract, audit_security, check_auth, and check_security / check_ingest for auth or ingest changes)
- [ ] If I added or renamed a payload field, I updated `tools/check_contract.py`
- [ ] If I touched auth, the report sanitiser, or the response hardening, I updated the matching security tool in the same change
- [ ] If I changed shared collector code, I noted that it needs syncing to the agent bundle
- [ ] The frontend stays build-free (no npm, bundler, or CDN) and escapes values put into HTML
- [ ] My commits use conventional commit style, one logical change each
- [ ] I read CONTRIBUTING.md and agree to license my work under GPL-3.0
