# Company team seats (#1870)

Before this change a company had one COMPANY login with one flat permission
set. A real employer has a recruiter who screens, a hiring manager who
decides, and interviewers who only need to see the person they are about to
meet. A seat role says which.

## The model

`CompanyMembership` stores `orgId`, `companyId`, `userId`, `seatRole` and
`invitedById`, with `@@unique([companyId, userId])`. It is registered in
`TENANT_MODELS`.

`seatRole` is one of `OWNER | RECRUITER | HIRING_MANAGER | INTERVIEWER`.

**`User.companyId` stays.** It is still the source of truth for which company
a login belongs to. The membership only adds the role. Nothing is re-keyed,
because re-keying `User` would be a drop-and-recreate under `db push`.

A COMPANY login **without** a membership row is its company's first login,
from before seats existed or created by the enquiry conversion or the
self-signup. It reads as **OWNER** (`IMPLICIT_SEAT_ROLE`), which is the flat
permission set it always had. Backfill `0037-company-memberships` makes these
rows explicit. It only adds rows, so a second run reports `created=0`.
Registration writes the row for every new COMPANY login: the role named on a
teammate invitation, or OWNER.

## Who may do what

The rule is `companyCan(seatRole, action)` in `src/lib/companySeats.ts`. It is
pure and unit-tested:

| action | OWNER | RECRUITER | HIRING_MANAGER | INTERVIEWER |
|---|---|---|---|---|
| `requisition.write` | ✓ | ✓ | ✓ | |
| `application.stage.write` | ✓ | ✓ | ✓ | |
| `application.read` | ✓ | ✓ | ✓ | own panels only |
| `outreach.request` | ✓ | ✓ | | |
| `interview.request` | ✓ | ✓ | ✓ | |
| `company.profile.write`, `team.manage`, `entitlement.read` | ✓ | | | |
| `talentPool.search` | ✓ | ✓ | | |

**Enforcement is server-side, through one helper.** `requireCompanySeat(session,
action)` (`src/lib/companySeatGate.ts`) answers `403 insufficient_seat_role`.
It is called in:

- `/api/requisitions` (POST) and `/api/requisitions/[id]` (PATCH)
- `/api/applications/[id]/stage` and `/api/applications/bulk-stage`
- `/api/company/interests` (POST)
- `/api/interview-requests` (POST)
- `/api/company/talent-pool`
- `/api/company/outreach` (POST)
- the COMPANY branch of `PUT /api/companies/[id]`
- `/api/company/team`

Admins and every non-COMPANY role pass straight through. Their own
permissions (`src/lib/authz.ts`) already decided, so seats are a refinement
*inside* a company, not a second permission system.

**An INTERVIEWER reads only its panels' candidates.** `seatScopedActor()` adds
the mentee ids of the panels the user sits on (`InterviewPanelMember`) to the
actor, and `visibleApplicationsWhere()` applies them in the WHERE. Counts and
pages therefore stay right.

**Seat roles and entitlements are orthogonal.** Talent-pool search needs both
the seat and `hasFeature('TALENT_POOL_SEARCH')`.

## The team screen

`/company/team` (`GET/POST /api/company/team`, `PATCH/DELETE
/api/company/team/[userId]`):

- Everyone with a seat can see the list.
- Only an OWNER can invite, change a role or remove a member.
- The invitation token is mailed, never returned.
- Leaving the company without an OWNER is refused with `409 last_owner`.
  Removing yourself is refused with `400 not_yourself`.
- **Removing** a member deletes the membership, detaches the login
  (`companyId = null`) and deactivates it. It also sets `sessionsValidFrom`
  and revokes the trusted devices (docs/remember-me.md). The User row itself
  stays.
- Role changes are audited as `COMPANY_SEAT_ROLE`, removals as
  `COMPANY_SEAT_REMOVED`, each with `orgId`.

## The seat limit

`Company.quota`, which drove nothing before, is the seat limit. Inviting past
it answers `403 { code: 'seat_limit_reached', limit, used }`, where `used`
counts active logins plus live invitations. A NULL quota means unlimited,
which is today's behaviour.
