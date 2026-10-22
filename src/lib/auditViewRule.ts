// The pure parts of the audit trail viewer (#1583, GET /api/admin/audit):
// the date range, the PROGRAM_ADMIN target filter and the pairing of an
// impersonation audit row with its ActivityLog twin. Dependency-free and
// unit-tested (scripts/test/audit-view-rule.test.mjs).

/** AuditLog action → the ActivityLog action the same request also wrote. */
export const IMPERSONATION_ACTIVITY: Readonly<Record<string, string>> = Object.freeze({
  IMPERSONATE_START: 'impersonate.start',
  IMPERSONATE_STOP: 'impersonate.stop',
});

/** The twin action, or null — an own-key lookup, so `constructor` is not an action. */
export function impersonationActivityFor(action: string): string | null {
  return Object.hasOwn(IMPERSONATION_ACTIVITY, action) ? IMPERSONATION_ACTIVITY[action] : null;
}

/** The two rows are written by one request, a few milliseconds apart. */
export const PAIR_WINDOW_MS = 10_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string): Date | null {
  if (!DAY.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

/**
 * `from` / `to` as calendar days (YYYY-MM-DD, UTC), both inclusive. Null for
 * no range, 'invalid' for a malformed or reversed one (the route answers 400
 * rather than silently showing everything).
 */
export function auditRangeFrom(
  from: string | null | undefined,
  to: string | null | undefined,
): { gte?: Date; lt?: Date } | null | 'invalid' {
  const f = from?.trim() || null;
  const t = to?.trim() || null;
  if (!f && !t) return null;
  const range: { gte?: Date; lt?: Date } = {};
  if (f) {
    const d = parseDay(f);
    if (!d) return 'invalid';
    range.gte = d;
  }
  if (t) {
    const d = parseDay(t);
    if (!d) return 'invalid';
    range.lt = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  if (range.gte && range.lt && range.gte >= range.lt) return 'invalid';
  return range;
}

export interface GrantLike {
  cohortId: string | null;
  companyId: string | null;
}

const NOBODY = { id: '__none__' } as const;

/**
 * The people a PROGRAM_ADMIN's grants reach, as a User `where`: either side of
 * a relation inside a granted cohort/company (both, when the grant names
 * both), or a company's own account. A grant naming nothing reaches nobody,
 * and so do zero grants — fail closed, never `{}`.
 */
export function auditTargetsWhere(grants: readonly GrantLike[]): object {
  const relationTerms = grants
    .filter((g) => g.cohortId || g.companyId)
    .map((g) => ({
      ...(g.cohortId ? { cohortId: g.cohortId } : {}),
      ...(g.companyId ? { companyId: g.companyId } : {}),
    }));
  if (relationTerms.length === 0) return NOBODY;
  const companyOnly = grants.filter((g) => g.companyId && !g.cohortId).map((g) => g.companyId as string);
  const or: object[] = [
    { menteeRelations: { some: { OR: relationTerms } } },
    { mentorRelations: { some: { OR: relationTerms } } },
  ];
  if (companyOnly.length) or.push({ role: 'COMPANY', companyId: { in: companyOnly } });
  return { OR: or };
}

export interface AuditRowLike {
  action: string;
  actorId: string;
  targetId: string | null;
  createdAt: Date;
}

export interface ActivityRowLike {
  id: string;
  action: string;
  actorId: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

/** The ActivityLog twin of an impersonation audit row: same actor, target and action, nearest in time. */
export function pairActivity(
  row: AuditRowLike,
  candidates: readonly ActivityRowLike[],
): { id: string; ip: string | null; userAgent: string | null } | null {
  const want = impersonationActivityFor(row.action);
  if (!want) return null;
  let best: ActivityRowLike | null = null;
  let bestGap = Infinity;
  for (const c of candidates) {
    if (c.action !== want || c.actorId !== row.actorId || c.targetId !== row.targetId) continue;
    const gap = Math.abs(c.createdAt.getTime() - row.createdAt.getTime());
    if (gap <= PAIR_WINDOW_MS && gap < bestGap) {
      best = c;
      bestGap = gap;
    }
  }
  return best ? { id: best.id, ip: best.ip, userAgent: best.userAgent } : null;
}
