# Security Policy

Culprit is a self-hosted dashboard that reads privileged system state and can
terminate processes, so we take its security seriously. Thank you for helping
keep it and its users safe.

## Reporting a vulnerability

**Please report security issues privately. Do not open a public issue, pull
request, or discussion for a suspected vulnerability.**

Use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**
   (<https://github.com/OlaYZen/culprit/security/advisories/new>).
3. Fill in the advisory form with the details below.

This opens a private channel visible only to the maintainers, where we can
discuss, fix, and coordinate disclosure with you.

If for any reason you cannot use the form, open a minimal public issue that
says only "requesting a private security contact" with no technical detail, and
a maintainer will reach out.

### What to include

The more of this you can provide, the faster we can confirm and fix it:

- A clear description of the issue and the impact you believe it has.
- The component: the **host** (dashboard, API, auth) or the **agent**, and the
  version or commit.
- Step-by-step reproduction, ideally with a minimal proof of concept.
- The deployment shape: bound address, whether TLS or a reverse proxy is in
  front, and whether authentication was enabled.
- Any logs or output that help, with secrets redacted.

## Our commitment

- We aim to **acknowledge** a report within **3 business days**.
- We aim to provide an initial assessment within **7 business days**.
- We will keep you updated as we work on a fix, and we will credit you in the
  advisory and release notes unless you prefer to stay anonymous.
- We follow **coordinated disclosure**: we ask that you give us a reasonable
  window to release a fix before any public disclosure, and we will do the same.

## Supported versions

Culprit is developed on a rolling basis. Security fixes land on the default
branch (`main`), and that is the only supported version. Please reproduce
against the latest `main` before reporting, and update to it to receive fixes.

| Version | Supported |
|---|---|
| `main` (latest) | Yes |
| older commits / tags | No |

## Scope

**In scope** includes, for example:

- Authentication or session bypass on the dashboard or its API.
- Agent token forgery, replay, or the acceptance of an unauthorized report.
- Remote code execution, command injection, path traversal, or SSRF.
- Privilege escalation beyond what the operator granted the process.
- Sanitiser bypass in the report ingest path (a crafted report that crashes the
  host, poisons another node's data, or escapes the section allow-list).
- Stored or reflected injection reaching another user's browser.
- Sensitive data disclosure (credential hashes, tokens, another node's data).

**Out of scope** includes:

- Findings that require a configuration the documentation explicitly warns
  against, such as exposing a plain-HTTP host to an untrusted network. Culprit
  ships authenticated by default, refuses to bind a public address while it has
  zero users, and documents running TLS off a trusted LAN; a report must show a
  break of the documented, hardened configuration.
- Denial of service that requires already-authenticated access or physical or
  root access to the host.
- Missing security headers or best practices with no demonstrated impact.
- Reports generated solely by automated scanners without a working proof of
  concept.
- Social engineering, and attacks on third-party infrastructure (GitHub, the
  container registry, a user's operating system).

## Hardening reminders for operators

Culprit is designed to be safe by default, and it is worth knowing why:

- **Authentication is always on.** A fresh install creates an `admin` / `admin`
  account and warns you to change it. Change it immediately.
- **It refuses to bind a public address while it has zero users**, so an open
  dashboard with a kill button cannot become network-reachable by accident.
- **Run TLS off a trusted LAN.** Plain HTTP exposes tokens and cookies. Use
  `--ssl-certfile/--ssl-keyfile` or a reverse proxy, and point agents at
  `https://`.
- **Reverse proxies are refused until declared** under Settings, so a forged
  forwarding header cannot spoof the address the login limiter keys on.
- **Credentials are never stored in plaintext.** The database holds scrypt
  password hashes and SHA-256 token hashes and is `chmod 600`.

The repository also ships a suite of security tools
(`tools/audit_security.py`, `tools/check_security.py`, `tools/check_auth.py`,
`tools/check_ingest.py`). Run them before exposing a host and through any proxy
you place in front of it; a CRIT or HIGH finding fails their exit status so they
can gate a deploy.
