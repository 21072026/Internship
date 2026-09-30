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
  {
    // One company, one JSON file (#2435). ADMIN-only: MENTOR and COMPANY may
    // READ a company, but no role other than the operator may take the whole
    // account book away in one file (the route header says why), so both of
    // their cells are `deny` here where the detail route above says `own`.
    // Probed with the own and the foreign id like the detail route; the file's
    // contents, the cross-org 404 and the audit row are pinned by
    // e2e/company-export.spec.ts.
    path: `/api/companies/${COMPANY_ID_PARAM}/export`,
    collection: 'company',
    single: true,
    expect: { ADMIN: 'all', MENTOR: 'deny', MENTEE: 'deny', COMPANY: 'deny', SOURCE: 'deny' },
    ownership: () => true,
  },
];

/**
 * Cross-TENANT rows (#2542). Everything above is one organization, so `all`
 * there means "the whole tenant" and says nothing about a second one. Since
 * the MARKETING vertical became a real tenant on the same database, "which
 * org" is a question every read has to answer — with MT_ENFORCE_ISOLATION off,
 * which is every deployment today. The spec seeds a foreign MARKETING org
 * (a mentee, an admin and a company) and probes each path below as every role:
 *
 * - `list`   — whatever the status, the body must not carry a foreign id (a
 *              200 that leaks is the whole failure mode, see the ⚠️ above).
 * - `detail` — never 200. A role allowed on the route gets 404, the same answer
 *              as an id that does not exist; the others keep their 401/403.
 *
 * Adding a tenant-held list or detail route an ADMIN can reach? Add it here.
 */
export const FOREIGN_USER_ID_PARAM = ':foreignUserId';
export const FOREIGN_COMPANY_ID_PARAM = ':foreignCompanyId';

export interface CrossTenantEntry {
  path: string;
  kind: 'list' | 'detail';
}

export const CROSS_TENANT: CrossTenantEntry[] = [
  { path: '/api/users', kind: 'list' },
  { path: '/api/users?role=MENTEE', kind: 'list' },
  { path: '/api/users?view=directory', kind: 'list' },
  { path: '/api/users?page=1&perPage=100', kind: 'list' },
  { path: '/api/candidates?all=1', kind: 'list' },
  { path: '/api/companies?all=1', kind: 'list' },
  { path: '/api/companies?all=1&sort=movement', kind: 'list' },
  { path: `/api/users/${FOREIGN_USER_ID_PARAM}`, kind: 'detail' },
  { path: `/api/users/${FOREIGN_USER_ID_PARAM}/activity`, kind: 'detail' },
  { path: `/api/companies/${FOREIGN_COMPANY_ID_PARAM}`, kind: 'detail' },
  { path: `/api/companies/${FOREIGN_COMPANY_ID_PARAM}/delete-impact`, kind: 'detail' },
];

/**
 * Instance-level writes only a SUPER ADMIN may make (#1535). Every role in the
 * matrix — the plain tenant ADMIN included, which is exactly the case this list
 * exists for — must be refused (401/403), and the refusal must happen before
 * anything is written. `:orgId` is the foreign MARKETING org the spec seeds: the
 * realistic target, "a tenant admin minting an admin login for somebody else's
 * tenant". Mirrored in docs/role-access-matrix.md.
 */
export const TARGET_ORG_ID_PARAM = ':orgId';

export interface SuperAdminProbe {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
  why: string;
}

export const SUPER_ADMIN_ONLY: SuperAdminProbe[] = [
  {
    method: 'POST',
    path: `/api/admin/organizations/${TARGET_ORG_ID_PARAM}/invite-admin`,
    body: { email: '' },
    why: 'invite an ADMIN into any organization (docs/worlds.md § İkinci dünyaya davet)',
  },
];

/**
 * The MARKETING sales rep (#2580): a MENTOR of a MARKETING org, on the sales
 * surface. Everything above is an INTERNSHIP-shaped tenant; this block is the
 * same statement for the rep, consumed by `e2e/marketing-sales-surface.spec.ts`
 * and mirrored in `docs/role-access-matrix.md` § "MARKETING satış temsilcisi".
 *
 * Placeholders the spec substitutes from what it seeded:
 * - `:ownRelationId` / `:ownCompanyId` / `:ownLeadId` — the rep's own record,
 *   the account behind it and the lead (MENTEE) on it;
 * - `:colleagueRelationId` / `:colleagueCompanyId` — a record and an account of
 *   ANOTHER rep of the same org;
 * - `:foreignRelationId` / `:foreignCompanyId` — a record and an account of a
 *   second MARKETING org.
 *
 * Expectations:
 * - `deny`      — 401/403 (the 401-for-a-wrong-role answer of older admin
 *                 routes is kept; what matters is that no admin work happens);
 * - `notFound`  — 404, the answer for an id that does not exist;
 * - `forbidden` — 403 exactly;
 * - `ok`        — 200.
 */
export type SalesExpectation = 'deny' | 'notFound' | 'forbidden' | 'ok';

export interface SalesProbe {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  expect: SalesExpectation;
  why: string;
}

