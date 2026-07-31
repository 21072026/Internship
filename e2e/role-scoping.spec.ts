import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

/**
 * Regression lock for the allowlist-by-omission leak (#847 / #848): COMPANY and
 * SOURCE fell past the role chain in `/api/interactions` and `/api/mentorship`
 * with an empty `where`, so both read every relation and every interaction log
 * in the tenant. A 200 was returned in each case — status codes alone never
 * caught this, so these assertions check *ownership of the rows*.
 */

const PASSWORD = 'ScopePass123';

const mentorEmail = uniqueEmail('scope-mentor');
const menteeEmail = uniqueEmail('scope-mentee');
const companyEmail = uniqueEmail('scope-company');
const sourceEmail = uniqueEmail('scope-source');

let relationId = '';
let otherCompanyId = '';
let ownCompanyId = '';
let sourceRecordId = '';

test.beforeAll(async () => {
  const [mentor, mentee] = await Promise.all([
    seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Scope Mentor'),
    seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Scope Mentee'),
  ]);

  // Two companies: the relation belongs to `other`, the COMPANY user to `own`.
  const [own, other] = await Promise.all([
    prisma.company.create({ data: { name: `Scope Own ${Date.now()}` } }),
    prisma.company.create({ data: { name: `Scope Other ${Date.now()}` } }),
  ]);
  ownCompanyId = own.id;
  otherCompanyId = other.id;

  // A SOURCE that has referred nobody — its legitimate scope is empty.
  const source = await prisma.source.create({ data: { name: `Scope Source ${Date.now()}` } });
  sourceRecordId = source.id;

  await seedUser(companyEmail, PASSWORD, 'COMPANY', 'Scope Company');
  await seedUser(sourceEmail, PASSWORD, 'SOURCE', 'Scope Source User');
  await Promise.all([
    prisma.user.update({ where: { email: companyEmail }, data: { companyId: own.id } }),
    prisma.user.update({ where: { email: sourceEmail }, data: { sourceId: source.id } }),
  ]);

  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: other.id },
  });
  relationId = relation.id;
  await prisma.interactionLog.create({
    data: { relationId: relation.id, date: new Date(), notes: 'scope-probe-note', type: 'Meeting' },
  });
});

test.afterAll(async () => {
  await prisma.interactionLog.deleteMany({ where: { relationId } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
  for (const email of [mentorEmail, menteeEmail, companyEmail, sourceEmail]) {
    await cleanupByEmail(email);
  }
  await prisma.company.deleteMany({ where: { id: { in: [ownCompanyId, otherCompanyId] } } });
  await prisma.source.deleteMany({ where: { id: sourceRecordId } });
  await prisma.$disconnect();
});

test('COMPANY cannot read another company\'s relations or interaction logs', { tag: '@smoke' }, async ({ page }) => {
  await signInAndSettle(page, companyEmail, PASSWORD, '/company');

  const interactions = await (await page.request.get('/api/interactions')).json();
  expect(interactions.interactions.map((i: { relationId: string }) => i.relationId)).not.toContain(relationId);

  // Naming the out-of-scope relation explicitly must not bypass the scope.
  const targeted = await (await page.request.get(`/api/interactions?relationId=${relationId}`)).json();
  expect(targeted.interactions).toHaveLength(0);

  const relations = await (await page.request.get('/api/mentorship')).json();
  expect(relations.relations.map((r: { id: string }) => r.id)).not.toContain(relationId);
});

test('SOURCE with no referrals reads no relations and no interaction logs', { tag: '@smoke' }, async ({ page }) => {
  await signInAsFreshUser(page, sourceEmail, PASSWORD, '/source');

  const interactions = await (await page.request.get('/api/interactions')).json();
  expect(interactions.interactions.map((i: { relationId: string }) => i.relationId)).not.toContain(relationId);

  const relations = await (await page.request.get('/api/mentorship')).json();
  expect(relations.relations.map((r: { id: string }) => r.id)).not.toContain(relationId);
});

test('MENTOR and MENTEE still see their own relation and its logs', async ({ page }) => {
  await signInAsFreshUser(page, mentorEmail, PASSWORD, '/mentor');
  const mentorLogs = await (await page.request.get('/api/interactions')).json();
  expect(mentorLogs.interactions.map((i: { relationId: string }) => i.relationId)).toContain(relationId);

  await signInAsFreshUser(page, menteeEmail, PASSWORD, '/portal');
  const menteeRelations = await (await page.request.get('/api/mentorship')).json();
  expect(menteeRelations.relations.map((r: { id: string }) => r.id)).toContain(relationId);
});
