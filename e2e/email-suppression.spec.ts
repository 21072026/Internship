import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';
import { sendEmail } from '@/services/emailService';
import { prisma as appPrisma } from '@/lib/prisma';
import { SOFT_BOUNCE_THRESHOLD } from '@/lib/emailSuppressionRule';
import { E2E_EMAIL_WEBHOOK_SECRET } from '../playwright.config';

// Bounce / complaint suppression (#1692), end to end: the provider webhook →
// a suppression row → sendEmail() refuses the address (essential mail too) and
// queues nothing → an ADMIN delists it, with a reason, on the record.
//
// SMTP_USER is blank for the app server and for this process (below), so
// nothing is ever delivered: a send that reached the transport lands SKIPPED
// "SMTP not configured", a suppressed one SKIPPED "Suppressed: <reason>" — the
// two are distinguishable, which is what the assertions read.
//
// Tagged @smoke where a boundary is asserted: the webhook's credential, and who
// may read and delist the list.

const RUN = Date.now().toString(36);
const PW = 'SuppressionPass123';
const HOOK = '/api/webhooks/email/generic';
const AUTH = { 'x-webhook-secret': E2E_EMAIL_WEBHOOK_SECRET };

const superAdminEmail = uniqueEmail('sup-super');
const defaultAdminEmail = uniqueEmail('sup-default-admin');
const tenantAdminEmail = uniqueEmail('sup-tenant-admin');
const menteeEmail = uniqueEmail('sup-mentee');
const addresses: string[] = [];
const addr = (label: string) => {
  const a = `sup-${label}-${RUN}@example.test`;
  addresses.push(a);
  return a;
};

let defaultOrgId = '';
let tenantOrgId = '';
let menteeId = '';

function blankSmtpUser(): () => void {
  const saved = process.env.SMTP_USER;
  process.env.SMTP_USER = '';
  return () => {
    if (saved === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = saved;
  };
}

async function hook(request: APIRequestContext, data: unknown, headers: Record<string, string> = AUTH) {
  return request.post(HOOK, { data, headers });
}

async function latestLog(to: string) {
  return prisma.emailLog.findFirst({ where: { to }, orderBy: { createdAt: 'desc' }, select: { status: true, error: true } });
}

test.beforeAll(async () => {
  defaultOrgId = (
    await prisma.organization.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', name: 'Default Organization' }, select: { id: true } })
  ).id;
  tenantOrgId = (await prisma.organization.create({ data: { name: `Sup Tenant ${RUN}`, slug: `sup-tenant-${RUN}` } })).id;
  const sa = await seedUser(superAdminEmail, PW, 'ADMIN', 'Sup Super', defaultOrgId);
  await prisma.user.update({ where: { id: sa.id }, data: { isSuperAdmin: true } });
  await seedUser(defaultAdminEmail, PW, 'ADMIN', 'Sup Default Admin', defaultOrgId);
  await seedUser(tenantAdminEmail, PW, 'ADMIN', 'Sup Tenant Admin', tenantOrgId);
  menteeId = (await seedUser(menteeEmail, PW, 'MENTEE', 'Sup Mentee', defaultOrgId)).id;
});

test.afterAll(async () => {
  const rows = await prisma.emailSuppression.findMany({ where: { email: { in: [...addresses, menteeEmail] } }, select: { id: true } });
  await prisma.activityLog.deleteMany({ where: { targetId: { in: rows.map((r) => r.id) } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { in: [...addresses, menteeEmail] } } });
  await prisma.emailDeliveryEvent.deleteMany({ where: { email: { in: [...addresses, menteeEmail] } } });
  await prisma.emailLog.deleteMany({ where: { to: { in: [...addresses, menteeEmail] } } });
  for (const e of [superAdminEmail, defaultAdminEmail, tenantAdminEmail, menteeEmail]) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: tenantOrgId } }).catch(() => {});
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('the webhook refuses a caller without the secret and an unknown provider', { tag: '@smoke' }, async ({ request }) => {
  const a = addr('noauth');
  const ev = { id: `noauth-${RUN}`, email: a, type: 'bounce', hard: true };
  expect((await hook(request, ev, {})).status()).toBe(401);
  expect((await hook(request, ev, { 'x-webhook-secret': 'wrong' })).status()).toBe(401);
  expect((await hook(request, ev, { authorization: 'Bearer wrong' })).status()).toBe(401);
  expect((await request.post(`/api/webhooks/email/nope`, { data: ev, headers: AUTH })).status()).toBe(404);
  expect(await prisma.emailSuppression.findUnique({ where: { email: a } })).toBeNull();
  // A malformed body is refused whole.
  expect((await hook(request, [{ id: 'x', email: 'not-an-address', type: 'bounce' }])).status()).toBe(400);
});

