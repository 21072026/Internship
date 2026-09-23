import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
import { COMPANY_ID_PARAM, MATRIX, type MatrixUser, type Role } from './fixtures/authz-matrix';

/**
 * Executable role × endpoint read matrix (#899).
 *
 * The audit's worst finding — COMPANY and SOURCE reading every mentee's
 * interaction log — was found by hand and survived a closed RBAC epic (#278),
 * because nothing in the suite said "this role must not see that".
 *
 * The important part is what an `own` cell asserts: not the status code, but
 * that **every row returned belongs to the caller**. The leak answered `200`
 * throughout, so a status-only test would have passed against it.
 *
 * This seeds its own two-sided world rather than leaning on `seed:demo`, so it
 * is self-contained and safe to run against any environment.
 */

const PASSWORD = 'MatrixPass123';
const LANDING: Record<Role, string> = {
  ADMIN: '/admin',
  MENTOR: '/mentor',
  MENTEE: '/portal',
  COMPANY: '/company',
  SOURCE: '/source',
};

const emails: Record<Role, string> = {
  ADMIN: uniqueEmail('mx-admin'),
  MENTOR: uniqueEmail('mx-mentor'),
  MENTEE: uniqueEmail('mx-mentee'),
  COMPANY: uniqueEmail('mx-company'),
  SOURCE: uniqueEmail('mx-source'),
};
// The "other side": a second mentor/mentee pair nobody above may see.
const otherMentorEmail = uniqueEmail('mx-other-mentor');
const otherMenteeEmail = uniqueEmail('mx-other-mentee');
// A COMPANY user that IS assigned to a company. `users.COMPANY` above is
// deliberately unassigned (the #807 `/api/mentorship` contract probe), which
// makes its company scope `{ id: '__none__' }` — so its matrix `own` cells pass
// on an empty list and would keep passing if the builder were narrowed to
// nothing at all. This second account is the positive half at route level
// (#2432): it must read its own row and 404 on the foreign one.
const assignedCompanyEmail = uniqueEmail('mx-company-assigned');

