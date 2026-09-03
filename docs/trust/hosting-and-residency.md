# Hosting and data residency

**Last updated: 2026-09-02**

The written answer to "where does our data live, and can we keep it in the EU?"

## Where the data is today

**On one server.** The application runs as a Docker container on a single
Plesk-managed host, next to its MySQL database and its backups. There is no
managed database service, no object store and no CDN holding application data —
the whole of it is on that machine.

That machine runs three kinds of environment at once:

| Environment | Container | Port | URL | Database |
|---|---|---|---|---|
| Production | `internship-crm` | 3200 | `https://crm.ersah.in` | `internship_crm` |
| Shared preview | `internship-crm-preview` | 3201 | `https://crm-preview.ersah.in` | its own single preview database |
| Per-pull-request | `internship-crm-pr<N>` | 33xx | `https://crm-pr<N>.ersah.in` | `internship_pr<N>`, created on first deploy and **dropped when the PR closes** |

**Say this plainly, because it matters for a risk assessment: production, the
shared preview and every pull-request environment share one host.** They are
isolated as separate containers with separate databases — a schema change on a
pull-request environment reaches nobody else, and no real preview data is
reachable from one — but they are not separate machines. A host-level failure or
a host-level compromise is common to all three.

Two things are deliberately *not* on that host:

- **Builds.** Container images are built on GitHub-hosted runners and pushed to
  `ghcr.io/21072026/internship`; the server only pulls, syncs the schema, swaps
  the container and health-checks it. Nothing compiles on the production box.
- **Real data in development.** Contributors work against a local database and a
  synthetic seed. The demo seeder refuses a non-local `DATABASE_URL`
  ([`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md)).

Backups live on the same host: `/var/backups/internship-crm`, taken before every
production deploy and daily at 03:15 UTC, kept for a configurable retention
window, files `0600` inside a `0700` directory, with a documented restore
procedure and a drill log ([`docs/disaster-recovery.md`](../disaster-recovery.md)).

## The EU / region answer

**This repository does not assert a hosting country, and will not.** The project
is AGPL-licensed and other people run their own instances; a region written into
the source would be a claim about somebody else's server. The location of a
given deployment is a fact about that deployment, and its operator states it —
in the DPA, or on request through the contact address published at `/imprint`
(the operator identity itself is read from the deployment's environment, never
hardcoded — `src/lib/imprint.ts`).

What the code *does* pin, and what you can therefore verify without asking
anyone:

- **The default analytics region is EU.** The PostHog default host shipped in
  `.env.example` is `eu.i.posthog.com`. Plausible is cookieless and
  self-hostable, so it can be kept entirely on the operator's own
  infrastructure.
- **Most third-party paths are optional and off by default.** AI CV reading,
  Google Calendar, JaaS video, web push, all three analytics providers and the
  live chat are each dormant until their environment variables are set — see the
  [subprocessor register](subprocessors.md). A deployment can be brought up with
  the database, the app and one SMTP relay, and nothing else leaving the host.
- **What cannot be avoided while the features are used** is listed in the same
  register rather than glossed over: video rooms are hosted by 8x8, and browser
  push is routed by the subscriber's own browser vendor.

If your procurement requires EU residency **in writing**, there are exactly two
honest routes. The first is the operator confirming their host's location
contractually. The second is below.

## The residency answer of last resort: run it yourself

InternshipCRM is licensed **AGPL-3.0-or-later**. You may run your own instance,
on your own infrastructure, in your own jurisdiction, without asking anyone's
permission and without paying anyone. That is not a workaround — it is the
licence, and it is the strongest data-residency guarantee this project can
offer, because it removes us from the question entirely.

A self-hosted instance:

- reads its operator identity, controller details and imprint from **its own**
  environment, so its legal pages describe *you*;
- can leave every optional integration in the register unset;
- can point the analytics providers at self-hosted endpoints, or run none;
- is subject to the AGPL's source-availability obligation for a modified version
  offered over a network.

The project is also available under **dual licensing**. The sole rights holder is
**Mehmet Erşahin**, a natural person — not a company. Contributor terms are in
`CONTRIBUTING.md` (§ Contributor terms (IP)); the rationale is in
[`docs/legal/licensing-strategy.md`](../legal/licensing-strategy.md).

## Liveness

`GET /api/health` answers any caller with `{ status, timestamp }` — enough for an
uptime monitor. Version, git SHA, subsystem status and uptime are released only
to an admin session or a caller presenting a configured `X-Health-Token`, because
the unrestricted response told an attacker precisely which CVEs applied to the
running build (#897).
