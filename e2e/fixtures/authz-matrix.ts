/**
 * Declarative role × endpoint read matrix (#899).
 *
 * The 2026-07 audit's most serious finding — COMPANY and SOURCE reading every
 * mentee's interaction log — was found by hand, and it survived a *closed* RBAC
 * epic (#278) because nothing executable said "this role must not see that".
 * This table is that statement.
 *
 * ⚠️ Checking the status code is not enough. The leak returned `200` on every
 * request; it lived in the rows. So an `'own'` cell asserts that **every row
 * that came back belongs to the caller**, via the `ownership` predicate.
 *
 * The prose version, and what to do when adding a role, live in
 * `docs/role-access-matrix.md`. Keep the two in step.
 */

export type Role = 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY' | 'SOURCE';

/**
 * - `all`  — sees the whole tenant, by design.
 * - `own`  — may see rows, but only rows `ownership` accepts.
 * - `deny` — must be refused (401/403).
 */
export type Expectation = 'all' | 'own' | 'deny';

export interface MatrixUser {
  id: string;
  role: Role;
  companyId?: string | null;
  sourceId?: string | null;
  /**
   * Companies reachable through a relation this user is named in — the seeded
   * ground truth for MENTOR's company cells. A company row does not say which
   * relations point at it, so the spec fills this from what it created rather
   * than trusting the response to describe itself (same idea as SOURCE).
   */
  relationCompanyIds?: string[];
}

/**
 * Where the spec substitutes the seeded company ids. An entry whose `path`
 * carries it is probed TWICE — once with the caller's own company, once with
 * the foreign one — and the `ownership` predicate decides, per probe, whether
 * the expected answer is 200 (in scope) or 404 (outside a defined scope).
 */
export const COMPANY_ID_PARAM = ':companyId';

export interface MatrixEntry {
  path: string;
  /** Key in the JSON response holding the array of rows (or the one row, see `single`). */
  collection: string;
  /**
   * The response holds ONE row under `collection`, not an array (a detail
   * route). For an `own` cell the spec then expects **200** when `ownership`
   * accepts the probed id and **404** when it does not — never 403, which is
   * reserved for a role whose scope is UNDEFINED (`deny`). That split is the
   * repo convention documented in `src/lib/authzScope.ts` and
   * `docs/role-access-matrix.md`, not something this fixture invents.
   */
  single?: boolean;
  expect: Record<Role, Expectation>;
  /** True when `row` legitimately belongs to `user`. Only consulted for `own`. */
  ownership: (row: Record<string, unknown>, user: MatrixUser) => boolean;
}

type Relation = {
  mentorId?: string;
  menteeId?: string;
  companyId?: string | null;
  mentee?: { id?: string; sourceId?: string | null };
};

function relationBelongsTo(rel: Relation | undefined, user: MatrixUser): boolean {
  if (!rel) return false;
  switch (user.role) {
    case 'MENTOR':
      return rel.mentorId === user.id;
    case 'MENTEE':
      return rel.menteeId === user.id;
    case 'COMPANY':
      return !!user.companyId && rel.companyId === user.companyId;
    case 'SOURCE':
      // The list payload doesn't carry the mentee's sourceId, so the spec
      // resolves ownership against the seeded set instead of guessing here.
      return false;
    default:
      return false;
  }
}

/**
 * A company row is the caller's when it is their own account (COMPANY) or is
 * reached through a relation they are named in (MENTOR). MENTEE and SOURCE
 * never own one: their cells are `deny`, so this is not consulted for them.
 */
function companyBelongsTo(row: { id?: string }, user: MatrixUser): boolean {
  if (!row.id) return false;
  switch (user.role) {
    case 'COMPANY':
      return !!user.companyId && row.id === user.companyId;
    case 'MENTOR':
      return (user.relationCompanyIds ?? []).includes(row.id);
    default:
      return false;
  }
}

