# Security overview

**Last updated: 2026-09-02**

A customer-facing summary of what the internal engineering documents already
prove. Every claim below names the file that backs it, so a reviewer on the
other side of a procurement e-mail can check it against the public repository
rather than take it on trust.

Where something is **not** true yet, this document says so. That is the point of
publishing it.

## Access control

- **Fail-closed authorization by role.** Scoping is resolved through one
  function, `scopeForRole(user, resource)`. A role with no scope builder is
  **denied (403)** rather than falling through to an unfiltered query. The
  previous "allowlist by omission" pattern — where an unnamed role inherited
  admin-level visibility — is what this replaced, after it caused two real
  privilege-escalation issues (#847, #848).
  → [`docs/role-access-matrix.md`](../role-access-matrix.md)
- **Adding a role grants nothing.** A new value in the Prisma `Role` enum has no
  access at all until a builder is written for it, so the surface cannot widen
  silently.
  → [`docs/role-access-matrix.md`](../role-access-matrix.md)
- **The matrix is regression-tested**, not just documented — `e2e/authz-matrix.spec.ts`
  and `e2e/authz-idor.spec.ts` run in CI.

## Authentication and sessions

- Passwords are hashed with **bcrypt**; sessions are **JWT**, issued by NextAuth.
- **Two-factor authentication** with role-based enforcement, session timeouts,
  and "sign out of all devices".
- **"Keep me signed in" is not a longer session.** The session JWT stays at 12
  hours. Staying signed in is a separate rotating, hashed, per-device token that
  can be revoked individually from the account page. Two invariants are enforced
  in code: anything that revokes sessions must also revoke every trusted device,
  and every sign-out control goes through `signOutEverywhere()`.
  → [`docs/remember-me.md`](../remember-me.md)
- **Rate limiting is proxy-aware.** The real client IP is counted back from the
  right of `X-Forwarded-For` by a configured number of hops (`TRUSTED_PROXY_COUNT`),
  because the left-hand entries are attacker-controlled and rotating them used to
  bypass every IP-based limit.
  → `.env.example`

## What the application does *not* do

These are all checkable in two files or fewer, which is why they are stated as
facts rather than intentions.

- **No analytics or chat script ever runs on the signed-in CRM.** The analytics
  loader is mounted from the public shell only, never from the root layout — a
  pageview on an authenticated page would carry a mentee's name in the URL to a
  vendor.
  → `src/components/landing/PublicShell.tsx`, `src/components/AnalyticsScripts.tsx`
- **Nothing optional loads without consent.** Analytics and the live chat are
  gated on a stored, versioned consent record; the version is bumped whenever a
  category's meaning changes, so an old "yes" does not silently cover a new
  vendor.
  → `src/lib/cookieConsent.ts`
- **No data is sold, and there is no payment processor.** The platform is free
  for mentees and mentors.
- **No third party receives CV text unless the individual asks for it.** AI-assisted
  CV reading is dormant unless an API key is configured, and gated per user on top
  of that.
  → [`subprocessors.md`](subprocessors.md), row 4

## Operational security

- **The health endpoint can be closed.** `GET /api/health` answers everyone with
  `{ status, timestamp }`, which is all an uptime monitor acts on; version, git
  SHA, subsystem status and uptime are released only to an admin session or a
  caller presenting `X-Health-Token` — because the unrestricted version told an
  attacker exactly which CVEs applied.
  → `.env.example` (`HEALTH_TOKEN`), issue #897
- **Backups exist and are exercised.** A full dump is taken before every
  production deploy and daily at 03:15 UTC, kept for a configurable retention
  window, stored `0600` in a `0700` directory on the app server, with a liveness
  check and a documented restore drill (including a drill log).
  → [`docs/disaster-recovery.md`](../disaster-recovery.md)
- **Nothing compiles on the production host.** Images are built on GitHub-hosted
  runners and pushed to a registry; the server pulls, migrates, swaps the
  container and health-checks it.
  → `CLAUDE.md` § Deployment
- **Contributors never see real data.** Development runs against a local database
  and a synthetic seed; the demo seeder refuses a non-local `DATABASE_URL`, and
  each pull-request environment gets its own database, created on first deploy
  and dropped when the PR closes.
  → [`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md), `CLAUDE.md` § Deployment

## Assurance

- **A structured security audit** was run against the role × endpoint matrix,
  with the areas that tested clean recorded so that breaking one counts as a
  regression, and the areas that were *never examined* recorded just as
  explicitly. Root tracking issue: #951.
  → [`docs/security-audit-playbook.md`](../security-audit-playbook.md)
- **A SAST report was triaged**, its false positives explained (Prisma query
  construction is not NoSQL injection) and its two genuine findings fixed
  (#1294). The real class of risk it missed — Prisma *filter-operator*
  injection — is documented rather than left implicit.
  → [`docs/security-audit-playbook.md`](../security-audit-playbook.md) § 8
- **Quality gates run per pull request**: TypeScript, lint, i18n key parity, a
  Playwright smoke suite, and an accessibility gate that compares against a
  committed baseline in both light and dark mode. The full end-to-end suite runs
  four times a day and a load test nightly, both alerting only on failure.
  → `CLAUDE.md` § Commands, [`docs/testing.md`](../testing.md)

## Known limitations — read this part

Publishing only the good half would make the rest of this document worth less.

- **Multi-tenant isolation is NOT enforced in production.** The `Organization`
  model, super-admin org management, per-tenant plans, branding and SSO are all
  live, and the enforcement engine is written — but the flag that scopes every
  query to the request's organization, `MT_ENFORCE_ISOLATION`, is **off**, the
  per-route rollout is still in progress, and every existing row is backfilled to
  a single `default` organization. In other words: **the live application is
  effectively single-tenant, and nothing filters by `orgId` today.** Tracking:
  #1572.
  → [`docs/tenant-isolation.md`](../tenant-isolation.md)
- **Production, the shared preview and every pull-request environment run on one
  host.** They are separate containers with separate databases, not separate
  machines.
  → [`hosting-and-residency.md`](hosting-and-residency.md)
- **Web Push has no contractual counterparty.** The protocol does not offer the
  sender one; payloads are encrypted to the subscriber's keys, and the feature is
  off unless both a keypair is configured and the user opts in.
  → [`subprocessors.md`](subprocessors.md), row 8
- **No third-party certification.** There is no SOC 2 report and no ISO 27001
  certificate for this deployment. What exists instead is a public repository, a
  published subprocessor register, and internal audit documents you can read.
- **The parts of the surface that were never audited** are listed by name in the
  playbook rather than quietly omitted.
  → [`docs/security-audit-playbook.md`](../security-audit-playbook.md) § 7

## Reporting a vulnerability

Write to the operator's published contact address on `/imprint`. Who operates a
given deployment comes from that deployment's own configuration, not from this
source code — the project is AGPL and other people run their own instances.