const users = {} as Record<Role, MatrixUser>;
let ownCompanyId = '';
let otherCompanyId = '';
let orgId = '';
let ownSourceId = '';
let ownRelationId = '';
let foreignRelationId = '';
/** Mentee ids this SOURCE referred — the ground truth for its `own` cells. */
const sourcedMenteeIds = new Set<string>();

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Matrix Org ${Date.now()}`, slug: `matrix-org-${Date.now()}` },
  });
  orgId = org.id;
  const [admin, mentor, mentee, company, source, otherMentor, otherMentee, assignedCompany] =
    await Promise.all([
      seedUser(emails.ADMIN, PASSWORD, 'ADMIN', 'Matrix Admin'),
      seedUser(emails.MENTOR, PASSWORD, 'MENTOR', 'Matrix Mentor'),
      seedUser(emails.MENTEE, PASSWORD, 'MENTEE', 'Matrix Mentee'),
      seedUser(emails.COMPANY, PASSWORD, 'COMPANY', 'Matrix Company'),
      seedUser(emails.SOURCE, PASSWORD, 'SOURCE', 'Matrix Source'),
      seedUser(otherMentorEmail, 'x', 'MENTOR', 'Other Mentor'),
      seedUser(otherMenteeEmail, 'x', 'MENTEE', 'Other Mentee'),
      seedUser(assignedCompanyEmail, PASSWORD, 'COMPANY', 'Matrix Assigned Company'),
    ]);

  const [own, other] = await Promise.all([
    prisma.company.create({ data: { name: `Matrix Own ${Date.now()}`, orgId } }),
    prisma.company.create({ data: { name: `Matrix Other ${Date.now()}`, orgId } }),
  ]);
  ownCompanyId = own.id;
  otherCompanyId = other.id;

  const src = await prisma.source.create({ data: { name: `Matrix Source ${Date.now()}` } });
  ownSourceId = src.id;

  await Promise.all([
    prisma.user.update({ where: { id: admin.id }, data: { orgId } }),
    prisma.user.update({ where: { id: mentor.id }, data: { orgId } }),
    // Story #807 contract probe: this COMPANY deliberately belongs to the
    // tenant but has no company assignment. /api/mentorship must fail early.
    prisma.user.update({ where: { id: company.id }, data: { orgId } }),
    prisma.user.update({ where: { id: source.id }, data: { sourceId: src.id, orgId } }),
    // The mentee in "our" relation was referred by this source, so SOURCE has a
    // non-empty legitimate scope — an all-empty scope would make `own` vacuous.
    prisma.user.update({ where: { id: mentee.id }, data: { sourceId: src.id, orgId } }),
    prisma.user.update({ where: { id: otherMentor.id }, data: { orgId } }),
    prisma.user.update({ where: { id: otherMentee.id }, data: { orgId } }),
    // The assigned counterpart: same tenant, and it owns "our" company.
    prisma.user.update({
      where: { id: assignedCompany.id },
      data: { orgId, companyId: own.id },
    }),
  ]);
  sourcedMenteeIds.add(mentee.id);

  const [ours, foreign] = await Promise.all([
    prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, companyId: own.id, orgId },
    }),
    prisma.mentorshipRelation.create({
      data: { mentorId: otherMentor.id, menteeId: otherMentee.id, companyId: other.id, orgId },
    }),
  ]);
  ownRelationId = ours.id;
  foreignRelationId = foreign.id;

  await prisma.interactionLog.createMany({
    data: [
      { relationId: ours.id, date: new Date(), notes: 'matrix own note', type: 'Meeting' },
      { relationId: foreign.id, date: new Date(), notes: 'matrix foreign note', type: 'Meeting' },
    ],
  });

  users.ADMIN = { id: admin.id, role: 'ADMIN' };
  // The mentor's one relation points at "our" company — the only company its
  // `company` scope may reach (#2432).
  users.MENTOR = { id: mentor.id, role: 'MENTOR', relationCompanyIds: [own.id] };
  users.MENTEE = { id: mentee.id, role: 'MENTEE' };
  users.COMPANY = { id: company.id, role: 'COMPANY', companyId: null };
  users.SOURCE = { id: source.id, role: 'SOURCE', sourceId: src.id };
});

test.afterAll(async () => {
  await prisma.interactionLog.deleteMany({ where: { relationId: { in: [ownRelationId, foreignRelationId] } } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [ownRelationId, foreignRelationId] } } });
  for (const email of [...Object.values(emails), otherMentorEmail, otherMenteeEmail, assignedCompanyEmail]) {
    await cleanupByEmail(email);
  }
  await prisma.company.deleteMany({ where: { id: { in: [ownCompanyId, otherCompanyId] } } });
  await prisma.source.deleteMany({ where: { id: ownSourceId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

/**
 * SOURCE ownership needs the mentee's `sourceId`, which the list payloads don't
 * carry. Resolve it against what we seeded instead of trusting the response to
 * describe itself.
 */
function sourceOwns(row: Record<string, unknown>, path: string): boolean {
  if (path === '/api/mentorship') return sourcedMenteeIds.has((row as { menteeId: string }).menteeId);
  if (path === '/api/interactions') {
    const rel = (row as { relation?: { menteeId?: string } }).relation;
    return !!rel?.menteeId && sourcedMenteeIds.has(rel.menteeId);
  }
  return true;
}

for (const role of Object.keys(LANDING) as Role[]) {
  test(`authorization matrix · ${role}`, { tag: '@smoke' }, async ({ page }) => {
    await signInAsFreshUser(page, emails[role], PASSWORD, LANDING[role]);
    const user = users[role];

    for (const entry of MATRIX) {
      const expectation = entry.expect[role];

      // A detail path is probed with the caller's own company AND the foreign
      // one (#2432): a scope that is right for the id you own and wrong for
      // the one you don't is exactly the shape of leak this table exists for.
      const probes = entry.path.includes(COMPANY_ID_PARAM)
        ? [ownCompanyId, otherCompanyId].map((id) => ({ path: entry.path.replace(COMPANY_ID_PARAM, id), id }))
        : [{ path: entry.path, id: undefined as string | undefined }];

      for (const probe of probes) {
        const res = await page.request.get(probe.path);

        // Story #807 intentionally tightened this one matrix cell. Keep the
        // fixture unassigned so the general smoke suite locks the early denial.
        if (role === 'COMPANY' && entry.path === '/api/mentorship') {
          expect(res.status()).toBe(403);
          expect((await res.json()).code).toBe('company_not_assigned');
          continue;
        }

        if (expectation === 'deny') {
          expect([401, 403], `${role} ${probe.path} must be refused`).toContain(res.status());
          continue;
        }

        if (entry.single) {
          // In scope → 200 and the row is the caller's; outside a defined scope
          // → 404, the same answer a non-existent id gets (never 403 — that is
          // the UNDEFINED-scope answer, asserted through `deny` cells above).
          const mayRead = expectation === 'all' || (probe.id !== undefined && entry.ownership({ id: probe.id }, user));
          if (!mayRead) {
            expect(res.status(), `${role} ${probe.path} is outside its scope`).toBe(404);
            continue;
          }
          expect(res.status(), `${role} ${probe.path}`).toBe(200);
          const row = (await res.json())[entry.collection] as Record<string, unknown> | undefined;
          expect(row && typeof row === 'object', `${probe.path} should return ${entry.collection}`).toBe(true);
          expect((row as { id?: string }).id, `${probe.path} answered with a different row`).toBe(probe.id);
          continue;
        }

        expect(res.status(), `${role} ${probe.path}`).toBe(200);
        if (!entry.collection) continue;

        const rows = (await res.json())[entry.collection] as Record<string, unknown>[] | undefined;
        expect(Array.isArray(rows), `${probe.path} should return ${entry.collection}[]`).toBe(true);

        if (expectation === 'own') {
          const owns = (row: Record<string, unknown>) =>
            role === 'SOURCE' ? sourceOwns(row, entry.path) : entry.ownership(row, user);
          const foreign = (rows ?? []).filter((row) => !owns(row));
          expect(
            foreign,
            `${role} received ${foreign.length} row(s) from ${probe.path} it does not own`
          ).toEqual([]);
        }
      }
    }
  });
}

/**
 * The company book, as its own named case (#2396/#2431): the matrix above
 * already refuses MENTEE and SOURCE, but the story's acceptance criterion is
 * spelled "cannot read companies", so a regression should read as that. Also
 * the half the matrix cannot see: an `own` cell passes vacuously when the
 * scope is EMPTY, so both roles that HAVE a company scope must actually get
 * their row back — the mentor's related company and the assigned company
 * account's own record. Without that positive half, narrowing either builder
 * to "nothing at all" would still leave the whole matrix green. And a refusal
 * must leave the `authz.scope_denied` audit row `logScopeDenial()` promises,
 * which is the whole reason MENTEE/SOURCE get 403 rather than a quiet `[]`.
 */
test('MENTEE and SOURCE cannot read the company book; a mentor reads only its own companies', { tag: '@smoke' }, async ({ page }) => {
  for (const role of ['MENTEE', 'SOURCE'] as const) {
    await signInAsFreshUser(page, emails[role], PASSWORD, LANDING[role]);
    const list = await page.request.get('/api/companies');
    expect(list.status(), `${role} must be refused the company list`).toBe(403);
    expect(await list.text(), `${role} must not receive a company row`).not.toContain(ownCompanyId);
    const detail = await page.request.get(`/api/companies/${ownCompanyId}`);
    expect(detail.status(), `${role} must be refused a company it is even related to`).toBe(403);

    // `logScopeDenial()` is awaited before the 403 goes out, so the rows exist.
    // The detail route logs the route PATTERN, never the requested id — an
    // attacker-chosen string has no business in `ActivityLog.targetId`.
    for (const target of ['GET /api/companies', 'GET /api/companies/[id]']) {
      const denial = await prisma.activityLog.findFirst({
        where: { action: 'authz.scope_denied', actorId: users[role].id, targetId: target },
      });
      expect(denial, `${role}'s refusal of ${target} must be audited as authz.scope_denied`).not.toBeNull();
    }
  }

  await signInAsFreshUser(page, emails.MENTOR, PASSWORD, LANDING.MENTOR);
  // `all=1` since #2437 paged this route: the claim under test is "exactly the
  // companies of this mentor's relations", and a foreign row merely sitting on
  // page 2 would satisfy a paged assertion while the leak was real.
  const res = await page.request.get('/api/companies?all=1');
  expect(res.status()).toBe(200);
  const ids = ((await res.json()).companies as { id: string }[]).map((c) => c.id);
  expect(ids, 'the company of the mentor\'s own relation must be readable').toContain(ownCompanyId);
  expect(ids, 'the foreign company must not').not.toContain(otherCompanyId);
  // The detail payload's nested relations follow the `relation` scope: the
  // mentor sees its own relation at this company and nobody else's.
  const detail = await page.request.get(`/api/companies/${ownCompanyId}`);
  expect(detail.status()).toBe(200);
  const relations = ((await detail.json()).company.mentorships as { id: string; mentorId: string }[]);
  expect(relations.map((r) => r.id)).toEqual([ownRelationId]);
});

