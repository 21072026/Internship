/**
 * The 2FA policy vocabulary (#1644) — pure and dependency-free, so the admin
 * settings form (a client component), the server-side gate and a unit test
 * all read one rule.
 *
 * A mode is a SET OF ROLES held at the setup gate: `off` covers nobody,
 * `admins` the ADMIN role, `admins_mentors` ADMIN + MENTOR, and `all` every
 * role the product has — MENTEE, COMPANY, SOURCE and AFFILIATE included. "Stricter" is
 * set inclusion, not list order: a mode is stricter than another when it
 * covers a role the other does not. That is the one question the settings
 * form asks before letting an admin switch, because the gate holds a person on
 * their NEXT page load — turning `all` on at 0 % mentee enrolment locks the
 * whole tenant out at once.
 */

export const REQUIRE_2FA_MODES = ['off', 'admins', 'admins_mentors', 'all'] as const;
export type Require2faMode = (typeof REQUIRE_2FA_MODES)[number];

/** Every role a session can carry; the coverage report has one row per entry. */
// AFFILIATE (docs/affiliate-module.md) is here so `all` holds partners too: a partner
// edits the bank account commissions are paid to.
export const TWO_FACTOR_ROLES = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE', 'AFFILIATE'] as const;
export type TwoFactorRole = (typeof TWO_FACTOR_ROLES)[number];

const COVERED: Record<Require2faMode, readonly TwoFactorRole[]> = {
  off: [],
  admins: ['ADMIN'],
  admins_mentors: ['ADMIN', 'MENTOR'],
  all: TWO_FACTOR_ROLES,
};

export function isRequire2faMode(value: unknown): value is Require2faMode {
  return typeof value === 'string' && (REQUIRE_2FA_MODES as readonly string[]).includes(value);
}

/** A stored value, read defensively: anything unknown is `off` (the code default). */
export function parseRequire2faMode(value: string | null | undefined): Require2faMode {
  return isRequire2faMode(value) ? value : 'off';
}

export function rolesCoveredBy(mode: Require2faMode): readonly TwoFactorRole[] {
  return COVERED[mode];
}

/** Does `mode` hold this role at the gate? An unknown role is never held. */
export function roleCoveredBy(mode: Require2faMode, role: string): boolean {
  return (COVERED[mode] as readonly string[]).includes(role);
}

/** `next` covers at least one role `current` does not. */
export function isStricterMode(next: Require2faMode, current: Require2faMode): boolean {
  const now = new Set<string>(COVERED[current]);
  return COVERED[next].some((r) => !now.has(r));
}

export interface RoleCoverage {
  role: TwoFactorRole;
  /** Active accounts of the role. */
  total: number;
  /** Of those, how many have two-factor on. */
  enabled: number;
  /** 0–100, integer; 100 for a role nobody holds (nothing to lock out). */
  percentage: number;
}

export function coveragePercentage(enabled: number, total: number): number {
  if (total <= 0) return 100;
  return Math.floor((enabled / total) * 100);
}

/** The roles' coverage folded into one row. */
export function coverageFor(rows: readonly RoleCoverage[], roles: readonly TwoFactorRole[]): { total: number; enabled: number; percentage: number } {
  const wanted = new Set<string>(roles);
  let total = 0;
  let enabled = 0;
  for (const r of rows) {
    if (!wanted.has(r.role)) continue;
    total += r.total;
    enabled += r.enabled;
  }
  return { total, enabled, percentage: coveragePercentage(enabled, total) };
}

/**
 * How many people the switch from `current` to `next` would hold at the gate
 * on their next page load: accounts without 2FA in the roles `next` covers and
 * `current` does not. Zero when the switch is not stricter.
 */
export function newlyHeldAtGate(next: Require2faMode, current: Require2faMode, rows: readonly RoleCoverage[]): number {
  const now = new Set<string>(COVERED[current]);
  const added = COVERED[next].filter((r) => !now.has(r));
  const c = coverageFor(rows, added);
  return c.total - c.enabled;
}
