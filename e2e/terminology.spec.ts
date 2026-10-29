import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupByEmail, cleanupCustomPipelineOrg, prisma, seedCustomPipelineOrg, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { emailDictionary } from '../src/i18n/emailDictionary';

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
  // Custom terminology is a paid-plan setting (#1631); the FREE refusal has its own test.
  await prisma.organization.update({ where: { id: seeded.org.id }, data: { plan: 'PRO' } });
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
    await prisma.notification.deleteMany({ where: { user: { email: { in: seeded.emails } } } });
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

test('resetting a programme lets the org value flow down again', async () => {
  const res = await admin.put('/api/admin/terminology', { data: { terminology: {}, programId: cohortId } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ terminology: { en: { mentor: COACH } }, inherited: true });
  const got = await (await admin.get(`/api/admin/terminology?programId=${cohortId}`)).json();
  expect(got.inherited).toBe(true);
  expect(got.terminology).toEqual({ en: { mentor: COACH } });
});

test('a FREE org is refused by the route, but may always go back to the defaults', async () => {
  await prisma.organization.update({ where: { id: seeded.org.id }, data: { plan: 'FREE' } });
  try {
    const refused = await admin.put('/api/admin/terminology', { data: { terminology: { en: { mentee: GUIDE } } } });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'plan_required', plan: 'FREE' });
    // Nothing was written: the org value is unchanged.
    expect((await (await admin.get('/api/admin/terminology')).json()).terminology).toEqual({ en: { mentor: COACH } });
  } finally {
    await prisma.organization.update({ where: { id: seeded.org.id }, data: { plan: 'PRO' } });
  }
});

test('the renamed noun reaches the recipient: notification and mail dictionary', async ({ page, context }) => {
  const adminRow = await prisma.user.findFirstOrThrow({ where: { email: seeded.adminEmail }, select: { id: true } });
  await prisma.notification.create({
    data: { userId: adminRow.id, type: 'mentorship_request.rematchGeneric', params: {} },
  });
  await context.addCookies([{ name: 'locale', value: 'en', url: test.info().project.use.baseURL! }]);
  await signInAsFreshUser(page, seeded.adminEmail, PW, '/admin');
  await gotoSettled(page, '/notifications');
  await expect(page.getByText('asked to be matched with a different coach').first()).toBeVisible();

  // The mail side reads the same layer for the recipient's org (#1631).
  const mail = await emailDictionary('en', seeded.org.id);
  expect(mail.nav.mentors).toBe('Coaches');
  expect((await emailDictionary('en', null)).nav.mentors).toBe('Mentors');
});

test('the settings card saves a row, refuses a half-filled one, and resets', async ({ page, context }) => {
  await context.addCookies([{ name: 'locale', value: 'en', url: test.info().project.use.baseURL! }]);
  await signInAsFreshUser(page, seeded.adminEmail, PW, '/admin');
  await gotoSettled(page, '/admin/settings');
  const card = page.getByTestId('terminology-card');
  // The stored org value is loaded into the form.
  await expect(card.getByTestId('terminology-en-mentor-manyCap')).toHaveValue('Coaches');

  // A half-filled row is refused in the browser, nothing is sent.
  await card.getByTestId('terminology-en-mentee-one').fill('student');
  await card.getByTestId('terminology-save').click();
  await expect(card.getByTestId('terminology-message')).toContainText('all four forms');

  for (const [form, value] of Object.entries({ many: 'students', oneCap: 'Student', manyCap: 'Students' })) {
    await card.getByTestId(`terminology-en-mentee-${form}`).fill(value);
  }
  // The preview applies the draft before anything is saved.
  await expect(card.getByTestId('terminology-preview')).toHaveText(
    'Each coach meets their students every week; the cohort follows one programme, and every mentorship starts with a goal.',
  );
  await card.getByTestId('terminology-save').click();
  await expect(card.getByTestId('terminology-message')).toHaveText('Saved.');
  expect((await (await admin.get('/api/admin/terminology')).json()).terminology).toEqual({
    en: { mentor: COACH, mentee: { one: 'student', many: 'students', oneCap: 'Student', manyCap: 'Students' } },
  });

  // A programme without its own row shows the org's words and says so.
  await card.getByTestId('terminology-scope').selectOption(cohortId);
  await expect(card.getByTestId('terminology-inherited')).toBeVisible();
  await expect(card.getByTestId('terminology-en-mentee-many')).toHaveValue('students');
  await card.getByTestId('terminology-scope').selectOption('');

  await card.getByTestId('terminology-reset').click();
  await expect(card.getByTestId('terminology-message')).toHaveText('Saved.');
  expect((await (await admin.get('/api/admin/terminology')).json()).terminology).toEqual({});
  await expect(card.getByTestId('terminology-en-mentor-manyCap')).toHaveValue('');
});