/**
 * The positive half of the COMPANY cells (#2432). The matrix's COMPANY user is
 * deliberately unassigned for the #807 contract probe, so its company scope is
 * `{ id: '__none__' }`: the list comes back empty, the detail probes 404, and
 * every one of those assertions would still pass if `BUILDERS.company.COMPANY`
 * were changed to return `NO_MATCH` unconditionally. Only an ASSIGNED account
 * proves the builder is composed correctly by the routes rather than merely
 * denying everything.
 *
 * Deliberately NOT `@smoke`, unlike its sibling above: the risks are
 * asymmetric. A WIDENING regression is a live leak and belongs on the PR gate;
 * an over-NARROWING one costs a company account a list no shipped COMPANY
 * screen reads today (the company portal goes through `/api/company/*`), so
 * the 4×/day full run is the right place for it and the smoke set stays small
 * (CLAUDE.md).
 */
test('an assigned COMPANY account reads its own company and nothing else', async ({ page }) => {
  await signInAsFreshUser(page, assignedCompanyEmail, PASSWORD, '/company');

  const list = await page.request.get('/api/companies?all=1');
  expect(list.status()).toBe(200);
  const ids = ((await list.json()).companies as { id: string }[]).map((c) => c.id);
  expect(ids, 'an assigned company account reads exactly its own row').toEqual([ownCompanyId]);

  const own = await page.request.get(`/api/companies/${ownCompanyId}`);
  expect(own.status(), 'its own company is readable by id').toBe(200);
  expect(((await own.json()).company as { id: string }).id).toBe(ownCompanyId);

  // Outside a DEFINED scope → 404, the same answer a non-existent id gets.
  // 403 is reserved for a role whose scope is undefined (MENTEE/SOURCE above).
  const foreign = await page.request.get(`/api/companies/${otherCompanyId}`);
  expect(foreign.status(), 'a foreign company is a 404, never a 403 or a 200').toBe(404);
});

