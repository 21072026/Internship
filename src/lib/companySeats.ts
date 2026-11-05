// Team seats at a company (#1870, docs/company-team-seats.md) — the pure rule,
// unit-tested in scripts/test/company-seats.test.mjs.
//
// One company used to be one flat COMPANY login. A real employer has a recruiter
// who screens, a hiring manager who decides and interviewers who only need the
// person they are about to meet. The seat role says which; `companyCan()` is the
// ONE answer to "may this seat do that", and requireCompanySeat()
// (src/lib/companySeatGate.ts) is the one place a route asks it. Seat roles are
// ORTHOGONAL to entitlements: talent-pool search needs the seat AND the feature.

export const SEAT_ROLES = ['OWNER', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER'] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];

export function isSeatRole(value: unknown): value is SeatRole {
  return typeof value === 'string' && (SEAT_ROLES as readonly string[]).includes(value);
}

/** A COMPANY user with no membership row: the company's first login, from before seats existed. */
export const IMPLICIT_SEAT_ROLE: SeatRole = 'OWNER';

const ACTION_TABLE = {
  'requisition.write': ['OWNER', 'RECRUITER', 'HIRING_MANAGER'],
  'application.stage.write': ['OWNER', 'RECRUITER', 'HIRING_MANAGER'],
  // INTERVIEWER reads only applications of panels it sits on — the route
  // narrows the rows; this says the seat may read at all.
  'application.read': ['OWNER', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER'],
  'outreach.request': ['OWNER', 'RECRUITER'],
  'interview.request': ['OWNER', 'RECRUITER', 'HIRING_MANAGER'],
  'company.profile.write': ['OWNER'],
  'team.manage': ['OWNER'],
  'entitlement.read': ['OWNER'],
  'talentPool.search': ['OWNER', 'RECRUITER'],
} as const satisfies Record<string, readonly SeatRole[]>;

export type CompanyAction = keyof typeof ACTION_TABLE;
export const COMPANY_ACTIONS = Object.keys(ACTION_TABLE) as CompanyAction[];

export function companyCan(seatRole: string | null | undefined, action: CompanyAction): boolean {
  return isSeatRole(seatRole) && (ACTION_TABLE[action] as readonly string[]).includes(seatRole);
}

/** The refusal every gated route answers with (403). */
export const INSUFFICIENT_SEAT_ROLE = 'insufficient_seat_role';

// ── Team management ─────────────────────────────────────────────────────────

/**
 * Would this change leave the company without an OWNER? Changing the last
 * owner's role, or removing the last owner, is refused — nobody could manage
 * the team (or the profile) after it.
 */
export function leavesNoOwner(input: { owners: number; targetIsOwner: boolean; nextRole: SeatRole | null }): boolean {
  if (!input.targetIsOwner) return false;
  if (input.nextRole === 'OWNER') return false;
  return input.owners <= 1;
}

/**
 * The seat limit: `Company.quota`, which used to drive nothing. NULL means
 * unlimited, which is every company's behaviour before #1870. `used` counts the
 * seats taken (memberships, including the implicit owner) plus live invitations.
 */
export function seatLimitReached(input: { quota: number | null; used: number }): boolean {
  return input.quota != null && input.used >= input.quota;
}
