# Subprocessor register

**Last updated: 2026-09-02**

Every third party this codebase can send data to, why, and what it receives.

The register is derived from `.env.example` — the complete set of outbound
integrations the app knows how to configure — plus the one embed that is
hardcoded rather than env-configured (row 12). Nothing here is aspirational: if
a row exists, the code path exists; if a row says *optional*, leaving the
variable unset keeps that path dormant.

The customer-facing rendering of this table is [`/trust`](../../src/app/trust/page.tsx),
fed from the typed module [`src/lib/trust.ts`](../../src/lib/trust.ts). **That module is
the source of truth for the page**; this file is the prose register, and the two
are changed together.

## How to read "Optional per deployment"

- **Required** — the app cannot run its core flows without it.
- **Optional** — the integration is inert until its environment variables are
  set. An operator who never sets them never sends anything to that party.
- **Optional + consent** — configured *and* the individual person has to agree
  before anything leaves the server.

## The register

| # | Subprocessor | Purpose | Data categories | Hosting location | DPA / SCC basis | Optional per deployment |
|---|---|---|---|---|---|---|
| 1 | **Hosting: one Plesk-managed server**, operated by the deployment operator | Runs the application container and the MySQL database, and holds the backups described in `docs/disaster-recovery.md` | All application data: accounts, profiles, CVs, interaction logs, messages, uploaded documents | The operator's single server. This repository does not assert a country — the operator names it on request (see `/imprint`) | Direct contract between the operator and their hosting provider | **Required** |
| 2 | **Primary SMTP relay** (`SMTP_HOST`, `SMTP_USER`, `SMTP_FROM`) | Mail that must reach a human: address verification, invitations, password reset, message notifications | Recipient name and e-mail address, message subject and body, links carrying signed tokens | Operator-chosen. The shipped default in `.env.example` is the deployment's own mail server on the same Plesk host; `docs/EMAIL_DELIVERABILITY.md` recommends an external relay for this channel | Direct contract with whichever relay the operator points it at | **Required** — an address cannot be verified without sending mail |
| 3 | **Bulk SMTP relay** (`SMTP_BULK_*`) | A second outbound channel for digests, reminders, announcements and newsletters, kept separate so a digest marked as spam cannot damage password-reset delivery | The same categories as row 2, for non-urgent mail only | Operator-chosen; may deliberately be a different provider and sending domain from row 2 | Direct contract with that relay | **Optional** — unset, and every category rides the primary transport |
| 4 | **Anthropic** (`ANTHROPIC_API_KEY`) | AI-assisted CV reading and the AI assistant features | Text extracted from an uploaded CV, and the prompt built around it | Anthropic's API | Anthropic's commercial terms, held by the operator | **Optional + consent** — dormant while the key is unset, and gated per user regardless |
| 5 | **Google (Calendar OAuth)** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_ENABLED`) | Mirroring in-app meetings into a user's own Google Calendar | Meeting title, description, start and end time, attendee e-mail addresses, and OAuth tokens for the connecting user | Google | Google's API terms, held by the operator | **Optional + consent** — two switches (credentials *and* `GOOGLE_CALENDAR_ENABLED=1`), then each user connects their own account. The in-app calendar, `.ics` export and reminders all work without it |
| 6 | **8x8 (JaaS — Jitsi as a Service)** (`JAAS_APP_ID`, `JAAS_API_KEY_ID`, `JAAS_PRIVATE_KEY`) | Hosted video rooms for one-to-one meetings | Display name, room identifier, and the live audio/video stream of the call | 8x8's JaaS infrastructure | 8x8's JaaS terms, held by the operator | **Optional** — unset, and one-to-one calls fall back to row 7 |
| 7 | **8x8 public Jitsi instance (`meet.jit.si`)** | The default video room when JaaS is not configured, the fallback when a JaaS call cannot start, and the permanent home of group/bulk and recurring meetings | Display name, room identifier, live audio/video stream | 8x8's public instance | Public-service terms only — no contract | Used only if someone opens a meeting room; there is no way to configure it away while video is in use |
| 8 | **Browser push services** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) | Background notifications for new messages, delivered to a browser with the app closed. The concrete service is chosen by the subscriber's browser — Google for Chrome, Mozilla for Firefox, Apple for Safari — not by us | The push endpoint URL the browser issued, and an encrypted payload; plus the `VAPID_SUBJECT` contact address identifying the sender | The browser vendor's push service | None available: the Web Push protocol gives the sender no contractual counterparty. Payloads are encrypted to the subscriber's own keys | **Optional + consent** — no keypair, no push, and the user must switch browser notifications on at `/account` |
| 9 | **Plausible Analytics** (`NEXT_PUBLIC_PLAUSIBLE_DOMAIN`, `NEXT_PUBLIC_PLAUSIBLE_HOST`) | Pageview measurement on **public marketing pages only** | Pageview URL, referrer, coarse device and browser data. Cookieless | Operator-chosen; defaults to `plausible.io`. Plausible is self-hostable, so an operator can keep this on their own infrastructure | Plausible's DPA, held by the operator — or none needed when self-hosted | **Optional + consent** — unset by default, and loads only after the visitor accepts analytics cookies |
| 10 | **PostHog** (`NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`) | Pageview measurement on **public marketing pages only** | Pageview URL, referrer, coarse device and browser data. Autocapture, session recording and `localStorage` persistence are forced **off in code** (`src/lib/analytics.ts`), not left to a dashboard setting | Operator-chosen; the shipped default host is `eu.i.posthog.com`, PostHog's EU region | PostHog's DPA, held by the operator | **Optional + consent** — as row 9 |
| 11 | **Google Analytics 4** (`NEXT_PUBLIC_GA4_MEASUREMENT_ID`) | Pageview measurement on **public marketing pages only**, loaded with `anonymize_ip` | Pageview URL, referrer, truncated IP, coarse device and browser data | Google | Google's Analytics terms and standard contractual clauses, held by the operator | **Optional + consent** — as row 9, and unset in the reference deployment |
| 12 | **tawk.to** (live chat) | The live-chat widget on the public home page. Hardcoded in `src/components/TawkChat.tsx` rather than env-configured | The visitor's IP address, and whatever they type into the chat | tawk.to | tawk.to's terms, held by the operator | **Optional + consent** — loads only after the visitor accepts **marketing** cookies, and only on the public home page |
| 13 | **GitHub (Actions + `ghcr.io/21072026/internship`)** | Continuous integration, container image builds, and the registry the server pulls from. Part of the *supply chain*, not of request handling | Source code, build logs and container images. **No end-user personal data** — the application database is not reachable from a build runner | GitHub-hosted runners and registry | GitHub's terms, held by the operator | **Required for this deployment's pipeline.** A self-hoster builds the AGPL source wherever they like |

## Not subprocessors

- **No payment processor.** The platform is free for mentees and mentors, and
  there is no billing integration in this codebase.
- **No CRM, ad network or data broker.** Nothing in `.env.example` sends
  personal data anywhere for marketing purposes.
- **No analytics on the signed-in application.** The analytics loader is mounted
  from `PublicShell`, never from the root layout, so a signed-in page cannot emit
  a pageview carrying a mentee's name in its URL — see
  `src/components/landing/PublicShell.tsx` and `src/components/AnalyticsScripts.tsx`.
  This is a claim you can check by reading two files.

## The rule

Adding any outbound integration — a new API call to a third party, a new embedded
script, a new mail transport — **must** update this file and `src/lib/trust.ts`
in the same pull request. See [`README.md`](README.md).
