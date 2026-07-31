# Security policy

This repository is public and the application it builds handles personal data:
candidate profiles, CVs, mentor notes. We would much rather hear about a problem
from you than read about it later.

The security *model* — what protects what — is documented further down, under
[Security overview](#security-overview).

## Reporting a vulnerability

**Please do not open a public issue.** That discloses the problem to everyone
before a fix exists, including to anyone running their own copy of this
AGPL-licensed code.

Use **GitHub's private vulnerability reporting** instead:

> Repository → **Security** tab → **Report a vulnerability**

It opens a private thread with the maintainers, needs no separate account or
email address, and keeps the whole exchange in one place until a fix is out.

Useful things to include, roughly in order:

- what an attacker can actually do with it — the impact, not just the pattern
- steps to reproduce, and which role you were signed in as (`ADMIN`, `MENTOR`,
  `MENTEE`, `COMPANY`, `SOURCE`)
- the affected endpoint or file, if you know it
- whether the response *status* looked normal. Our most serious finding to date
  returned `200` on every request — the leak was in the rows that came back.

## Supported versions

This project deploys continuously: every merge to `main` lands on production
(`crm.ersah.in`) and preview (`crm-preview.ersah.in`). There are no maintained
release branches, so **only the current `main` is supported**. Fixes ship as a
new version rather than as backports.

## What to expect

| | Target |
|---|---|
| First response | within 5 working days |
| Assessment and severity | within 10 working days |
| Fix for a critical issue | as soon as it is ready — production deploys on merge |

We will tell you when the fix is live. If we disagree that a report is a
vulnerability we will say so plainly and explain why, rather than letting the
thread go quiet.

## Scope

**In scope** — the application code in this repository, and the deployments at
`crm.ersah.in` and `crm-preview.ersah.in`.

**Out of scope**

- Known CVEs in third-party dependencies. Those are tracked through `npm audit`
  and its CI gate; telling us a dependency has a published advisory tells us
  nothing we don't have. Showing that one is *exploitable through this
  application* is very much in scope.
- Automated-scanner output with no demonstrated impact.
- Missing hardening headers or best practices with no path to exploitation.
- Social engineering of maintainers or users.

## Please do not

- **Run load or denial-of-service tests against the live environments.** One
  small server sits behind both; a stress test is indistinguishable from an
  outage.
- **Access, modify, or download real user data.** If a proof of concept needs
  someone's record, stop once you have demonstrated access and describe the
  rest. Our own contributors are held to this — see
  [`docs/DATA_ACCESS_POLICY.md`](docs/DATA_ACCESS_POLICY.md), which keeps
  developers off real PII entirely — and the same line applies to researchers.
- **Point automated scanners at production.** Ask, and we will point you at an
  environment where it is fine.

Work inside these lines is welcome, and we will not pursue anyone who reports in
good faith and follows this policy.

## Credit

We are glad to name you in the changelog entry for the fix. Tell us how you'd
like to be credited — or that you'd rather not be — when you report.

---

# Security overview

This document summarizes the security model of Internship CRM and the controls
added in the security-hardening epic (#182).

## Authentication
- **NextAuth (Credentials)** with JWT sessions. Passwords hashed with **bcrypt** (cost 12).
- **Password policy** (`src/lib/password.ts`): min 8 chars, at least one upper- and one lower-case letter. Enforced on register, reset and password change.
- **No user enumeration**: sign-in returns a single generic *“Invalid email or password”* for both unknown email and wrong password.
- **Brute-force throttle**: failed logins are counted per email (10 / 15 min); successful logins reset the counter. Failed attempts are written to the activity log (`auth.login_failed`).
- **Email verification**: unverified accounts are read-only (write APIs blocked by `src/middleware.ts`).
- **Deactivation**: admins can disable accounts; inactive users cannot sign in.

## Re-authentication for sensitive actions
- Changing **email**, changing **password**, and **deleting the account** all require the current password (`/api/account`).
- Impersonation (`/api/admin/impersonate`) is ADMIN-only, single-use grant based, audited, and cannot be used to delete the impersonated account.

## Authorization (RBAC + ownership)
Every API route checks the session and the appropriate role; resource routes additionally verify ownership to prevent IDOR:

| Area | Rule |
|------|------|
| `/api/admin/*`, `/api/users`, `/api/candidates`, `/api/search`, `/api/status-changes`, `/api/invite`, `/api/companies` | ADMIN only |
| `/api/mentorship/[id]`, `/api/interactions[/id]`, `/api/meetings` | ADMIN **or** the mentor who owns the relation |
| `/api/cv/[userId]`, `/api/avatar` | owner, ADMIN, or the mentee’s mentor (`src/lib/cvAccess.ts`) |
| `/api/profile`, `/api/account[/export]`, `/api/notifications` | the authenticated user, scoped to their own data |
| `/api/apply`, `/api/rsvp`, `/api/auth/*`, `/api/profile-view` | public by design (unguessable token or anti-enumeration) |

## Rate limiting
`src/lib/rateLimit.ts` (in-memory, per-process fixed window) guards auth and public endpoints: forgot, reset, register, apply, rsvp, and login. Returns **429** with `Retry-After` when exceeded. For a multi-instance deployment, back this with Redis.

## HTTP security headers
Set for all routes in `next.config.js`: Content-Security-Policy (self by default), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and HSTS.

## Auditing & privacy
- **Activity log** (`ActivityLog`) records auth events, profile/stage changes, account email/password change and deletion, impersonation, and failed logins. Viewable by admins at `/admin/activity`.
- **Data export** (`/api/account/export`) lets a user download all their own data; **consent** is recorded at registration; see `/privacy`.

## Inbound email (reply-by-email)
Mentor↔mentee threads accept replies by email. Outgoing thread emails set
`Reply-To: reply+<relationId>.<hmac>@<domain>` where the HMAC is signed with
`NEXTAUTH_SECRET` (unguessable, tamper-evident). A mail bridge (IMAP poller or
provider inbound webhook) POSTs parsed mail to `POST /api/inbound-email`
(`{to, from, text}`). The endpoint accepts a message **only if** the reply
token's HMAC verifies **and** the sender address is a participant of that
thread; quoted history is stripped. Set `INBOUND_SECRET` (and have the bridge
send it as `X-Inbound-Secret`) for defense-in-depth, and `INBOUND_EMAIL_DOMAIN`
to your mail domain. Ideally the mail server enforces SPF/DKIM before forwarding.