/** Admin-only work: settings, users, invites, deletes, imports, organization. */
export const MARKETING_MENTOR_ADMIN_ONLY: SalesProbe[] = [
  { method: 'GET', path: '/api/admin/settings', expect: 'deny', why: 'tenant settings' },
  { method: 'PUT', path: '/api/admin/settings', body: {}, expect: 'deny', why: 'tenant settings' },
  { method: 'GET', path: '/api/admin/organizations', expect: 'deny', why: 'organization settings' },
  { method: 'PATCH', path: '/api/admin/organizations', body: {}, expect: 'deny', why: 'organization settings' },
  { method: 'GET', path: '/api/admin/invitations', expect: 'deny', why: 'invitation management' },
  { method: 'POST', path: '/api/admin/invite/bulk', body: {}, expect: 'deny', why: 'bulk invite' },
  // The mentor self-invite path is a mentorship-module write; MARKETING has
  // none, so the capability gate answers before the role list (#2580).
  { method: 'POST', path: '/api/invite', body: { role: 'MENTEE', email: '' }, expect: 'forbidden', why: 'invite (capability)' },
  { method: 'POST', path: '/api/admin/import', body: {}, expect: 'deny', why: 'import' },
  { method: 'POST', path: '/api/admin/marketing-accounts', body: {}, expect: 'deny', why: 'account import' },
  { method: 'POST', path: '/api/admin/import/marketing-accounts', body: {}, expect: 'deny', why: 'account file import (#2552)' },
  { method: 'GET', path: '/api/admin/company-inquiries', expect: 'deny', why: 'demo request queue' },
  { method: 'GET', path: '/api/admin/activity', expect: 'deny', why: 'activity log' },
  { method: 'GET', path: '/api/admin/analytics', expect: 'deny', why: 'tenant analytics' },
  { method: 'GET', path: '/api/users/:ownLeadId', expect: 'deny', why: 'user management (read)' },
  { method: 'PATCH', path: '/api/users/:ownLeadId', body: {}, expect: 'deny', why: 'user management (write)' },
  { method: 'POST', path: '/api/admin/users/:ownLeadId/reset-password', body: {}, expect: 'deny', why: 'user management' },
  { method: 'POST', path: '/api/admin/users/:ownLeadId/erase', body: {}, expect: 'deny', why: 'erasure' },
  { method: 'POST', path: '/api/companies', body: { name: 'x' }, expect: 'deny', why: 'create account' },
  { method: 'PUT', path: '/api/companies/:ownCompanyId', body: {}, expect: 'deny', why: 'edit account' },
  { method: 'DELETE', path: '/api/companies/:ownCompanyId', expect: 'deny', why: 'delete account' },
  { method: 'POST', path: '/api/mentorship', body: {}, expect: 'deny', why: 'assign a record' },
  { method: 'POST', path: '/api/mentorship/:ownRelationId/transfer', body: {}, expect: 'deny', why: 'reassign a record' },
];

/** The rep's own rows versus a colleague's and another org's. */
export const MARKETING_MENTOR_ROWS: SalesProbe[] = [
  { method: 'GET', path: '/api/mentorship/:ownRelationId', expect: 'ok', why: 'own record' },
  { method: 'GET', path: '/api/mentorship/:colleagueRelationId', expect: 'forbidden', why: "a colleague's record" },
  // Resolved inside the caller's tenant first (#2613): another org's record
  // answers like a missing one, not with a 403 that confirms it exists.
  { method: 'GET', path: '/api/mentorship/:foreignRelationId', expect: 'notFound', why: "another org's record" },
  { method: 'PUT', path: '/api/mentorship/:foreignRelationId', body: { nextActionNote: 'x' }, expect: 'notFound', why: "another org's record" },
  { method: 'PUT', path: '/api/mentorship/:colleagueRelationId', body: { nextActionNote: 'x' }, expect: 'forbidden', why: "a colleague's record" },
  // Re-pointing a record at an account is ADMIN-only in every vertical
  // (#2613); the role check answers before the id is looked up.
  { method: 'PUT', path: '/api/mentorship/:ownRelationId', body: { companyId: ':colleagueCompanyId' }, expect: 'forbidden', why: "re-point own record at a colleague's account" },
  { method: 'PUT', path: '/api/mentorship/:ownRelationId', body: { companyId: ':foreignCompanyId' }, expect: 'forbidden', why: "re-point own record at another org's account" },
  // Same rule for the project (an ACTIVE relation's project is team membership) and cohort (#2618).
  { method: 'PUT', path: '/api/mentorship/:ownRelationId', body: { projectId: 'any-project' }, expect: 'forbidden', why: 'attach own record to a project' },
  { method: 'PUT', path: '/api/mentorship/:ownRelationId', body: { cohortId: 'any-cohort' }, expect: 'forbidden', why: 'move own record to a cohort' },
  { method: 'GET', path: '/api/companies/:ownCompanyId', expect: 'ok', why: 'own account' },
  { method: 'GET', path: '/api/companies/:colleagueCompanyId', expect: 'notFound', why: "a colleague's account" },
  { method: 'GET', path: '/api/companies/:foreignCompanyId', expect: 'notFound', why: "another org's account" },
];

/** The sales surface pages: own record 200, anything else a real 404. */
export const MARKETING_MENTOR_PAGES: Array<{ path: string; expect: 200 | 404; why: string }> = [
  { path: '/sales', expect: 200, why: 'dashboard' },
  { path: '/sales/board', expect: 200, why: 'board' },
  { path: '/sales/accounts', expect: 200, why: 'own accounts' },
  { path: '/sales/accounts/:ownCompanyId', expect: 200, why: 'own account' },
  { path: '/sales/leads/:ownRelationId', expect: 200, why: 'own record' },
  { path: '/sales/accounts/:colleagueCompanyId', expect: 404, why: "a colleague's account" },
  { path: '/sales/leads/:colleagueRelationId', expect: 404, why: "a colleague's record" },
  { path: '/sales/accounts/:foreignCompanyId', expect: 404, why: "another org's account" },
  { path: '/sales/leads/:foreignRelationId', expect: 404, why: "another org's record" },
];