/**
 * The specific shape of the original leak, kept as its own named case so a
 * regression reads as itself rather than as "the matrix broke".
 */
test('COMPANY and SOURCE cannot read a foreign relation\'s interaction log', { tag: '@smoke' }, async ({ page }) => {
  for (const role of ['COMPANY', 'SOURCE'] as const) {
    await signInAsFreshUser(page, emails[role], PASSWORD, LANDING[role]);
    const body = await (await page.request.get('/api/interactions')).json();
    const ids = (body.interactions as { relationId: string }[]).map((i) => i.relationId);
    expect(ids, `${role} must not see the foreign relation`).not.toContain(foreignRelationId);
  }
});

/**
 * Re-match privacy (#1801), as a matrix case rather than a comment: the mentee
 * writes candidly about their mentor, so the mentor must not be able to read it
 * back — not through their own inbox, not through the admin queue. The admin
 * side of the same assertion is what keeps this from passing vacuously.
 */
test('the outgoing mentor cannot read the mentee\'s re-match reason', { tag: '@smoke' }, async ({ page }) => {
  const secret = `rematch-secret-${Date.now()}`;
  const req = await prisma.mentorshipRequest.create({
    data: {
      menteeId: users.MENTEE.id,
      preferredMentorId: users.MENTOR.id,
      replacesRelationId: ownRelationId,
      rematchReason: 'no_fit',
      rematchNote: secret,
    },
  });
  try {
    await signInAsFreshUser(page, emails.MENTOR, PASSWORD, LANDING.MENTOR);
    // The mentor's own inbox excludes re-match requests entirely, even one that
    // names them as the preferred replacement.
    const inbox = await page.request.get('/api/mentor/applications');
    expect(inbox.status()).toBe(200);
    expect(await inbox.text(), 'a mentor must never read a re-match note').not.toContain(secret);
    // And they cannot decide it either — same not-found shape as any other
    // request they have no business touching.
    const decide = await page.request.put('/api/mentor/applications', {
      data: { requestId: req.id, action: 'accept' },
    });
    expect(decide.status()).toBe(404);
    const queue = await page.request.get('/api/admin/mentorship-requests');
    expect([401, 403]).toContain(queue.status());

    // The admin queue is the one place it IS readable — otherwise the check
    // above would pass on a note nobody stored.
    await signInAsFreshUser(page, emails.ADMIN, PASSWORD, LANDING.ADMIN);
    const adminQueue = await page.request.get('/api/admin/mentorship-requests');
    expect(adminQueue.status()).toBe(200);
    expect(await adminQueue.text()).toContain(secret);
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { id: req.id } });
  }
});