test('hard bounce → suppression → every send SKIPPED, nothing queued; a replay changes nothing', async ({ request }) => {
  const a = addr('hard');
  const ev = { id: `hard-${RUN}`, email: `  ${a.toUpperCase()} `, type: 'bounce', hard: true, detail: '550 5.1.1 user unknown' };
  const first = await hook(request, ev, { authorization: `Bearer ${E2E_EMAIL_WEBHOOK_SECRET}` });
  expect(first.status()).toBe(200);
  expect(await first.json()).toMatchObject({ ok: true, received: 1, duplicates: 0, suppressed: 1 });
  const replay = await hook(request, ev);
  expect(await replay.json()).toMatchObject({ ok: true, received: 1, duplicates: 1, suppressed: 0 });
  expect(await prisma.emailDeliveryEvent.count({ where: { provider: 'generic', eventId: ev.id } })).toBe(1);

  // Stored lower-cased and trimmed, once.
  const rows = await prisma.emailSuppression.findMany({ where: { email: a } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ reason: 'HARD_BOUNCE', source: 'generic', releasedAt: null, detail: '550 5.1.1 user unknown' });

  const restore = blankSmtpUser();
  try {
    const since = new Date();
    // A digest-like mail, an essential one (a password reset) and a queue-only
    // one: all refused, matched case-blind, before anything is queued.
    expect(await sendEmail({ to: a, subject: 'Weekly digest', html: '<p>x</p>', category: 'weekly-digest' })).toBe('SKIPPED');
    expect((await latestLog(a))?.error).toBe('Suppressed: HARD_BOUNCE');
    expect(await sendEmail({ to: ` ${a.toUpperCase()}`, subject: 'Reset your password', html: '<p>x</p>', category: 'password-reset' })).toBe('SKIPPED');
    expect(await sendEmail({ to: a, subject: 'Queued', html: '<p>x</p>', category: 'message', queueOnly: true, dedupeKey: `sup:${RUN}` })).toBe('SKIPPED');
    const logs = await prisma.emailLog.findMany({ where: { to: { in: [a, ` ${a.toUpperCase()}`] }, createdAt: { gte: since } }, select: { status: true, error: true } });
    expect(logs).toHaveLength(3);
    for (const l of logs) expect(l).toEqual({ status: 'SKIPPED', error: 'Suppressed: HARD_BOUNCE' });
    expect(await prisma.job.count({ where: { name: 'email.send', idempotencyKey: { contains: `sup:${RUN}` } } })).toBe(0);
    // An address nobody suppressed still reaches the transport (here: no SMTP).
    const other = addr('clean');
    expect(await sendEmail({ to: other, subject: 'x', html: '<p>x</p>', category: 'password-reset' })).toBe('SKIPPED');
    expect((await latestLog(other))?.error).toContain('SMTP not configured');
  } finally {
    restore();
  }
});

test('one soft bounce does not suppress; the threshold inside the window does', async ({ request }) => {
  const a = addr('soft');
  for (let i = 1; i <= SOFT_BOUNCE_THRESHOLD; i++) {
    const res = await hook(request, { id: `soft-${RUN}-${i}`, email: a, type: 'bounce', hard: false, detail: '452 mailbox full' });
    expect(res.status()).toBe(200);
    const row = await prisma.emailSuppression.findUnique({ where: { email: a } });
    if (i < SOFT_BOUNCE_THRESHOLD) expect(row, `after ${i} soft bounce(s)`).toBeNull();
    else expect(row?.reason).toBe('SOFT_BOUNCE_REPEATED');
  }
});

test('a complaint suppresses AND turns off the account\'s e-mail', async ({ request }) => {
  const mentee = { id: menteeId };
  expect((await prisma.user.findUniqueOrThrow({ where: { id: mentee.id } })).emailNotifications).toBe(true);
  const res = await hook(request, { events: [{ id: `complaint-${RUN}`, email: menteeEmail, type: 'complaint' }] });
  expect(await res.json()).toMatchObject({ suppressed: 1 });
  expect((await prisma.emailSuppression.findUniqueOrThrow({ where: { email: menteeEmail } })).reason).toBe('COMPLAINT');
  expect((await prisma.user.findUniqueOrThrow({ where: { id: mentee.id } })).emailNotifications).toBe(false);
  expect(await prisma.activityLog.count({ where: { action: 'email.complaint_opt_out', targetId: mentee.id } })).toBe(1);
});

