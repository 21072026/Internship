# Security questionnaire — answer library (CAIQ / SIG-lite shape)

> Issue: [#2031](https://github.com/21072026/Internship/issues/2031) · Story:
> [#2025](https://github.com/21072026/Internship/issues/2025)

The standard questions a prospect's security review asks, each with **the answer
this project can honestly give today** and the file that proves it. Internal
reference: answering the next 200-line spreadsheet should be copy-and-paste,
not archaeology.

**Last reviewed: 2026-10-27.**

### How to use this file

1. **Copy the answer, keep the evidence.** Every row names a path in this
   repository (or a workflow, or an issue). A reviewer who asks "how do you
   know?" gets a file, not an assurance.
2. **Never upgrade a ❌ to a ✅ to close a deal.** A wrong "yes" in a
   questionnaire is a contract problem — usually a warranty — not a marketing
   problem. If a row is embarrassing, fix the product, then the row.
3. **Legend:** ✅ yes, implemented · ⚠️ partial, with the limit stated
   · ❌ no / not yet, with the tracking issue.
4. **Answer in the reviewer's language, not ours.** Say "role-based access
   control with a documented matrix", then link
   [`docs/role-access-matrix.md`](../role-access-matrix.md).
5. **When a question has no row here**, answer it from the code, then **add the
   row** — that is how this file stays worth having. Update the review date.
6. **Anything about scale, staffing or process maturity gets the honest frame:**
   this is a product run by one maintainer with contributors, deployed on one
   server. Several ❌ rows below are consequences of that, not oversights, and
   a reviewer who is told so up front usually keeps reading.

---

## A. Organisational

| Question | Answer | Evidence |
|---|---|---|
| Who is the legal entity behind the product? | The **operator of the instance**, published per deployment — name, address and a working contact are read from the deployment's environment, never hardcoded. The **sole rights holder of the software is Mehmet Erşahin, a natural person**; no company owns the IP. Which entity invoices commercially is a deliberately open decision. | [`src/lib/imprint.ts`](../../src/lib/imprint.ts), [`src/app/imprint/page.tsx`](../../src/app/imprint/page.tsx), [`docs/legal/README.md`](../legal/README.md), [`docs/legal/legal-tax-framework.md`](../legal/legal-tax-framework.md), `LICENSE` |
| Do you have a written information security policy? | ⚠️ Partial. There is no single ISMS policy document. There is a published security model, a repeatable audit method, a written exception register and a data-access policy that is enforced in code. | [`SECURITY.md`](../../SECURITY.md), [`docs/security-audit-playbook.md`](../security-audit-playbook.md), [`docs/security-exceptions.md`](../security-exceptions.md), [`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md) |
| Do you hold SOC 2, ISO 27001 or an equivalent certification? | ❌ **No**, and none is in progress. The decision is costed, dated and written down rather than attempted. | [`docs/trust/soc2-decision.md`](soc2-decision.md) |
| Has an external penetration test been performed? | ❌ **No external test has been commissioned.** An internal role × endpoint audit was performed on 2026-07-28, its method is published, and the open findings it did not close are listed publicly. | [`docs/trust/pentest.md`](pentest.md), [#951](https://github.com/21072026/Internship/issues/951) |
| Do you have a named security contact and a disclosure policy? | ✅ Yes — machine-readable and human-readable, with response targets and safe harbour. | [`/.well-known/security.txt`](../../public/.well-known/security.txt), [`docs/trust/vulnerability-disclosure.md`](vulnerability-disclosure.md) |
| How many people can access customer data? | ⚠️ Small and honest: the maintainer/operator of the deployment. Contributors are **barred from real personal data** and develop against a synthetic seed; the demo seeder refuses a non-local database URL. Contributor-side compliance is policy plus that code guard, not a technical impossibility for the operator. | [`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md), `prisma/seed-demo.mjs`, [`scripts/sanitize-db.mjs`](../../scripts/sanitize-db.mjs) |
| Do staff receive security training? Are background checks performed? | ❌ **No** formal training programme and **no** background checks. Contributors accept written contributor terms (IP + conduct) and the data-access policy. | [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [`docs/legal/contributor-terms-in-app.md`](../legal/contributor-terms-in-app.md) |
| Is there a documented access-review cadence (joiner/mover/leaver)? | ❌ **No** periodic access review exists. Admin accounts can be deactivated and sessions revoked in-product, but nobody re-certifies the list on a schedule. Named as a SOC 2 prerequisite. | [`docs/trust/soc2-decision.md`](soc2-decision.md) § 3 |
| Do you carry cyber-liability insurance? | ❌ **No.** | n/a — nothing to link, no policy exists. The commercial framework it would sit in is still an open decision: [`docs/legal/legal-tax-framework.md`](../legal/legal-tax-framework.md) |

## B. Access control and authentication

| Question | Answer | Evidence |
|---|---|---|
| How do users authenticate? | Credentials (e-mail + password) via NextAuth 4 with JWT sessions; optional SAML 2.0 SSO per tenant. | [`src/lib/auth.ts`](../../src/lib/auth.ts), [`docs/sso-saml.md`](../sso-saml.md) |
| How are passwords stored, and what is the policy? | bcrypt, cost 12. The policy is per-organisation data: minimum length (8–128) and optional upper/lower/digit/symbol rules, checked by one function on every path that accepts a new password, plus optional breached-password screening against HIBP via k-anonymity (five hex characters of the SHA-1 leave the server; it fails open). | [`docs/password-policy.md`](../password-policy.md), [`src/lib/password.ts`](../../src/lib/password.ts), [`src/lib/breachedPassword.ts`](../../src/lib/breachedPassword.ts) |
| Is multi-factor authentication available? Can it be enforced? | ✅ Yes — TOTP, enforceable per organisation for admins, admins and mentors, or every role, with a server-side gate on every role shell. Ten single-use recovery codes are minted at enrolment (only an HMAC is stored), and an admin-side 2FA reset is audited and notified. | [`docs/two-factor-policy.md`](../two-factor-policy.md), [`docs/two-factor-recovery.md`](../two-factor-recovery.md), [`src/lib/twoFactorPolicyRule.ts`](../../src/lib/twoFactorPolicyRule.ts) |
| Is TOTP replay prevented? | ✅ Yes — the highest accepted time step is stored per account, so a code captured inside the ±1-step window cannot be reused. | `prisma/schema.prisma` (`User.lastTotpStep`) |
| Is brute force throttled? | ✅ Yes — failed logins are counted **per e-mail address** (10 / 15 min), so spoofing `X-Forwarded-For` does not bypass it; failures are written to the audit log. | [`src/lib/rateLimit.ts`](../../src/lib/rateLimit.ts), [`SECURITY.md`](../../SECURITY.md) |
| Is user enumeration prevented? | ✅ Yes — sign-in returns one generic error for both an unknown address and a wrong password. | [`SECURITY.md`](../../SECURITY.md) |
| What is the session lifetime? Can a session be revoked? | 12-hour JWT. "Sign out everywhere", admin force sign-out and admin deactivation stamp `sessionsValidFrom`, which invalidates every existing token, and revoke trusted devices. "Keep me signed in" is a **separate rotating, hashed, revocable per-device token**, not a longer session. | [`docs/remember-me.md`](../remember-me.md), [`src/lib/trustedDevice.ts`](../../src/lib/trustedDevice.ts), [#1539](https://github.com/21072026/Internship/issues/1539) (fixed) |
| How is authorisation modelled? | Role-based (`ADMIN`, `MENTOR`, `MENTEE`, `COMPANY`, `SOURCE`) plus per-resource ownership checks, documented as a matrix and **fail-closed**: an unlisted case is refused, never given everything. Proven by e2e tests that run on every PR. | [`docs/role-access-matrix.md`](../role-access-matrix.md), [`src/lib/authzScope.ts`](../../src/lib/authzScope.ts), `e2e/authz-matrix.spec.ts`, `e2e/authz-idor.spec.ts` |
| Are there "super admin" powers, and are they separated from customer admins? | ✅ Yes. Organisation management is held only by a per-deployment super-admin capability; no tenant permission crosses an organisation. Tenant admins have tiers (`ORG_ADMIN`, `PROGRAM_ADMIN`, `OBSERVER`) with scoped grants, and every refusal is audited. | [`docs/role-access-matrix.md`](../role-access-matrix.md) § Admin tiers, [`src/lib/authzRule.ts`](../../src/lib/authzRule.ts), [#1535](https://github.com/21072026/Internship/issues/1535) (fixed) |
| Is customer data isolated per tenant? | ⚠️ **The engine exists and is off.** Every authenticated route that touches a tenant-anchored model is wrapped, and isolation is proven in e2e with the flag on — but `MT_ENFORCE_ISOLATION` is `false` in production, where all rows sit in one `default` organisation, so the live app is effectively single-tenant. Do not read "isolation engine" as "isolated". | [`docs/tenant-isolation.md`](../tenant-isolation.md), [#1549](https://github.com/21072026/Internship/issues/1549), [#1564](https://github.com/21072026/Internship/issues/1564) |
| Can support staff impersonate a user? Is it audited? | ✅ Admin-only, single-use grant, fully audited, and cannot be used to delete the impersonated account. | [`src/lib/impersonation.ts`](../../src/lib/impersonation.ts), [`SECURITY.md`](../../SECURITY.md) |
| How are API keys handled? | ✅ Stored as SHA-256 hashes, never in plaintext; each key has an owner, scopes, an expiry and can be revoked, all enforced at the door, and an organisation-less `/api/v1` read is refused. | [`src/lib/apiKey.ts`](../../src/lib/apiKey.ts), [#1545](https://github.com/21072026/Internship/issues/1545), [#1546](https://github.com/21072026/Internship/issues/1546) (fixed) |

## C. Encryption

| Question | Answer | Evidence |
|---|---|---|
| Is data encrypted in transit? | ✅ Yes — HTTPS only, with HSTS (`max-age=63072000; includeSubDomains; preload`) plus CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` and `Permissions-Policy` on every response. TLS is terminated by the host web server. | [`next.config.js`](../../next.config.js) |
| Is data encrypted at rest? | ❌ **No** database- or application-level encryption of the general data set. Specific secrets are protected: passwords are bcrypt hashes, API keys and device tokens are hashed, and Google OAuth tokens are sealed with AES-256-GCM (key derived via HKDF from the server secret). ⚠️ The TOTP shared secret is stored **unencrypted**. Backups are permission-restricted (`0600`) but **not encrypted**, on the same host. | [`src/lib/secretBox.ts`](../../src/lib/secretBox.ts), `prisma/schema.prisma` (`User.twoFactorSecret`), [`docs/disaster-recovery.md`](../disaster-recovery.md) |
| Do you use a KMS or HSM? | ❌ **No.** Encryption keys are derived from the deployment's server secret in the environment; the sealing helper states plainly that it does not protect against an attacker holding both the database and the server environment. | [`src/lib/secretBox.ts`](../../src/lib/secretBox.ts) |
| How are application secrets managed and rotated? | ⚠️ Environment file on the server plus GitHub Actions secrets; nothing is committed (enforced by review, `.gitignore` and a forbidden-terms CI guard). A written inventory classifies every secret — what it protects, where it lives, blast radius, rotation procedure — with an annual rotation and a quarterly access review. No KMS (see above). | [`docs/secrets-and-rotation.md`](../secrets-and-rotation.md), [`.env.example`](../../.env.example) |
| Are file uploads validated? | ✅ Yes — MIME is checked against the actual bytes rather than the client-declared header, and SVG is not on the allowlist. | [`src/lib/fileType.ts`](../../src/lib/fileType.ts), [`src/lib/announcementImage.ts`](../../src/lib/announcementImage.ts) |

## D. Logging, monitoring and audit

| Question | Answer | Evidence |
|---|---|---|
| Is there an audit trail of security-relevant events? | ✅ Yes — sign-in and failed sign-in, profile and pipeline-stage changes, e-mail/password change, account deletion, impersonation and refused cross-scope attempts, each with actor, target, severity, **IP and user agent**, visible to admins at `/admin/activity`. | `prisma/schema.prisma` (`ActivityLog`), [`src/lib/activity.ts`](../../src/lib/activity.ts) |
| Are audit logs immutable / exported to a separate system? | ⚠️ They are rows in the application database, readable by admins — no WORM store in the product. A tenant can register an **audit stream**: its audit rows are POSTed to a URL it controls as signed NDJSON (JSON lines or ECS), at-least-once, from a cursor that moves only on success — so the customer's own SIEM can hold the immutable copy. | [`docs/audit-stream.md`](../audit-stream.md), [`src/lib/auditDrainRule.ts`](../../src/lib/auditDrainRule.ts) |
| What is the log retention period? | ❌ **Not defined.** Audit rows are kept indefinitely today; no retention or archival job exists for them. | — |
| Do you have error tracking, APM or external uptime monitoring? | ❌ **No, none of the three.** A production 500 is currently found by a person looking at it. This is the single biggest observability gap and it is tracked as an epic. | [#1591](https://github.com/21072026/Internship/issues/1591) |
| Is there a status page or published SLA? | ❌ **Not yet** — separate tracked work. | [#1594](https://github.com/21072026/Internship/issues/1594) |
| Is rate limiting in place? | ✅ Yes for auth and public endpoints, with a shared Redis store when the deployment configures one (required before running more than one replica) and a per-process fallback if the store is unreachable, so an outage never locks everyone out. | [`src/lib/rateLimit.ts`](../../src/lib/rateLimit.ts), [`src/lib/rateLimitStore.ts`](../../src/lib/rateLimitStore.ts), [#1696](https://github.com/21072026/Internship/issues/1696) |

## E. Backup, restore and business continuity

| Question | Answer | Evidence |
|---|---|---|
| Are backups taken? How often? | ✅ Yes — a full `mysqldump` **before every production/preview deploy** and daily at 03:15 UTC, kept 7 days by default, files `0600` in a `0700` directory. | [`docs/disaster-recovery.md`](../disaster-recovery.md), `infra/backup-db.sh` |
| Is backup *health* verified, or just assumed? | ✅ Verified. A **daily** freshness check (not monthly — monthly means up to 30 days of believing you have backups when you do not) plus a **monthly restore drill** into a scratch database, both alerting by e-mail on failure. | [`.github/workflows/backup-verify.yml`](../../.github/workflows/backup-verify.yml) |
| Have you tested a restore? | ✅ Yes — the restore is a written procedure with a drill log, not an improvisation. | [`docs/disaster-recovery.md`](../disaster-recovery.md) § "The drill" |
| Are backups encrypted, and stored off-host? | ❌ **No** on both counts today: unencrypted dumps on the same server as the database. | [`docs/disaster-recovery.md`](../disaster-recovery.md) |
| What are your RTO and RPO? | ⚠️ **No contractual RTO/RPO.** RPO is bounded in practice by the daily + pre-deploy dumps (worst case ~24h of data). Measured restore times live in the drill log rather than being quoted as a commitment. | [`docs/disaster-recovery.md`](../disaster-recovery.md) |
| Is there redundancy / failover? | ❌ **No.** One server hosts production, preview, every per-PR environment and MySQL. There is no standby, no multi-AZ, no load balancer. | Deployment table in [`CLAUDE.md`](../../CLAUDE.md) |
| Is there a documented business-continuity plan? | ❌ **No** BCP document. Disaster *recovery* for the database is documented and drilled; continuity of the business around it is not. | [`docs/disaster-recovery.md`](../disaster-recovery.md) |

## F. Secure development

| Question | Answer | Evidence |
|---|---|---|
| Do you use source control, code review and a CI gate? | ✅ Yes — branch + pull request per change, and CI runs `prisma validate`, lint, `tsc --noEmit`, i18n parity, several project-specific security checks, the authorisation e2e suite and a production build on every pull request. Branch protection on `main` **requires** the Playwright smoke set (which carries the authorisation, tenant-isolation and session-revocation guards) and a forbidden-terms check; the other CI jobs report on the PR but are not required checks. | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`.github/workflows/e2e.yml`](../../.github/workflows/e2e.yml), [`CONTRIBUTING.md`](../../CONTRIBUTING.md) |
| Is every change reviewed by a second person? | ⚠️ **No mandatory second human.** Changes are self-reviewed against the checklist and gated by CI; the project is maintained by one person. Formal change management is named as a SOC 2 prerequisite rather than claimed. | [`docs/trust/soc2-decision.md`](soc2-decision.md) § 3 |
| Do you scan dependencies for known vulnerabilities? | ✅ Yes — `npm audit` on every pull request, every push to `main` and weekly, against a written per-severity remediation SLA. The gate fails on any `critical`, and on a `high` unless its only fix is a major version or none exists **and** its reason is written in the exception register. Dependabot runs weekly. | [`docs/trust/vulnerability-management.md`](vulnerability-management.md), [`.github/workflows/security-audit.yml`](../../.github/workflows/security-audit.yml), [`docs/security-exceptions.md`](../security-exceptions.md) |
| Do you run static analysis (SAST)? | ⚠️ Yes — CodeQL on every push, pull request and weekly, but **deliberately not a blocking check** while the initial backlog is triaged. A commercial SAST report was also triaged in full (25 findings, all false positives; two real findings the scanner missed were fixed). | [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml), [`docs/security-audit-playbook.md`](../security-audit-playbook.md) § 8 |
| Are there project-specific security gates beyond the generic ones? | ✅ Yes: `check:query-scalars` (no unvalidated request-body field may reach a Prisma `where`), `check:auth-reads` (the auth path reads only the columns it needs), `check:demo-blocklist` (demo mode cannot write), plus SSRF guards on every outbound server-side fetch. | [`scripts/check-query-scalars.mjs`](../../scripts/check-query-scalars.mjs), [`scripts/check-auth-reads.mjs`](../../scripts/check-auth-reads.mjs), [`src/lib/ssrfGuard.ts`](../../src/lib/ssrfGuard.ts) |
| Do developers work with production data? | ✅ **No** — synthetic data only, by written policy and enforced in code: the demo seeder refuses a non-local `DATABASE_URL`, and the preview database is sanitised by script. | [`docs/DATA_ACCESS_POLICY.md`](../DATA_ACCESS_POLICY.md), [`scripts/sanitize-db.mjs`](../../scripts/sanitize-db.mjs) |
| How are database schema changes controlled? | ❌ **Weak point, openly stated.** Deploys run `prisma db push --accept-data-loss`; there is no migration history to review. A guard script blocks destructive pushes, and a full dump is taken before every deploy, but the fix is the epic below. | [`CLAUDE.md`](../../CLAUDE.md), `infra/schema-guard.sh`, [#1515](https://github.com/21072026/Internship/issues/1515) |
| Do you publish an SBOM? | ✅ Yes — a CycloneDX 1.6 SBOM of the production dependency tree, stamped with the app version and commit, generated on every image build and served by that image at `/sbom.cdx.json` without a login. A third-party licence inventory (checked in CI against AGPL distribution and the commercial grant) sits beside it. | [`docs/trust/vulnerability-management.md`](vulnerability-management.md), [`docs/legal/third-party-licenses.md`](../legal/third-party-licenses.md), [`scripts/generate-sbom.mjs`](../../scripts/generate-sbom.mjs) |
| Can we audit the code ourselves? | ✅ **Yes — this is the strongest answer on the page.** The product is AGPL-3.0-or-later: read every line, run your own instance, point your own tester at it. | [`LICENSE`](../../LICENSE), [`docs/legal/licensing-strategy.md`](../legal/licensing-strategy.md) |

## G. Subprocessors and third parties

| Question | Answer | Evidence |
|---|---|---|
| Which subprocessors touch customer data? | An SMTP relay (mandatory, for transactional mail), and — **each optional per deployment, off unless configured** — Anthropic (AI CV/interview assistance), Google Calendar (OAuth sync), 8x8 JaaS (video meetings), Plausible and PostHog (analytics, and only on public pages after cookie consent), and a Web Push service via VAPID. | [`.env.example`](../../.env.example), [`src/components/AnalyticsScripts.tsx`](../../src/components/AnalyticsScripts.tsx), [`src/lib/cookieConsent.ts`](../../src/lib/cookieConsent.ts) |
| Is there a public subprocessor register? | ✅ Yes — purpose, data categories, location and whether each is optional, published at `/trust` and in the repository. | [`docs/trust/subprocessors.md`](subprocessors.md), [`src/lib/trust.ts`](../../src/lib/trust.ts) |
| Do you have signed DPAs / SCCs with each subprocessor? | ❌ **Not collected and not published yet.** A DPA the customer can sign, with SCCs, is tracked in the same story. | [#2025](https://github.com/21072026/Internship/issues/2025) |
| Do analytics or session-recording tools run inside the application? | ✅ **No.** Analytics scripts are mounted only from the public marketing shell, never on the signed-in CRM, and only after the visitor accepts the relevant cookie category. There is no session recording. | [`src/components/landing/PublicShell.tsx`](../../src/components/landing/PublicShell.tsx), [`src/lib/cookieConsent.ts`](../../src/lib/cookieConsent.ts) |
| Is customer data sent to an AI provider? | ⚠️ Only when the deployment configures a provider key **and** the data subject's consent is recorded: the central AI gate refuses without consent, without a configured provider, or over the monthly quota, and every call is metered. ❌ **Prompt injection on those endpoints has never been security-tested.** | [`src/lib/aiGate.ts`](../../src/lib/aiGate.ts), [`docs/trust/pentest.md`](pentest.md) § 2 |
| Where is data hosted? | On one Linux server running Docker behind a Caddy reverse proxy, which hosts production, preview, every per-PR environment and MySQL. This repository deliberately does not declare a hosting country — the project is AGPL and other people run their own instances; the operator of a deployment states its location on request, and self-hosting is the strongest residency answer. | [`docs/trust/hosting-and-residency.md`](hosting-and-residency.md), deployment table in [`CLAUDE.md`](../../CLAUDE.md) |
| Are production, staging and test environments separated? | ❌ **Not at the host level** — they are separate containers, ports and databases (each per-PR environment gets its own throwaway database seeded with synthetic data), but they share one machine and one MySQL server. Stated plainly because a buyer who discovers it later stops trusting the rest of the page. | Deployment table in [`CLAUDE.md`](../../CLAUDE.md) |

## H. Incident response

| Question | Answer | Evidence |
|---|---|---|
| Do you have a documented incident-response plan? | ❌ **No** IR runbook yet — no severity ladder, no on-call, no communication templates. Tracked. | [#1605](https://github.com/21072026/Internship/issues/1605) |
| Will you notify us of a breach, and how fast? | ⚠️ The operator is the controller or processor under GDPR and is bound by Art. 33/34 notification duties; **contractual notification terms belong in the DPA**, which is not published yet. No shorter commitment is claimed here than can be met by a single-maintainer project. | [`src/app/privacy/page.tsx`](../../src/app/privacy/page.tsx), [#2025](https://github.com/21072026/Internship/issues/2025) |
| How do you learn about a security problem reported from outside? | ✅ GitHub private vulnerability reporting, published in `security.txt` and in the disclosure policy, with response targets (first response 5 working days, assessment 10). | [`docs/trust/vulnerability-disclosure.md`](vulnerability-disclosure.md) |
| Have you had a breach? | **No breach is known.** Note the honest limits of that statement: with no error tracker, no APM and no log shipping ([#1591](https://github.com/21072026/Internship/issues/1591)), detection capability is limited, so "none known" is a weaker claim than "none happened". | [#1591](https://github.com/21072026/Internship/issues/1591) |
| Is there a post-incident review practice? | ⚠️ Informal but real: accepted risks and their reasoning are written down where the next person will find them, and the audit playbook is updated after every exercise. Not a formal RCA process. | [`docs/security-exceptions.md`](../security-exceptions.md), [`docs/security-audit-playbook.md`](../security-audit-playbook.md) |

## I. Privacy and data lifecycle

| Question | Answer | Evidence |
|---|---|---|
| What personal data is processed? | Candidate profiles, CVs and documents, contact details, mentor notes, interaction logs, meeting records, messages. Mostly about early-career candidates — treated accordingly. | `prisma/schema.prisma`, [`src/app/privacy/page.tsx`](../../src/app/privacy/page.tsx) |
| Is there a GDPR Art. 13 privacy notice with a named controller? | ✅ Yes — controller, purposes, legal basis, recipients, retention, rights, withdrawal and complaint, with the controller identity resolved from the deployment's environment rather than hardcoded. The accepted version is recorded per user at registration. | [`src/app/privacy/page.tsx`](../../src/app/privacy/page.tsx), [`src/lib/privacy.ts`](../../src/lib/privacy.ts) |
| Can a data subject export their data? | ✅ Yes — a self-service export of everything held about them. | `src/app/api/account/export/route.ts` |
| Can a data subject be erased? | ✅ Yes — self-service account deletion (re-authentication required) and an admin erasure path. | [`src/lib/accountErasure.ts`](../../src/lib/accountErasure.ts), `e2e/admin-user-erase.spec.ts` |
| Is retention limited (storage limitation, Art. 5(1)(e))? | ✅ Yes, and deliberately **not** automatic deletion: retention is anchored on the consent date, the person is asked to re-consent when it lapses, and after a grace period the record is surfaced to an admin for a deletion decision. | [`src/lib/retention.ts`](../../src/lib/retention.ts), [`src/lib/consentRenew.ts`](../../src/lib/consentRenew.ts) |
| Is access to personal data minimised over time? | ✅ Yes — a mentor's access to a mentee's PII closes after the mentorship ends, and list endpoints return reduced field sets rather than whole records. | [`docs/pii-access-lifecycle.md`](../pii-access-lifecycle.md) |
| What happens to our data if we leave? | ⚠️ Individual export and erasure work today; a **tenant-level** offboarding export is separate tracked work. | [#1584](https://github.com/21072026/Internship/issues/1584) |
| Is special-category or demographic data collected? | ✅ **No.** Equal-opportunity/demographic data is deliberately not collected, and no schema change for it happens without the product owner's explicit decision. | [`docs/legal/equal-opportunity-data.md`](../legal/equal-opportunity-data.md) |
| Is consent recorded for visibility in a talent pool? | ✅ Yes — only public-facing fields, never e-mail or phone, withdrawable at any time. | [`docs/legal/talent-pool-consent-policy.md`](../legal/talent-pool-consent-policy.md) |

## J. Accessibility

| Question | Answer | Evidence |
|---|---|---|
| Is the product accessible? Is it tested? | ⚠️ Automated axe scanning of nine key pages in **both light and dark mode** runs as a blocking CI step, with a baseline that says out loud when it widens. `prefers-reduced-motion`, `prefers-contrast` and forced-colors are honoured. There is no independent audit and **no manual screen-reader certification**. | [`.github/workflows/e2e.yml`](../../.github/workflows/e2e.yml), `e2e/a11y-scan.spec.ts`, [`docs/a11y-audit.md`](../a11y-audit.md) |
| Do you have a VPAT or an accessibility statement? | ✅ Yes — an accessibility statement at `/accessibility` and a VPAT 2.5 (WCAG 2.2 A/AA, EN 301 549, Revised 508) at `/accessibility/vpat`, generated from data with an evidence path behind every `Supports` row. | [`docs/legal/vpat.md`](../legal/vpat.md), [`docs/legal/vpat-evidence.md`](../legal/vpat-evidence.md) |
| Which languages does the interface support? | ✅ English, Turkish and German, with key parity enforced in CI (`npm run check:i18n`). | [`src/i18n/dictionaries.ts`](../../src/i18n/dictionaries.ts), [`scripts/check-i18n.ts`](../../scripts/check-i18n.ts) |

---

## Answers to keep ready for the awkward questions

Reviewers ask these in a call, not on the spreadsheet. Same rule applies:
answer, then the evidence.

- **"You have no SOC 2 — why should we proceed?"** Because the artefacts SOC 2
  is a proxy for are published and checkable: a subprocessor register, a
  security overview, a disclosure policy with safe harbour, a tested restore,
  the open findings, and the entire source under AGPL so your own team can
  audit it. The SOC 2 decision is costed, with its prerequisites named:
  [`soc2-decision.md`](soc2-decision.md).
- **"Everything on one server?"** Yes, and it is written down in our own
  documents — this file, [`pentest.md`](pentest.md) and
  [`soc2-decision.md`](soc2-decision.md) § 3 — rather than left to be
  discovered in due diligence. If single-tenant hosting in your
  region is a requirement, the AGPL licence is the answer available today; a
  dedicated region is a funded change, not a checkbox.
- **"You publish your open security findings?"** Yes. The alternative is a
  summary that goes stale the moment you find the issue tracker, which is
  public. Open and fixed findings are listed with dates and links:
  [`pentest.md`](pentest.md) § 4.

---

## 🇹🇷 Özet

Alıcının güvenlik incelemesinin sorduğu standart soruların, **bugün dürüstçe
verebileceğimiz** cevaplarla ve her cevabın deposundaki kanıt yoluyla listesi —
bir sonraki 200 satırlık anket arkeoloji değil kopyala-yapıştır olsun diye.
Gruplar: kurumsal, erişim kontrolü, şifreleme, kayıt/izleme, yedek ve süreklilik,
güvenli geliştirme, alt-işleyenler, olay müdahalesi, gizlilik/veri yaşam döngüsü,
erişilebilirlik. İşaretler: ✅ var, ⚠️ kısmen (sınırı yazılı), ❌ yok (takip
issue'su ile). **Bir ❌'i anlaşma kapatmak için ✅ yapmak yasak** — ankette yanlış
bir "evet" pazarlama sorunu değil, sözleşme sorunudur. Bugünkü büyük ❌'ler: SOC 2
/ ISO yok, dış sızma testi yok, hata izleme·APM·uptime yok
([#1591](https://github.com/21072026/Internship/issues/1591)), yedekler şifresiz
ve aynı sunucuda, olay müdahale planı yok
([#1605](https://github.com/21072026/Internship/issues/1605)), kiracı izolasyonu
prod'da zorunlu değil, imzalanabilir DPA henüz yok. Eylül'den bu yana kapananlar:
süper-admin ayrımı, API anahtarı kapsam/süre denetimi, kurtarma kodları, paylaşımlı
rate limit, sırlar envanteri, SBOM ve VPAT. En güçlü cevap ise
değişmiyor: kaynak kod AGPL — kendiniz denetleyin.
