# Programme eligibility (#1945)

Who may be **enrolled as a participant** (a mentee), organisation-wide or per
programme. A programme is a `Cohort` row (#1622's `Program`). This is an
admission control and never a paywall: the app is always free for mentors and
mentees.

- Rule: `src/lib/eligibilityRule.ts`, pure, tested in `scripts/test/eligibility.test.mjs`.
- Loader: `src/lib/eligibility.ts`.
- Builder: `/admin/cohorts/eligibility[?programId=]`.
- API: `/api/admin/eligibility`, plus `/preview` for the dry run.

## Modes

| `Organization.eligibilityMode` | `Cohort.eligibilityMode` | Effective |
|---|---|---|
| `OPEN` (default) | `OPEN` (default) | `OPEN` — nobody is gated, rules are kept but not applied |
| `RULES` | any | `RULES` |
| any | `RULES` | `RULES` |

In `RULES` mode a person is **ineligible by default**: only an `ALLOW` rule
admits them. The rules that apply to a programme are the organisation-wide
ones (`programId` null) plus the programme's own. Without a programme (SSO
JIT, the apply form, a direct assignment) only the organisation's mode and
its organisation-wide rules count.

## Precedence

The same inputs always produce the same decision and name the same rule.

1. Only **active** rules whose condition matches the person count.
2. Higher `priority` first.
3. At equal priority, **`DENY` before `ALLOW`**: a DENY beats an ALLOW.
4. Then the older rule (`createdAt`), then the `id`.
5. The first rule in that order decides. If no rule matches, the answer is `no_matching_rule`: refused.

A higher-priority `ALLOW` is therefore how you write an exception to a `DENY`.

## Attributes and operators

- **Attributes:**
  - the User columns `department`, `city`, `country`, `university`, `targetPosition` and `timezone`;
  - `attr:<key>` for one of the org's own attributes (#1920). These are filled by SSO directory sync (#1943) or by the roster feed.
- **Operators:** `EQUALS`, `IN`, `NOT_IN`, `GTE`, `LTE`, `EXISTS`.
- **Comparison:**
  - Values are trimmed and compared case-insensitively.
  - `GTE` / `LTE` compare numbers, or ISO dates as dates, and nothing else.
  - A person with no value never matches `NOT_IN`.

## Where it is enforced

| Door | Behaviour |
|---|---|
| `POST /api/mentorship` | `403 { code: 'not_eligible', reason, ruleId }`. Admin-only, so the rule is named. |
| `POST /api/apply` (public) | `403 { code: 'not_eligible' }`, judged on the typed profile before an account exists. The rule is not named. |
| SSO JIT (`completeSsoSignIn`) | A NEW `MENTEE` whom nothing admits is created `isActive: false`, `pendingApproval: true`. The login answers `?error=sso_pending_approval` and logs `eligibility.denied` (warning). The login never returns a 500. A returning user is not re-judged. |
| Matching | Match rounds drop ineligible mentees before scoring (the round's cohort). `mentor-suggest` answers `403 not_eligible`. |
| Invitation registration | **Exempt.** An invitation is the exception mechanism. |

Judgement happens after the directory sync, so the department the IdP just
wrote is the one the rule reads.

## Dry run

`POST /api/admin/eligibility/preview { programId?, mode, rules[] }` counts how
many of the org's current `MENTEE` accounts a draft rule set admits, before
anything is saved. It runs two queries (users, attribute values), never one
per person. The builder shows the count live as the draft changes.
