# DPIA starter (GDPR Art. 35)

> A starting point for the Controller's data-protection impact assessment and for
> the works-council consultation (§ 87(1) no. 6 BetrVG) that usually comes with
> it. Not legal advice and not a completed DPIA: the Controller owns the
> assessment, scores the risks for its own programme and signs it off. Issue #2029.

## 1. Systematic description

- **What:** a multi-tenant web application in which an organisation runs a
  mentoring / internship / hiring programme: accounts, matching, interaction
  logs, messaging, meetings, an application pipeline, e-mail and optional AI
  assistance. Per purpose, data subjects, categories, recipients and retention:
  [`ropa.md`](ropa.md).
- **Who is affected:** applicants and participants (students and graduates,
  potentially minors where the programme admits them), mentors who may be the
  Controller's employees, company contacts and interviewers.
- **Why a DPIA is indicated:** systematic evaluation of persons in a hiring
  context, free-text notes about participants, a power imbalance between
  applicant and organisation, possible minors, and the optional AI features.
  Monitoring of employees (mentors' activity) is the works-council point.
- **Where data goes:** [`../trust/subprocessors.md`](../trust/subprocessors.md),
  transfers in [`dpa-annex-sccs.md`](dpa-annex-sccs.md).

## 2. Necessity and proportionality

| Principle | How the product meets it | Code / doc |
|---|---|---|
| Purpose limitation | Mentor and company lose access to a mentee's CV 6 months after the relation completes | `POST_MENTORSHIP_ACCESS_MONTHS`, `src/lib/retention.ts`; `docs/DATA_ACCESS_POLICY.md` |
| Data minimisation | Role-specific field sets; no demographic fields; fit ranking cannot see age, gender, nationality, photo or name | `docs/pii-access-lifecycle.md` § 2; `docs/legal/equal-opportunity-data.md`; `src/lib/matching/requisitionFit.ts` |
| Storage limitation | Nightly retention registry; consent review after `retentionMonths` | `src/lib/retentionEntries.ts`; [`../trust/data-lifecycle.md`](../trust/data-lifecycle.md) |
| Transparency | Privacy notice per Art. 13; a dedicated `/ai` page naming every AI feature | `src/app/privacy/page.tsx`, `src/app/ai/page.tsx` |
| Data-subject rights | Self-service export and deletion; admin erasure | `src/app/api/account/export/route.ts`, `src/lib/accountErasure.ts` |
| Optional processing is opt-in | AI CV reading, activity tracking, talent-pool visibility, push, analytics cookies all need separate consent | `src/lib/consent.ts` (`ConsentType`), `src/lib/cookieConsent.ts` |

## 3. Risk register

Likelihood and severity are left for the Controller to score
(`[low / medium / high]`); the mitigation column lists only what exists today.

| # | Risk to data subjects | Likelihood | Severity | Mitigation already in place |
|---|---|---|---|---|
| R1 | One tenant's data visible to another | `[ ]` | `[ ]` | `orgId` on every tenant model and `TENANT_MODELS` (`src/lib/orgContext.ts`), CI drift check `npm run check:tenant-models`, `e2e/tenant-isolation-*.spec.ts`; `docs/tenant-isolation.md` |
| R2 | A mentor, company or admin sees more than their role needs | `[ ]` | `[ ]` | Admin tiers and `requirePermission()` (`src/lib/authz.ts`, `src/lib/authzRule.ts`), `e2e/authz-matrix.spec.ts`, `e2e/role-scoping.spec.ts`; compensation withheld from companies (`OFFER_COMPENSATION_FIELDS`, `src/lib/offers.ts`) |
| R3 | Account takeover | `[ ]` | `[ ]` | Password policy and breached-password check (`src/lib/password.ts`), 2FA policy per role (`src/lib/twoFactorPolicyRule.ts`), new-device notices (`src/lib/securityNotices.ts`), session revocation |
| R4 | Harm to a minor or vulnerable participant through private messaging | `[ ]` | `[ ]` | Safeguarding watch list and per-org message retention (`src/lib/safeguarding.ts`, `docs/safeguarding.md`) |
| R5 | Data kept longer than needed | `[ ]` | `[ ]` | Retention registry with logged nightly run (`src/lib/retentionEntries.ts`); several purposes still **not yet enforced** — see [`ropa.md`](ropa.md) |
| R6 | Erasure leaves personal data behind | `[ ]` | `[ ]` | One erasure module with an explicit coverage list (`src/lib/accountErasure.ts`, `COVERAGE` block), `e2e/erasure-*.spec.ts`; known exceptions published (`privacy.erasureScope`) |
| R7 | Unlawful advertising mail | `[ ]` | `[ ]` | Contact-permission rule with DOI and owner-only confirmation (`src/lib/contactPermissionRule.ts`); outbound approval hook (`src/lib/outboundApprovalRule.ts`); suppression list |
| R8 | Screenshots / replays in bug reports reveal personal data | `[ ]` | `[ ]` | Masking in one place (`src/lib/feedbackContext.ts`), `data-private` fields, replay off in production by default, 90-day retention (`supportReport`) |
| R9 | Third-country transfer without adequate basis | `[ ]` | `[ ]` | Optional integrations dormant until configured; gaps listed in [`dpa-annex-sccs.md`](dpa-annex-sccs.md) § 3 |
| R10 | Breach goes unnoticed or unreported | `[ ]` | `[ ]` | Audit log and drain (`docs/audit-stream.md`), incident procedure with the Art. 33 clock (`docs/incident-response.md`) |
| R11 | Loss of data | `[ ]` | `[ ]` | Daily local and encrypted off-site backups, restore drills (`docs/disaster-recovery.md`) |
| R12 | AI CV parsing — see § 4.1 | | | |
| R13 | Automated candidate ranking — see § 4.2 | | | |

## 4. High-risk processing that needs its own assessment

Both features below are flagged as **high-risk** and must get a dedicated
assessment (and, where it applies, an EU AI Act Annex III classification) before
a Controller switches them on. They belong to the AI epic **#2016**; the public
description of every AI feature, what it sends and what it withholds is the
**`/ai`** page (`src/app/ai/page.tsx`), the engineering view `docs/ai.md`.

### 4.1 AI CV parsing

- **What:** text extracted from an uploaded CV is sent to Anthropic, which
  proposes profile field values (`cv_extract`; also `cv_feedback`).
- **Switches:** dormant unless the deployment sets `ANTHROPIC_API_KEY`; off when
  the organisation's AI kill switch or the per-task switch is off
  (`src/lib/ai/policy.ts`); and **per person**, only with the `AI_CV_PARSING`
  consent, withdrawable under Account → Privacy (`src/lib/ai/tasks.ts`,
  `src/lib/consent.ts`). Every call goes through one gate, `runAiGated`
  (`src/lib/aiGate.ts`); the SDK is imported only in `src/lib/ai/provider.ts`.
- **In place:** text, never the file; the prompt is not stored; contact details
  redacted where the task does not need them (`src/lib/ai/redact.ts`); the person
  applies each proposed field themselves.
- **Open:** no signed DPA or region guarantee with the provider (`docs/ai.md`
  § What we do not have); accuracy of extraction for non-standard CVs; the
  assessment must weigh both.

### 4.2 Automated candidate ranking (requisition fit score, #2042)

- **What:** applicants to a company's requisition are shown in an order set by a
  rule-based fit score — skills, target position, location, programme stage
  (`src/lib/matching/requisitionFit.ts`); with the company's AI package, the
  reasons for the top applicants may be written by AI from anonymous facts only
  (`src/lib/aiRequisitionFit.ts`, `src/lib/matching/fitReason.ts`).
- **In place:** the score **never removes, rejects or advances anyone** — it only
  orders a list, and **a human makes every decision** (`docs/ai.md` § Human in the
  loop). Protected attributes are not fields of the input type, pinned by a unit
  test. Each score is stored with its rule-set version and breakdown so a past
  ranking can be explained (`src/lib/requisitionFitStore.ts`, `RequisitionFit`).
- **Open:** evaluation for indirect discrimination through proxies (city,
  university via skills); information to applicants about the ranking (Art. 13(2)(f)
  is not triggered while no decision is automated, but transparency is still owed);
  the works council's co-determination right on the ranking criteria.

## 5. Outcome

`[Residual risk accepted / further measures / prior consultation (Art. 36)]` ·
`[DPO opinion]` · `[works-council position]` · `[date, sign-off]` ·
review date `[ ]`.
