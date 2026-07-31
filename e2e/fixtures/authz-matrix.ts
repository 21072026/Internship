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
}

export interface MatrixEntry {
  path: string;
  /** Key in the JSON response holding the array of rows. */
  collection: string;
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
    path: '/api/source/mentees',
    collection: 'mentees',
    expect: { ADMIN: 'deny', MENTOR: 'deny', MENTEE: 'deny', COMPANY: 'deny', SOURCE: 'own' },
    ownership: () => true, // the route scopes to the caller's own source by construction
  },
];
