import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupByEmail, cleanupCustomPipelineOrg, prisma, seedCustomPipelineOrg, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { renderNotificationEmail } from '../src/lib/notifications/emailRender';
import { notifyEvent } from '../src/lib/notifications/router';
import { runNotificationEmail } from '../src/lib/notifications/emailJob';
import type { JobRecord } from '../src/lib/jobs/queue';

// The notification template editor (#1719): edit → preview → test → reset,
// the preview being the real renderer, the test going to the caller only, the
// routes ADMIN-only and tenant-scoped, and a saved template reaching the next
// real event mail through the `notification.email` job. A throwaway org.

const PW = 'Templates123!';
const EVENT = 'security.recoveryCodeUsed';
let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;
let admin: APIRequestContext;
let mentor: APIRequestContext;
let adminId = '';
let adminEmail = '';
const otherAdminEmail = uniqueEmail('templates-other-admin');
let otherCohortId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  seeded = await seedCustomPipelineOrg('templates', PW);
  const users = await prisma.user.findMany({ where: { orgId: seeded.org.id }, select: { id: true, role: true, email: true } });
  const a = users.find((u) => u.role === 'ADMIN')!;
  adminId = a.id;
  adminEmail = a.email;
  // The admin reads Turkish: the TR template is the one their mail must use.
  await prisma.user.update({ where: { id: adminId }, data: { preferredLanguage: 'tr' } });
  await seedUser(otherAdminEmail, PW, 'ADMIN', 'Templates Other Admin');
  const otherOrg = (await prisma.user.findFirst({ where: { email: otherAdminEmail }, select: { orgId: true } }))?.orgId ?? null;
  otherCohortId = (await prisma.cohort.create({ data: { orgId: otherOrg, name: 'Templates other cohort' } })).id;
  const baseURL = info.project.use.baseURL;
  [admin, mentor] = await Promise.all([1, 2].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(admin, seeded.adminEmail, PW)).ok).toBe(true);
  expect((await signInViaApi(mentor, users.find((u) => u.role === 'MENTOR')!.email, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([admin, mentor].map((c) => c?.dispose()));
  if (seeded) {
    await prisma.notificationTemplate.deleteMany({ where: { orgId: seeded.org.id } });
    await prisma.notificationDelivery.deleteMany({ where: { userId: adminId } });
    await prisma.job.deleteMany({ where: { name: 'notification.email', orgId: seeded.org.id } });
    await prisma.notification.deleteMany({ where: { userId: adminId } });
    await prisma.cohort.deleteMany({ where: { id: otherCohortId } });
    await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  }
  await cleanupByEmail(otherAdminEmail);
});

function eventIn(list: { groups: { events: { key: string; locales: Record<string, { source: string; overridden: boolean; subject: string | null }> }[] }[] }) {
  return list.groups.flatMap((g) => g.events).find((e) => e.key === EVENT)!;
}

test('only an admin of the org may read or write, and another org’s programme is not addressable', async () => {
  expect((await mentor.get('/api/admin/notification-templates')).status()).toBe(403);
  expect((await mentor.put('/api/admin/notification-templates', { data: { eventKey: EVENT, locale: 'en', subject: 'x', body: 'x' } })).status()).toBe(403);
  expect((await mentor.post('/api/admin/notification-templates/preview', { data: { eventKey: EVENT, locale: 'en' } })).status()).toBe(403);
  expect((await admin.get(`/api/admin/notification-templates?programId=${otherCohortId}`)).status()).toBe(404);
  // An in-app-only event or an unknown locale cannot be written.
  expect((await admin.put('/api/admin/notification-templates', { data: { eventKey: 'contract.endsToday', locale: 'en', subject: 'x', body: 'x' } })).status()).toBe(400);
  expect((await admin.put('/api/admin/notification-templates', { data: { eventKey: EVENT, locale: 'fr', subject: 'x', body: 'x' } })).status()).toBe(400);
});

test('editing the TR subject changes the Turkish mail and nothing else; reset restores the default', async () => {
  const before = eventIn(await (await admin.get('/api/admin/notification-templates')).json());
  expect(before.locales.tr.source).toBe('default');

  // A template that would fall back when sent is refused at save time.
  const bad = await admin.put('/api/admin/notification-templates', { data: { eventKey: EVENT, locale: 'tr', subject: '{{offerAmount}}', body: '<p>x</p>' } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).code).toBe('unknown_subject_tag');

  const put = await admin.put('/api/admin/notification-templates', {
    data: { eventKey: EVENT, locale: 'tr', subject: 'Kurtarma kodu: {{remaining}} kaldı', body: '<p>Merhaba {{recipient.firstName}}, <script>x</script>{{remaining}} kod kaldı.</p>' },
  });
  expect(put.status()).toBe(200);
  const after = eventIn(await (await admin.get('/api/admin/notification-templates')).json());
  expect(after.locales.tr).toMatchObject({ source: 'org', overridden: true, subject: 'Kurtarma kodu: {{remaining}} kaldı' });
  expect(after.locales.en.source).toBe('default');
  expect(after.locales.de.source).toBe('default');
  const activity = await prisma.activityLog.findFirst({ where: { action: 'notification_template.saved', actorId: adminId } });
  expect(activity).not.toBeNull();
});

test('the preview is the real renderer’s output, and the test goes to the caller only', async () => {
  const draft = { subject: 'Taslak {{remaining}}', body: '<p>Taslak gövde {{brand.name}}</p>' };
  const res = await admin.post('/api/admin/notification-templates/preview', { data: { eventKey: EVENT, locale: 'tr', ...draft } });
  expect(res.status()).toBe(200);
  const preview = await res.json();
  expect(preview.source).toBe('draft');
  const direct = await renderNotificationEmail({
    eventKey: EVENT,
    locale: 'tr',
    orgId: seeded.org.id,
    params: { remaining: '[remaining]' },
    recipientName: 'templates Admin',
    link: '/notifications',
    draft,
  });
  expect(preview.subject).toBe(direct.subject);
  expect(preview.html).toBe(direct.html);
  expect(preview.html).not.toContain('<script');

  // `to` in the body is refused, not honoured.
  expect((await admin.post('/api/admin/notification-templates/test', { data: { eventKey: EVENT, locale: 'tr', to: 'someone@else.example', ...draft } })).status()).toBe(400);
  const sent = await admin.post('/api/admin/notification-templates/test', { data: { eventKey: EVENT, locale: 'tr', ...draft } });
  expect(sent.status()).toBe(200);
  const log = await prisma.emailLog.findFirst({ where: { category: 'test', subject: 'Taslak [remaining]' }, orderBy: { createdAt: 'desc' } });
  expect(log?.to).toBe(adminEmail);
  expect(await prisma.emailLog.count({ where: { to: 'someone@else.example' } })).toBe(0);
});

test('a saved template reaches the next real event mail through the notification.email job', async () => {
  await notifyEvent({ id: adminId, orgId: seeded.org.id }, EVENT, { remaining: '3' }, { dedupeKey: `e2e-templates-${Date.now()}` });
  const job = (await prisma.job.findFirst({ where: { name: 'notification.email', orgId: seeded.org.id }, orderBy: { createdAt: 'desc' } })) as unknown as JobRecord;
  expect(job).not.toBeNull();
  const payload = job.payload as Parameters<typeof runNotificationEmail>[0];
  expect(await runNotificationEmail(payload, job)).toMatch(/^(sent|skipped_by_send)$/);
  const log = await prisma.emailLog.findFirst({ where: { to: adminEmail, category: 'security' }, orderBy: { createdAt: 'desc' } });
  expect(log?.subject).toBe('Kurtarma kodu: 3 kaldı');
  // A rerun of the same job sends nothing: the ledger row is already claimed.
  expect(await runNotificationEmail(payload, job)).toBe('claimed_elsewhere');
  expect(await prisma.emailLog.count({ where: { to: adminEmail, category: 'security' } })).toBe(1);
});

test('the editor page: pick, edit, preview, save, reset', async ({ page, context }) => {
  await context.addCookies([{ name: 'locale', value: 'en', url: test.info().project.use.baseURL! }]);
  await signInAsFreshUser(page, seeded.adminEmail, PW, '/admin');
  await gotoSettled(page, '/admin/notification-templates');
  await page.getByTestId(`template-event-${EVENT}`).click();
  const editor = page.getByTestId('template-editor');
  await editor.getByTestId('template-lang-tr').click();
  await expect(editor.getByTestId('template-subject')).toHaveValue('Kurtarma kodu: {{remaining}} kaldı');
  await expect(editor.getByTestId('template-overridden')).toBeVisible();
  await expect(editor.getByTestId('template-tags').getByRole('button')).toHaveCount(4);

  await editor.getByTestId('template-lang-en').click();
  await editor.getByTestId('template-subject').fill('Codes left: {{remaining}}');
  await expect(editor.getByTestId('template-preview-subject')).toContainText('Codes left: [remaining]');
  await editor.getByTestId('template-save').click();
  await expect(editor.getByTestId('template-message')).toHaveText('Saved.');
  await editor.getByTestId('template-reset').click();
  await expect(editor.getByTestId('template-message')).toHaveText('Back to the default wording.');

  await editor.getByTestId('template-lang-tr').click();
  await editor.getByTestId('template-reset').click();
  await expect(editor.getByTestId('template-message')).toHaveText('Back to the default wording.');
  const list = eventIn(await (await admin.get('/api/admin/notification-templates')).json());
  expect(Object.values(list.locales).every((l) => l.source === 'default')).toBe(true);
});
