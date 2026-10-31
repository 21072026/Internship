// Program scope (#1577) — what a PROGRAM_ADMIN's AdminScopeGrant rows reach,
// as Prisma `where` fragments. Pure and dependency-free, so
// `node --test --experimental-strip-types` loads it directly
// (scripts/test/program-scope-rule.test.mjs). WHO is narrowed (the tier) is
// authzRule.ts; this file only says what a set of grants covers, and every
// list a PROGRAM_ADMIN may read narrows through it — the relation builder in
// authzScope.ts, the audit viewer, the candidate and user lists.
//
// A grant names a cohort, a company, or both (both narrows to both). A grant
// naming nothing reaches nothing, and zero grants reach nothing: fail closed,
// never `{}`. A relation with no cohort and no company is outside every grant —
// deliberately (docs/role-access-matrix.md § Program scope).

import { grantCovers } from './authzRule';

export interface GrantLike {
  cohortId: string | null;
  companyId: string | null;
}

/** The sentinel id no row carries — the same value as authzScope's NO_MATCH. */
export const NOBODY = { id: '__none__' } as const;

/** One MentorshipRelation `where` term per grant that names something. */
export function grantRelationTerms(grants: readonly GrantLike[]): Array<{ cohortId?: string; companyId?: string }> {
  return grants
    .filter((g) => g.cohortId || g.companyId)
    .map((g) => ({
      ...(g.cohortId ? { cohortId: g.cohortId } : {}),
      ...(g.companyId ? { companyId: g.companyId } : {}),
    }));
}

/** The relations the grants reach, or NOBODY. */
export function programRelationWhere(grants: readonly GrantLike[]): object {
  const terms = grantRelationTerms(grants);
  return terms.length ? { OR: terms } : NOBODY;
}

/** The candidates (mentee side of a relation) the grants reach, as a User `where`, or NOBODY. */
export function programMenteeWhere(grants: readonly GrantLike[]): object {
  const terms = grantRelationTerms(grants);
  return terms.length ? { menteeRelations: { some: { OR: terms } } } : NOBODY;
}

/**
 * The people the grants reach, as a User `where`: either side of a relation
 * inside a granted cohort/company, or a company-only grant's own COMPANY
 * accounts. NOBODY without a grant that names something.
 */
export function programPeopleWhere(grants: readonly GrantLike[]): object {
  const terms = grantRelationTerms(grants);
  if (terms.length === 0) return NOBODY;
  const companyOnly = grants.filter((g) => g.companyId && !g.cohortId).map((g) => g.companyId as string);
  const or: object[] = [
    { menteeRelations: { some: { OR: terms } } },
    { mentorRelations: { some: { OR: terms } } },
  ];
  if (companyOnly.length) or.push({ role: 'COMPANY', companyId: { in: companyOnly } });
  return { OR: or };
}

// ── Who hears about it (#3485) ──────────────────────────────────────────────
// A fan-out to "the org's admins" (a bell, a digest, an escalation mail) is a
// read: it carries names and stages. So it follows the same scope as the
// lists. An ORG_ADMIN and an OBSERVER hear about everything in their org (an
// empty tier column is ORG_ADMIN, authzRule.ts). A PROGRAM_ADMIN hears about a
// subject only when one of its grants covers it — the one coverage rule,
// `grantCovers()` — and never about an org-level event (a sign-up, a support
// ticket, a plan limit), which has no programme to be inside. An unknown tier
// hears nothing.

/** User `where` for the admins who receive org-level notices: ORG_ADMIN (or an empty column) and OBSERVER. */
export const ORG_LEVEL_ADMIN_WHERE: { OR: Array<{ adminLevel: null } | { adminLevel: { in: string[] } }> } = {
  OR: [{ adminLevel: null }, { adminLevel: { in: ['ORG_ADMIN', 'OBSERVER'] } }],
};

/** What a notice is about, as far as a grant can cover it. null = the org itself. */
export interface NoticeSubject {
  cohortId?: string | null;
  companyId?: string | null;
}

export function adminReceives(
  tier: 'ORG_ADMIN' | 'PROGRAM_ADMIN' | 'OBSERVER' | null,
  grants: readonly GrantLike[],
  subject: NoticeSubject | null,
): boolean {
  if (tier === 'ORG_ADMIN' || tier === 'OBSERVER') return true;
  if (tier !== 'PROGRAM_ADMIN' || !subject) return false;
  const s = { cohortId: subject.cohortId ?? null, companyId: subject.companyId ?? null };
  return grants.some((g) => grantCovers(g, s));
}