/**
 * A filter must not be able to widen the scope (#2288).
 *
 * `GET /api/mentorship` built its `where` by spreading the scope and then
 * ASSIGNING `where.OR = [...search terms...]`. A mentor's scope is itself an
 * `OR` over both sides of the relation, so `?search=` replaced it wholesale and
 * one request returned every relation in the database — each mentee's id, name,
 * e-mail, university and pipeline position included.
 *
 * The assertion has to be on the SEARCH path: the unsearched list was always
 * correctly scoped, so a test without `?search=` passes against the bug. The
 * second half (the mentor's own row still being findable) is what keeps the
 * first half from being satisfied by a filter that matches nothing at all.
 */
test('a mentor cannot widen its scope with ?search=', { tag: '@smoke' }, async ({ page }) => {
  await signInAsFreshUser(page, emails.MENTOR, PASSWORD, LANDING.MENTOR);

  // "Other" matches the foreign pair on all three searched columns (its
  // mentor's name, its mentee's name and its company's name) and matches
  // nothing in the caller's own relation — so any row that comes back is a row
  // the search reached past the scope for.
  const res = await page.request.get('/api/mentorship?search=Other');
  expect(res.status()).toBe(200);
  const relations = (await res.json()).relations as
    | { id: string; mentorId: string; menteeId: string }[]
    | undefined;
  expect(Array.isArray(relations), 'GET /api/mentorship should return relations[]').toBe(true);
  expect(
    (relations ?? []).map((relation) => relation.id),
    'the foreign relation must not be reachable through search'
  ).not.toContain(foreignRelationId);
  const foreign = (relations ?? []).filter(
    (relation) => relation.mentorId !== users.MENTOR.id && relation.menteeId !== users.MENTOR.id
  );
  expect(
    foreign,
    `search returned ${foreign.length} relation(s) this mentor is not part of`
  ).toEqual([]);

  const own = await page.request.get('/api/mentorship?search=Matrix Mentee');
  expect(own.status()).toBe(200);
  expect(
    ((await own.json()).relations as { id: string }[]).map((relation) => relation.id),
    'search must still find the mentor\'s own relation'
  ).toContain(ownRelationId);
});
