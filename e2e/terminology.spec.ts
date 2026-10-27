import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupByEmail, cleanupCustomPipelineOrg, prisma, seedCustomPipelineOrg, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';

// Per-tenant terminology (#1629): an org's stored nouns reach the UI it
// renders, a programme's value overrides the org's, a malformed document is
// pruned before it is stored, and nothing crosses a tenant. A throwaway org,
// so no other spec ever reads "Coaches".

const PW = 'Terminology123!';
const COACH = { one: 'coach', many: 'coaches', oneCap: 'Coach', manyCap: 'Coaches' };
const GUIDE = { one: 'guide', many: 'guides', oneCap: 'Guide', manyCap: 'Guides' };
let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;
let admin: APIRequestContext;
let otherAdmin: APIRequestContext;
const otherAdminEmail = uniqueEmail('terminology-other-admin');
let cohortId = '';
let otherCohortId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  seeded = await seedCustomPipelineOrg('terminology', PW);
  await seedUser(otherAdminEmail, PW, 'ADMIN', 'Terminology Other Admin');
  cohortId = (await prisma.cohort.create({ data: { orgId: seeded.org.id, name: 'Terminology cohort' } })).id;
  const defaultOrg = (await prisma.user.findFirst({ where: { email: otherAdminEmail }, select: { orgId: true } }))?.orgId ?? null;
  otherCohortId = (await prisma.cohort.create({ data: { orgId: defaultOrg, name: 'Terminology other cohort' } })).id;
  const baseURL = info.project.use.baseURL;
  [admin, otherAdmin] = await Promise.all([1, 2].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(admin, seeded.adminEmail, PW)).ok).toBe(true);
  expect((await signInViaApi(otherAdmin, otherAdminEmail, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([admin, otherAdmin].map((c) => c?.dispose()));
  if (seeded) {
    await prisma.setting.deleteMany({ where: { orgId: seeded.org.id } });
    await prisma.cohort.deleteMany({ where: { id: { in: [cohortId, otherCohortId].filter(Boolean) } } });
    await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  }
  await cleanupByEmail(otherAdminEmail);
});

test('an org override is stored pruned and renames the nouns in the admin UI', async ({ page, context }) => {
  const put = await admin.put('/api/admin/terminology', {
    data: { terminology: { en: { mentor: COACH, mentee: { one: 'student' }, wizard: COACH }, fr: { mentor: COACH } } },
  });
  expect(put.status()).toBe(200);
  // The incomplete token, the unknown token and the unknown locale are dropped.
  expect((await put.json()).terminology).toEqual({ en: { mentor: COACH } });

  await context.addCookies([{ name: 'locale', value: 'en', url: test.info().project.use.baseURL! }]);
  await signInAsFreshUser(page, seeded.adminEmail, PW, '/admin');
  await gotoSettled(page, '/admin');
  const nav = page.locator('a[href="/admin/mentors"]').first();
  await expect(nav).toContainText('Coaches');
  await expect(nav).not.toContainText('Mentors');
});

test('a programme value overrides the org, and another tenant sees neither', async () => {
  const put = await admin.put('/api/admin/terminology', { data: { terminology: { en: { mentor: GUIDE } }, programId: cohortId } });
  expect(put.status()).toBe(200);
  expect((await (await admin.get(`/api/admin/terminology?programId=${cohortId}`)).json()).terminology).toEqual({ en: { mentor: GUIDE } });
  expect((await (await admin.get('/api/admin/terminology')).json()).terminology).toEqual({ en: { mentor: COACH } });

  // Another tenant's programme is not addressable, and its admin inherits nothing.
  expect((await admin.put('/api/admin/terminology', { data: { terminology: {}, programId: otherCohortId } })).status()).toBe(404);
  expect((await (await otherAdmin.get('/api/admin/terminology')).json()).terminology).toEqual({});
});