test('who may read and delist: a tenant admin is refused, the default-org admin sees its own users only', { tag: '@smoke' }, async ({ page, request }) => {
  const noAccount = addr('noaccount');
  await hook(request, [
    { id: `scope-a-${RUN}`, email: noAccount, type: 'bounce', hard: true },
    { id: `scope-b-${RUN}`, email: menteeEmail, type: 'complaint' },
  ]);
  const ownRow = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: menteeEmail } });
  const orphanRow = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: noAccount } });

  await signInAsFreshUser(page, tenantAdminEmail, PW, '/admin');
  expect((await page.request.get('/api/admin/email-suppressions')).status()).toBe(403);
  expect((await page.request.post(`/api/admin/email-suppressions/${ownRow.id}/release`, { data: { reason: 'tenant tries' } })).status()).toBe(403);

  await signInAsFreshUser(page, defaultAdminEmail, PW, '/admin');
  const list = await page.request.get(`/api/admin/email-suppressions?q=${encodeURIComponent(menteeEmail)}`);
  expect(list.status()).toBe(200);
  expect(await list.text()).toContain(menteeEmail);
  // An address no account holds is the super admin's, not an organization's.
  const hidden = await page.request.get(`/api/admin/email-suppressions?q=${encodeURIComponent(noAccount)}`);
  expect(await hidden.json()).toEqual({ rows: [], truncated: false });
  expect((await page.request.post(`/api/admin/email-suppressions/${orphanRow.id}/release`, { data: { reason: 'not yours' } })).status()).toBe(404);

  await signInAsFreshUser(page, superAdminEmail, PW, '/admin');
  expect(await (await page.request.get(`/api/admin/email-suppressions?q=${encodeURIComponent(noAccount)}`)).text()).toContain(noAccount);
});

test('an ADMIN delists through the settings tab, with a reason; a complaint needs a confirmation', async ({ page, request }) => {
  const a = addr('delist');
  await hook(request, { id: `delist-${RUN}`, email: a, type: 'bounce', hard: true });
  const row = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: a } });
  await signInAsFreshUser(page, superAdminEmail, PW, '/admin');

  // The route refuses a delist without a reason, and a complaint without confirm.
  expect((await page.request.post(`/api/admin/email-suppressions/${row.id}/release`, { data: {} })).status()).toBe(400);
  const complaint = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: menteeEmail } });
  const unconfirmed = await page.request.post(`/api/admin/email-suppressions/${complaint.id}/release`, { data: { reason: 'they asked us to' } });
  expect(unconfirmed.status()).toBe(409);
  expect((await unconfirmed.json()).code).toBe('complaint_confirm_required');

  await gotoSettled(page, '/admin/settings');
  await page.getByTestId('mail-tab-suppressions').click();
  await page.getByTestId('email-suppression-search').fill(a);
  const delist = page.getByTestId(`email-suppression-delist-${row.id}`);
  await expect(delist).toBeVisible();
  await delist.click();
  await expect(page.getByTestId('confirm-dialog-confirm')).toBeDisabled();
  await page.getByTestId('email-suppression-reason').fill('Mailbox re-created by the recipient');
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByTestId('email-suppression-note')).toBeVisible();

  const released = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: a } });
  expect(released.releasedAt).not.toBeNull();
  expect(released.releaseReason).toBe('Mailbox re-created by the recipient');
  const sa = await prisma.user.findFirstOrThrow({ where: { email: superAdminEmail }, select: { id: true } });
  expect(released.releasedById).toBe(sa.id);
  const audit = await prisma.activityLog.findFirst({ where: { action: 'email.suppression_released', targetId: row.id } });
  expect(audit?.actorId).toBe(sa.id);
  expect(audit?.detail).toContain('Mailbox re-created');
  // A second delist is a conflict, not a second record.
  expect((await page.request.post(`/api/admin/email-suppressions/${row.id}/release`, { data: { reason: 'again please' } })).status()).toBe(409);

  // Delisted: the next send reaches the transport again.
  const restore = blankSmtpUser();
  try {
    expect(await sendEmail({ to: a, subject: 'Back', html: '<p>x</p>', category: 'password-reset' })).toBe('SKIPPED');
    expect((await latestLog(a))?.error).toContain('SMTP not configured');
  } finally {
    restore();
  }
  // And a new bounce re-arms the same row.
  await hook(request, { id: `delist-again-${RUN}`, email: a, type: 'bounce', hard: true });
  const rearmed = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: a } });
  expect(rearmed.id).toBe(row.id);
  expect(rearmed.releasedAt).toBeNull();
});

test('a route that reports "emailSent" says false for a suppressed address', async ({ page, request }) => {
  const companyUserEmail = addr('company-user');
  await hook(request, { id: `honest-${RUN}`, email: companyUserEmail, type: 'bounce', hard: true });
  const company = await prisma.company.create({ data: { name: `Sup Co ${RUN}`, orgId: defaultOrgId } });
  try {
    await signInAsFreshUser(page, defaultAdminEmail, PW, '/admin');
    const res = await page.request.post('/api/admin/company-users', {
      data: { companyId: company.id, email: companyUserEmail, fullName: 'Sup Company User' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).emailSent).toBe(false);
    expect(await latestLog(companyUserEmail)).toEqual({ status: 'SKIPPED', error: 'Suppressed: HARD_BOUNCE' });
  } finally {
    await cleanupByEmail(companyUserEmail);
    await prisma.company.deleteMany({ where: { id: company.id } }).catch(() => {});
  }
});