export const MATRIX: MatrixEntry[] = [
  {
    path: '/api/mentorship',
    collection: 'relations',
    expect: { ADMIN: 'all', MENTOR: 'own', MENTEE: 'own', COMPANY: 'own', SOURCE: 'own' },
    ownership: (row, user) => relationBelongsTo(row as Relation, user),
  },
  {
    path: '/api/interactions',
    collection: 'interactions',
    expect: { ADMIN: 'all', MENTOR: 'own', MENTEE: 'own', COMPANY: 'own', SOURCE: 'own' },
    ownership: (row, user) => relationBelongsTo((row as { relation?: Relation }).relation, user),
  },
  {
    path: '/api/users',
    collection: 'users',
    // Admin-only listing; MENTOR gets a deliberately PII-free picker instead.
    expect: { ADMIN: 'all', MENTOR: 'all', MENTEE: 'deny', COMPANY: 'deny', SOURCE: 'deny' },
    ownership: () => true,
  },
  {
    // Needs `q` (a shorter query short-circuits to an empty result), so the
    // point of this row is the deny side: it is admin/mentor-only.
    path: '/api/search?q=matrix',
    collection: 'users',
    expect: { ADMIN: 'all', MENTOR: 'all', MENTEE: 'deny', COMPANY: 'deny', SOURCE: 'deny' },
    ownership: () => true,
  },
  {
    path: '/api/admin/analytics',
    collection: '',
    expect: { ADMIN: 'all', MENTOR: 'deny', MENTEE: 'deny', COMPANY: 'deny', SOURCE: 'deny' },
    ownership: () => true,
  },
  {
    path: '/api/admin/activity',
    collection: 'items',
    expect: { ADMIN: 'all', MENTOR: 'deny', MENTEE: 'deny', COMPANY: 'deny', SOURCE: 'deny' },
    ownership: () => true,
  },
  {
    // The referrer picker's source list (#1296) — names only, and open to
    // MENTOR because the merged referrer field sits on screens mentors use.
    path: '/api/sources',
    collection: 'sources',
    expect: { ADMIN: 'all', MENTOR: 'all', MENTEE: 'deny', COMPANY: 'deny', SOURCE: 'deny' },
    ownership: () => true,
  },
  {
    path: '/api/source/mentees',
    collection: 'mentees',
    expect: { ADMIN: 'deny', MENTOR: 'deny', MENTEE: 'deny', COMPANY: 'deny', SOURCE: 'own' },
    ownership: () => true, // the route scopes to the caller's own source by construction
  },
  {
    // The company book (#2396/#2432). Until #2431 this answered every signed-in
    // role with every company in the tenant, contactEmail included — a 200 on
    // every request, so only the row check below could have caught it.
    // MENTEE/SOURCE have no company scope at all (docs/role-access-matrix.md
    // § MARKETING dikeyi) → 403 + an `authz.scope_denied` activity row.
    //
    // `all=1` since #2437 paged this route. The cell under test is "every row
    // returned belongs to the caller", and against a paged answer that claim
    // would only ever be checked over the first 24 rows — a leak surfacing on
    // page 2 would pass. The deny cells are unaffected: the scope refusal
    // happens before any query parameter is read.
    path: '/api/companies?all=1',
    collection: 'companies',
    expect: { ADMIN: 'all', MENTOR: 'own', MENTEE: 'deny', COMPANY: 'own', SOURCE: 'deny' },
    ownership: (row, user) => companyBelongsTo(row as { id?: string }, user),
  },
  {
    // The detail route, probed with the own AND the foreign company id. Scope
    // undefined (MENTEE/SOURCE) → 403 for both; id outside a defined scope
    // (the foreign company for MENTOR, both for an unassigned COMPANY) → 404,
    // indistinguishable from an id that does not exist.
    path: `/api/companies/${COMPANY_ID_PARAM}`,
    collection: 'company',
    single: true,
    expect: { ADMIN: 'all', MENTOR: 'own', MENTEE: 'deny', COMPANY: 'own', SOURCE: 'deny' },
    ownership: (row, user) => companyBelongsTo(row as { id?: string }, user),
  },
];
