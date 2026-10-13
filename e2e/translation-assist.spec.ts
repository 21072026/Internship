import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle, gotoSettled, signInViaApi } from './helpers/auth';

// Machine-translation assist (#2055, part 1). CI has no provider key, so the
// real endpoint answers 501 — asserted below. The UI test stands in for the
// provider at the network edge with page.route(): the reply deliberately also
// carries a "translation" for the locale the admin wrote, which must NOT
// overwrite it. What is under test is everything the app does with a reply:
// fill the empty locales only, mark them, keep the mark through a save, and
// drop it when the admin edits or confirms.

const PW = 'TranslateAssist123!';
const adminEmail = uniqueEmail('mt-admin');
const mentorEmail = uniqueEmail('mt-mentor');

test.beforeAll(async () => {
  // The admin assists are operator tasks behind the AI pack (#1738); this
  // spec's admin lives in the shared default org, which keeps the pack for the
  // whole run (never removed: other specs run on it in parallel). The locked
  // org is e2e/ai-entitlement.spec.ts's business.
  await setOrgFeature(null, 'AI_PACKAGE', true);
  await seedUser(adminEmail, PW, 'ADMIN', 'MT Admin');
  await seedUser(mentorEmail, PW, 'MENTOR', 'MT Mentor');
});

test.afterAll(async () => {
  await prisma.projectTaskTemplate.deleteMany({ where: { projectId: null, title: { startsWith: 'Ship one small PR' } } });
  for (const e of [adminEmail, mentorEmail]) await cleanupByEmail(e);
});

test('the translate endpoint is admin-only and, without a provider, says so — never a filled map', async ({ playwright }, info) => {
  const baseURL = info.project.use.baseURL;
  const mentor = await playwright.request.newContext({ baseURL });
  const admin = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(mentor, mentorEmail, PW)).ok).toBe(true);
    expect((await signInViaApi(admin, adminEmail, PW)).ok).toBe(true);
    const body = { purpose: 'goal_template', from: 'en', text: 'Ship one small PR', to: ['tr', 'de'] };
    expect((await mentor.post('/api/admin/ai/translate', { data: body })).status()).toBe(403);
    expect((await admin.post('/api/admin/ai/translate', { data: { ...body, purpose: 'poem' } })).status()).toBe(400);
    const res = await admin.post('/api/admin/ai/translate', { data: body });
    expect(res.status()).toBe(501);
    expect(await res.json()).toMatchObject({ code: 'not_configured' });
  } finally {
    await mentor.dispose();
    await admin.dispose();
  }
});

test('one click fills the two empty languages, marks them, never touches the written one, and the mark survives a save until reviewed', { tag: '@smoke' }, async ({ page }) => {
  const stamp = Date.now();
  const en = `Ship one small PR ${stamp}`;
  const sent: unknown[] = [];
  await page.route('**/api/admin/ai/translate', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { translations: { tr: `Küçük bir PR gönder ${stamp}`, de: `Schick einen kleinen PR ${stamp}`, en: 'MACHINE MUST NOT WIN' } } });
  });

  await signInAndSettle(page, adminEmail, PW, '/admin');
  await gotoSettled(page, '/admin/goal-templates');
  const v = (id: string) => page.locator(`[data-testid="${id}"]:visible`);
  await v('new-template-en').fill(en);
  await expect(async () => {
    await v('new-template-translate').click();
    await expect(v('new-template-tr')).toHaveValue(`Küçük bir PR gönder ${stamp}`, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(v('new-template-de')).toHaveValue(`Schick einen kleinen PR ${stamp}`);
  // The written locale is untouched, and only the empty ones were asked for.
  await expect(v('new-template-en')).toHaveValue(en);
  expect(sent[0]).toMatchObject({ purpose: 'goal_template', from: 'en', text: en, to: ['tr', 'de'] });
  await expect(v('new-template-tr-machine')).toBeVisible();
  await expect(v('new-template-de-machine')).toBeVisible();

  // Every language is filled now: nothing left to fill.
  await expect(v('new-template-translate')).toBeDisabled();

  // Confirming DE takes its mark off; TR stays machine-translated through the save.
  await v('new-template-de-machine-confirm').click();
  await expect(v('new-template-de-machine')).toHaveCount(0);
  await v('create-template').click();
  await expect
    .poll(async () => (await prisma.projectTaskTemplate.findFirst({ where: { projectId: null, title: en }, select: { machineTranslated: true } }))?.machineTranslated ?? null, { timeout: 10_000 })
    .toEqual(['tr']);
  const row = await prisma.projectTaskTemplate.findFirstOrThrow({ where: { projectId: null, title: en } });
  expect(row.translations).toMatchObject({ en, tr: `Küçük bir PR gönder ${stamp}`, de: `Schick einen kleinen PR ${stamp}` });

  // Editing TR makes it the admin's: the mark is gone after the next save.
  await v(`edit-template-${row.id}`).click();
  await expect(v(`edit-template-${row.id}-tr-machine`)).toBeVisible();
  await v(`edit-template-${row.id}-tr`).fill(`Küçük bir PR aç ${stamp}`);
  await expect(v(`edit-template-${row.id}-tr-machine`)).toHaveCount(0);
  await v(`save-template-${row.id}`).click();
  await expect
    .poll(async () => (await prisma.projectTaskTemplate.findUnique({ where: { id: row.id }, select: { machineTranslated: true } }))?.machineTranslated ?? null, { timeout: 10_000 })
    .toEqual([]);
});
