# Company → candidate message requests (#1840)

A company may ask to write to a candidate it has shortlisted. The candidate's
mentor (or an admin) is the gate, the company has a monthly quota, and the
candidate can close the channel at any time. Nothing a candidate or a mentor
does here is gated by a plan (free core).

## The flow

1. **Request** — `POST /api/company/outreach` (`COMPANY`), `{ menteeId, message }`.
   Refused unless, read from the database:
   - the candidate is **shortlisted by this company**: an `Application` of the
     company at `SHORTLISTED` or later, or a `SHORTLISTED` `CompanyInterest`
     (else `404 not_shortlisted` — a company learns nothing about a person it has
     not shortlisted);
   - the candidate has an active **`TALENT_POOL_VISIBILITY`** consent (`403 no_consent`);
   - no request is pending or open, and none was revoked in the last **90 days**
     (`409 pending | already_approved | cooldown`); a declined one may be asked again;
   - the company is **under its monthly quota** (`403 { code: 'quota_exceeded', limit, used }`).
   The first message is **stored** on the `CandidateOutreach` row, not delivered.
   The candidate's active mentor is notified (the org's admins when there is none);
   the candidate is not — a pending request is invisible to them.
2. **Decision** — `PATCH /api/company/outreach/[id]` `{ action: 'approve' | 'decline' }`
   by the candidate's **active mentor** or an **admin** of the org, a guarded
   `updateMany` on `PENDING` (two deciders cannot both win). Approve: the DIRECT
   conversation between the requesting company user and the candidate is created
   or reused, the stored message posted, and the candidate told **with** the
   company's name. Decline: nothing is delivered; the company hears "not
   approved" — no reason is accepted, so none can leak.
3. **Candidate control** — `PATCH … { action: 'revoke' }` by the candidate on an
   approved channel: `REVOKED` + `revokedAt`, the company user is removed from the
   conversation, and `canMessage()` (src/lib/conversations.ts) — which allows a
   company user and a candidate to talk only while an **approved** outreach links
   them — refuses every later post.

Who sees which request is one rule, `outreachActorWhere()` in `src/lib/outreach.ts`
(a row outside it is a 404). The pure rules — transitions, cooldown, quota period
and limit, the company's view — are in `src/lib/outreachRule.ts`, unit-tested in
`scripts/test/candidate-outreach.test.mjs`.

## The talent-pool door (#1394)

A company may also ask for an **introduction** to a candidate it found in the
talent pool — no shortlist needed. Same endpoint, `POST /api/company/outreach`
`{ menteeId, message, via: 'TALENT_POOL' }`, same row (`CandidateOutreach.source
= 'TALENT_POOL'`; older rows read `SHORTLIST`), same decision, quota, cooldown
and revoke. What the door adds, all checked on the server:

- the seat that may search the pool (`talentPool.search`) on top of
  `outreach.request`, and the company's `TALENT_POOL_SEARCH` entitlement
  (`403 feature_locked`);
- the candidate must be in the pool **this** company may search —
  `talentPoolVisibleWhere()` (`src/lib/talentPool.ts`), the rule the search
  itself reads: the caller's own org, a public-profile opt-in, an active
  `TALENT_POOL_VISIBILITY` consent and the early-access window. Anyone else
  (another org, no opt-in, a withdrawn consent) answers **`404 not_in_pool`**;
- a per-company limit of **20 introductions a day** (bucket
  `candidate-outreach-pool`, every seat of the company together), on top of
  the per-user hourly limit;
- an `AuditLog` row per request (`OUTREACH_REQUESTED`, `detail: source=…`, never
  the message) and per decision (`OUTREACH_APPROVED` / `_DECLINED` / `_REVOKED`).

A candidate without a mentor is decided by the org's admins, exactly as a
shortlist request is. **No contact detail reaches the company before an
approval**: the search returns `TALENT_POOL_SELECT` only (the public-profile
fields), and a request answers `{ id, status }`; `companyView()` is pinned by
its unit test and the `@smoke` spec `e2e/talent-pool-intro.spec.ts` asserts the
response shapes. No mail is sent on this door either.

The pool is scoped to the caller's org **explicitly** (`orgId` in
`talentPoolVisibleWhere()`): the tenant middleware scopes `User` reads only
under `MT_ENFORCE_ISOLATION`, and before #1394 the search showed every org's
opted-in candidates wherever that flag was off.

## The quota

`src/lib/outreachQuota.ts`: requests **approved** per company per calendar month
(UTC), a later revoke still counting. The limit is `Company.quota` when an admin
set one, else the org setting `outreachMonthlyQuota` (default 20). It is checked
when a company **asks** — never when a mentor approves or a message is sent, so a
candidate's thread is never cut off by a meter. The plan-level meter belongs to
the commercial epic (#1727).

## Where it shows

- `/company/candidates/[id]` — the request card (server answers decide everything).
- `/messages` — one panel, three views: the deciders' pending queue with the stored
  first message, the candidate's open channels with "Close conversation", the
  company's own requests and their status.

All notifications are in-app only (`outreach.*` in the catalogue); no e-mail is sent.
