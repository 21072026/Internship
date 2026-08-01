import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
import { MATRIX, type MatrixUser, type Role } from './fixtures/authz-matrix';

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

const users = {} as Record<Role, MatrixUser>;
let ownCompanyId = '';
let otherCompanyId = '';
let ownSourceId = '';
let ownRelationId = '';
let foreignRelationId = '';
/** Mentee ids this SOURCE referred — the ground truth for its `own` cells. */
const sourcedMenteeIds = new Set<string>();

test.beforeAll(async () => {
  const [admin, mentor, mentee, company, source, otherMentor, otherMentee] = await Promise.all([
    seedUser(emails.ADMIN, PASSWORD, 'ADMIN', 'Matrix Admin'),
    seedUser(emails.MENTOR, PASSWORD, 'MENTOR', 'Matrix Mentor'),
    seedUser(emails.MENTEE, PASSWORD, 'MENTEE', 'Matrix Mentee'),
    seedUser(emails.COMPANY, PASSWORD, 'COMPANY', 'Matrix Company'),
    seedUser(emails.SOURCE, PASSWORD, 'SOURCE', 'Matrix Source'),
    seedUser(otherMentorEmail, 'x', 'MENTOR', 'Other Mentor'),
    seedUser(otherMenteeEmail, 'x', 'MENTEE', 'Other Mentee'),
  ]);

  const [own, other] = await Promise.all([
    prisma.company.create({ data: { name: `Matrix Own ${Date.now()}` } }),
    prisma.company.create({ data: { name: `Matrix Other ${Date.now()}` } }),
  ]);
  ownCompanyId = own.id;
  otherCompanyId = other.id;

  const src = await prisma.source.create({ data: { name: `Matrix Source ${Date.now()}` } });
  ownSourceId = src.id;

  await Promise.all([
    prisma.user.update({ where: { id: company.id }, data: { companyId: own.id } }),
    prisma.user.update({ where: { id: source.id }, data: { sourceId: src.id } }),
    // The mentee in "our" relation was referred by this source, so SOURCE has a
    // non-empty legitimate scope — an all-empty scope would make `own` vacuous.
    prisma.user.update({ where: { id: mentee.id }, data: { sourceId: src.id } }),
  ]);
  sourcedMenteeIds.add(mentee.id);

  const [ours, foreign] = await Promise.all([
    prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, companyId: own.id },
    }),
    prisma.mentorshipRelation.create({
      data: { mentorId: otherMentor.id, menteeId: otherMentee.id, companyId: other.id },
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
  users.MENTOR = { id: mentor.id, role: 'MENTOR' };
  users.MENTEE = { id: mentee.id, role: 'MENTEE' };
  users.COMPANY = { id: company.id, role: 'COMPANY', companyId: own.id };
  users.SOURCE = { id: source.id, role: 'SOURCE', sourceId: src.id };
});

test.afterAll(async () => {
  await prisma.interactionLog.deleteMany({ where: { relationId: { in: [ownRelationId, foreignRelationId] } } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [ownRelationId, foreignRelationId] } } });
  for (const email of [...Object.values(emails), otherMentorEmail, otherMenteeEmail]) {
    await cleanupByEmail(email);
  }
  await prisma.company.deleteMany({ where: { id: { in: [ownCompanyId, otherCompanyId] } } });
  await prisma.source.deleteMany({ where: { id: ownSourceId } });
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
      const res = await page.request.get(entry.path);

      if (expectation === 'deny') {
        expect([401, 403], `${role} ${entry.path} must be refused`).toContain(res.status());
        continue;
      }

      expect(res.status(), `${role} ${entry.path}`).toBe(200);
      if (!entry.collection) continue;

      const rows = (await res.json())[entry.collection] as Record<string, unknown>[] | undefined;
      expect(Array.isArray(rows), `${entry.path} should return ${entry.collection}[]`).toBe(true);

      if (expectation === 'own') {
        const owns = (row: Record<string, unknown>) =>
          role === 'SOURCE' ? sourceOwns(row, entry.path) : entry.ownership(row, user);
        const foreign = (rows ?? []).filter((row) => !owns(row));
        expect(
          foreign,
          `${role} received ${foreign.length} row(s) from ${entry.path} it does not own`
        ).toEqual([]);
      }
    }
  });
}

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
