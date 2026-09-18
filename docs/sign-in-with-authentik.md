# Sign in with Authentik — a worked example

The [README](../README.md#sign-in-with-authentik) explains what Culprit does
with an OpenID Connect provider and why. This page is the same thing done
once, end to end, with every value written out. The names are made up; swap
in your own.

| What | In this example |
|---|---|
| Culprit, as the browser reaches it | `https://culprit.example.com` |
| Authentik | `https://auth.example.com` |
| The application slug in Authentik | `culprit` |
| The person signing in | Authentik user `ada`, e-mail `ada@example.com` |
| Her existing Culprit account | `ada`, role `operator` |

Culprit needs three things from Authentik: an **issuer URL**, a **client ID**
and a **client secret**. Authentik needs one thing from Culprit: the **redirect
URI**. Everything else is deciding who gets an account.

## 1. Copy the redirect URI from Culprit

Open Culprit the way your users will — through the proxy, under the public
name — and go to **Settings › SSO**. The bottom of the page shows the
redirect URI for that host:

```
https://culprit.example.com/api/auth/oidc/callback
```

Copy it from there rather than typing it. Authentik matches it strictly, so
`http://` against `https://`, a different host name, or a stray trailing slash
each earn a *Redirect URI Error* page from Authentik before Culprit ever hears
about the sign-in.

## 2. Create the provider in Authentik

**Applications › Providers › Create › OAuth2/OpenID Provider.**

| Field | Value |
|---|---|
| Name | `Culprit` |
| Authorization flow | `default-provider-authorization-implicit-consent` (or the explicit-consent one if you want a consent screen) |
| Client type | **Confidential** |
| Client ID | leave generated, e.g. `3kYb9ZtQm0Wx7PcHn2VdRfLs8JgEaUo4Ti1Bq6Ny` |
| Client secret | leave generated — a 128-character string you will paste into Culprit once |
| Redirect URIs | one entry, **Strict**, `https://culprit.example.com/api/auth/oidc/callback` |
| Signing key | `authentik Self-signed Certificate` (any key; one must be set) |
| Scopes | `openid`, `email`, `profile` |
| Subject mode | `Based on the User's hashed ID` (the default) — **do not change it later** |

Leave the subject mode alone once anyone has signed in. Culprit hangs every
link on that subject, and changing the mode turns every linked person into a
stranger.

### The `email` scope needs a verified flag

Culprit will only claim an account by e-mail when the provider marks the
address **verified**. Authentik's built-in `email` scope mapping returns
`email_verified: false` for everyone in current versions, so a sign-in that
should claim an account is refused with *"The provider does not vouch for that
e-mail address"* while Authentik's own log shows the flow succeeding.

Fix it with a scope mapping of your own, **Customization › Property Mappings
› Create › Scope Mapping**:

| Field | Value |
|---|---|
| Name | `email — verified` |
| Scope name | `email` |
| Expression | see below |

```python
return {
    "email": request.user.email,
    "email_verified": True,
}
```

Then on the Culprit provider, under *Advanced protocol settings › Scopes*,
**replace** the built-in `authentik default OAuth Mapping: OpenID 'email'` with
`email — verified`. Two mappings for the same scope is one too many. This tells
Culprit that every address in Authentik is trustworthy, which is right when an
administrator sets them and wrong when people can register with any address
they like — in that case, skip the mapping and use *Create an account on first
sign-in* with an e-mail domain list instead, or link people by hand.

## 3. Create the application in Authentik

**Applications › Applications › Create.**

| Field | Value |
|---|---|
| Name | `Culprit` |
| Slug | `culprit` — this becomes part of the issuer URL |
| Provider | `Culprit` |
| Launch URL | `https://culprit.example.com/` |

The issuer URL Culprit wants is now:

```
https://auth.example.com/application/o/culprit/
```

With the trailing slash. Culprit appends `.well-known/openid-configuration` to
it and reads the endpoints from there.

Authentik's application **policy bindings** decide who may use the
application at all. Binding a group here is the right place to keep the
neighbours out; Culprit only decides what happens to people Authentik lets
through.

## 4. Fill in Culprit's SSO page

**Settings › SSO**, signed in as an admin:

| Field | Value |
|---|---|
| Offer it on the login page | on |
| Button label | `Authentik` — the login page shows *Continue with Authentik* |
| Issuer URL | `https://auth.example.com/application/o/culprit/` |
| Client ID | `3kYb9ZtQm0Wx7PcHn2VdRfLs8JgEaUo4Ti1Bq6Ny` |
| Client secret | the generated secret, pasted once |
| Scopes | `openid profile email` |
| Create an account on first sign-in | off — see step 5 |

**Save changes**, then **Check issuer**. It reads the *saved* issuer's
discovery document and lists the endpoints it found; before the first save it
reports that no issuer is configured, which is not an error. The secret is
written to `config.json` (mode `600`) and never shown again; leaving the field
blank on later saves keeps it.

## 5. Decide who gets an account

Nothing signs in yet. Culprit has to know which account a provider identity
opens, and there are three ways, from most to least restrictive.

**Link an existing account by e-mail** (the default posture). In **Settings ›
Users**, next to `ada`, enter `ada@example.com` under *SSO*. The row shows
`pending · ada@example.com`. The first time Ada signs in through Authentik with
that address marked verified, her identity claims the account and the row
changes from pending to linked. From then on the link is by subject, and the
e-mail is never re-checked.

**Let people connect their own account.** Anyone signed in with a password can
go to **Account › Sign-in** and connect an Authentik identity to their own
account. It asks for their current password first.

**Create accounts on first sign-in.** Turn the switch on, pick the role new
accounts get (`viewer` unless you have a reason), and optionally list the
e-mail domains allowed, one per line. Someone Authentik vouches for who has no
account here then gets one on the spot, without a password. Off by default
because with an issuer anyone can register at, this lets anyone in as a
viewer; gate the application on Authentik's side before turning it on.

## 6. Sign in

Sign out, and the login page shows **Continue with Authentik** under the
password form. Pressing it goes to Authentik, comes back to the redirect URI,
and opens Ada's account. The host log shows:

```
culprit.auth: oidc login ok: ada (sub 9f2c…e41a) from 203.0.113.7
```

Culprit's *Sign out* clears its own session only; Authentik's session stays,
so the next *Continue with Authentik* is instant.

## If it does not work

Every failure comes back to the login page as one fixed sentence; the
provider's own text never does. The ones you will meet during setup:

| The login page says | What is wrong |
|---|---|
| *The provider could not be reached, or its configuration is not what this host expects.* | The issuer URL: a missing trailing slash, the wrong slug, or Authentik unreachable from the **host** (Culprit fetches discovery and tokens itself, so the host needs a route to Authentik, not only your browser). |
| *The provider refused to exchange the sign-in code.* | Wrong client secret, or a client ID that belongs to another provider. Authentik logs `Invalid client secret` against the provider. |
| *No account here is linked to that identity, and this host does not create accounts on first sign-in.* | Working as intended: nothing in step 5 matched. Pre-link the e-mail, connect from Account, or turn on account creation. |
| *The provider does not vouch for that e-mail address, so it cannot claim an account here.* | `email_verified` came back false. Do the scope mapping in step 2. Authentik's log shows a clean flow, which is what makes this one confusing. |
| *That identity is already linked to another account.* | The subject is linked to a different Culprit user. Unlink it there first. |
| Authentik shows **Redirect URI Error** and Culprit never sees anything | The redirect URI in the provider is not exactly what Culprit's SSO page shows. |

Two log lines answer most of the rest. Culprit's host, at `WARNING`, names the
refusal code: `oidc login refused (email_unverified) for sub …`. Authentik's
server log, `docker logs authentik-server-1`, shows each `/application/o/authorize/`,
`/application/o/token/` and `/application/o/userinfo/` request with its status,
so you can see exactly how far a sign-in got before Culprit refused it.
