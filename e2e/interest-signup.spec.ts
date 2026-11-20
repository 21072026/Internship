import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { freshIp, floodIp } from './helpers/rateLimit';
import { signInViaApi } from './helpers/auth';
import { subscriberToken, subscriberTokenHash } from '@/lib/subscriberTokens';
import { subscriberDeliveryAllowed } from '@/lib/subscriberDelivery';
import { sendSubscriberMail } from '@/lib/subscriberMail';
import { resetMailTransportsForTests, sendPrepared, transmit, type PreparedEmail } from '@/services/emailService';
import { enqueueMail, drainOnce } from '@/lib/mailOutbox';
import '@/lib/notifications/emailRender';
import { startFakeSmtp } from './helpers/fakeSmtp';

// Never use external SMTP credentials from the test runner's environment.
process.env.SMTP_USER = '';
process.env.SMTP_BULK_USER = '';
const run = randomUUID();
const host = `interest-${run}.example.test`;
let orgId: string;
const addresses: string[] = [];
const address = () => { const email = uniqueEmail('interest-1406'); addresses.push(email); return email; };
const data = (email = address()) => ({ email, role: 'MENTEE', locale: 'en', consent: true, website: '', renderedAt: Date.now() - 5000 });
async function subscribe(request: APIRequestContext, body = data()) {
  return request.post('/api/subscribe', { headers: { ...freshIp('interest-signup'), 'x-forwarded-host': host }, data: body });
}
async function signup(request: APIRequestContext) {
  const body = data();
  expect((await subscribe(request, body)).status()).toBe(200);
  return prisma.subscriber.findUniqueOrThrow({ where: { orgId_email: { orgId, email: body.email } } });
}

test.beforeAll(async () => {
  const org = await prisma.organization.create({ data: { slug: `interest-${run}`, name: 'Synthetic interest tests', publicHost: host } });
  orgId = org.id;
});
test.afterAll(async () => {
  await prisma.job.deleteMany({ where: { idempotencyKey: { startsWith: `interest-${run}` } } });
  await prisma.subscriber.deleteMany({ where: { orgId } });
  await prisma.emailLog.deleteMany({ where: { to: { in: addresses } } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

test('server requires consent, ignores honeypot/fast renders and rate limits the fourth request', async ({ request }) => {
  const body = data();
  expect((await subscribe(request, { ...body, consent: false })).status()).toBe(400);
  expect((await subscribe(request, { ...body, website: 'robot' })).status()).toBe(200);
  expect((await subscribe(request, { ...body, renderedAt: Date.now() })).status()).toBe(200);
  expect(await prisma.subscriber.count({ where: { orgId, email: body.email } })).toBe(0);
  for (let i = 0; i < 3; i++) expect((await request.post('/api/subscribe', { headers: { ...floodIp(`interest-${run}`), 'x-forwarded-host': host }, data: { ...body, website: 'robot' } })).status()).toBe(200);
  expect((await request.post('/api/subscribe', { headers: { ...floodIp(`interest-${run}`), 'x-forwarded-host': host }, data: body })).status()).toBe(429);
});

test('normalized duplicate signup returns the same receipt and preserves consent evidence', async ({ request }) => {
  const body = data();
  const first = await subscribe(request, body);
  const row = await prisma.subscriber.findUniqueOrThrow({ where: { orgId_email: { orgId, email: body.email } } });
  const second = await subscribe(request, { ...body, email: `  ${body.email.toUpperCase()}  `, role: 'COMPANY' });
  expect(second.status()).toBe(first.status());
  expect(await second.json()).toEqual(await first.json());
  expect(await prisma.subscriber.count({ where: { orgId, email: body.email } })).toBe(1);
  expect(await prisma.emailLog.count({ where: { to: body.email, category: 'consent' } })).toBe(1);
  expect(row.consent).toBe(true);
  expect(row.consentAt.getTime()).toBeLessThanOrEqual(Date.now());
  expect(row.consentAt.getTime()).toBeGreaterThan(Date.now() - 60000);
  const unchanged = await prisma.subscriber.findUniqueOrThrow({ where: { id: row.id } });
  expect(unchanged.role).toBe('MENTEE');
  expect(unchanged.consentAt).toEqual(row.consentAt);
  expect(unchanged.confirmedAt).toBeNull();
  expect(unchanged.confirmationTokenHash).toBe(subscriberTokenHash(subscriberToken(row.id, 'confirm')));
});

test('double opt-in requires a valid confirmation POST; unsubscribe is terminal and generic', { tag: '@smoke' }, async ({ request }) => {
  const row = await signup(request);
  expect(await subscriberDeliveryAllowed(row.id, row.email, orgId, 'announcement')).toBe(false);
  expect(await sendSubscriberMail(row.id, false, { subject: 'Synthetic update', text: 'No transmission' })).toBe('SKIPPED');
  const confirm = subscriberToken(row.id, 'confirm');
  const unsubscribe = subscriberToken(row.id, 'unsubscribe');
  await request.get(`/interest/confirm?t=${confirm}`);
  expect((await prisma.subscriber.findUniqueOrThrow({ where: { id: row.id } })).confirmedAt).toBeNull();
  const invalid = await request.post('/api/subscribe/confirm', { data: { token: unsubscribe } });
  const valid = await request.post('/api/subscribe/confirm', { data: { token: confirm } });
  expect(await invalid.json()).toEqual(await valid.json());
  expect((await prisma.subscriber.findUniqueOrThrow({ where: { id: row.id } })).confirmedAt).not.toBeNull();
  expect(await subscriberDeliveryAllowed(row.id, row.email, orgId, 'announcement')).toBe(true);
  await request.get(`/api/subscribe/unsubscribe?t=${unsubscribe}`, { maxRedirects: 0 });
  expect((await prisma.subscriber.findUniqueOrThrow({ where: { id: row.id } })).unsubscribedAt).toBeNull();
  const removed = await request.post(`/api/subscribe/unsubscribe?t=${unsubscribe}`, { form: { 'List-Unsubscribe': 'One-Click' } });
  const unknown = await request.post('/api/subscribe/unsubscribe?t=unknown');
  expect(await removed.json()).toEqual(await unknown.json());
  expect((await prisma.subscriber.findUniqueOrThrow({ where: { id: row.id } })).unsubscribedAt).not.toBeNull();
  expect(await sendSubscriberMail(row.id, false, { subject: 'Synthetic update', text: 'Must be suppressed' })).toBe('SKIPPED');
  await request.post('/api/subscribe/confirm', { data: { token: confirm } });
  await subscribe(request, { ...data(row.email), role: 'OTHER' });
  expect(await subscriberDeliveryAllowed(row.id, row.email, orgId, 'announcement')).toBe(false);
});

test('unsubscribe blocks a previously prepared inline mail and cancels an already queued mail', { tag: '@smoke' }, async ({ request }) => {
  const row = await signup(request);
  await request.post('/api/subscribe/confirm', { data: { token: subscriberToken(row.id, 'confirm') } });
  const prepared: PreparedEmail = {
    to: row.email, subject: 'Synthetic queued update', category: 'announcement', transport: 'primary', lane: 'BULK',
    orgId, subscriberId: row.id, world: 'INTERNSHIP',
    message: { to: row.email, subject: 'Synthetic queued update', text: 'Never sent' },
  };
  const job = await enqueueMail(prepared, { reason: 'lane', dedupeKey: `interest-${run}-queued` });
  await request.post(`/api/subscribe/unsubscribe?t=${subscriberToken(row.id, 'unsubscribe')}`);
  let sent = 0;
  await expect(transmit(prepared, { via: { sendMail: async () => { sent++; return { envelope: { from: 'noreply@example.test', to: [row.email] }, messageId: 'synthetic' }; } } })).rejects.toThrow('subscriber_consent_unavailable');
  await expect(sendPrepared(prepared, { via: { sendMail: async () => { sent++; return { envelope: { from: 'noreply@example.test', to: [row.email] }, messageId: 'synthetic' }; } } })).rejects.toThrow('subscriber_consent_unavailable');
  await drainOnce({ env: { ...process.env, SMTP_USER: 'synthetic-sink-only', MAIL_WORKER_ENABLED: '1', MAIL_METER_MODE: 'off' }, maxMs: 5000, budgetName: () => `interest-${run}`, deps: {
    transmit: async () => { sent++; }, record: async () => {}, observe: () => {}, finalFailure: () => {},
  } });
  expect(sent).toBe(0);
  expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CANCELLED');
});

test('admin CSV is authenticated, tenant scoped and contains no tokens', async ({ request, playwright, baseURL }) => {
  expect((await request.get('/api/admin/subscribers')).status()).toBe(401);
  const row = await signup(request);
  const foreignOrg = await prisma.organization.create({ data: { slug: `interest-other-${run}`, name: 'Other synthetic tenant' } });
  const foreign = await prisma.subscriber.create({ data: { ...row, id: randomUUID(), orgId: foreignOrg.id, email: address() } });
  const programEmail = uniqueEmail('interest-program-admin');
  const program = await seedUser(programEmail, 'SyntheticPass123!', 'ADMIN', 'Programme Admin', orgId);
  await prisma.user.update({ where: { id: program.id }, data: { adminLevel: 'PROGRAM_ADMIN' } });
  const programRequest = await playwright.request.newContext({ baseURL });
  const email = uniqueEmail('interest-admin');
  await seedUser(email, 'SyntheticPass123!', 'ADMIN', 'Synthetic Admin', orgId);
  try {
    expect((await signInViaApi(request, email, 'SyntheticPass123!', { headers: freshIp('interest-admin') })).ok).toBe(true);
    const csv = await request.get('/api/admin/subscribers?format=csv');
    expect(csv.status()).toBe(200);
    const text = await csv.text();
    expect(text).toContain(row.email);
    expect(text).not.toContain(foreign.email);
    expect((await signInViaApi(programRequest, programEmail, 'SyntheticPass123!', { headers: freshIp('interest-program-admin') })).ok).toBe(true);
    expect((await programRequest.get('/api/admin/subscribers')).status()).toBe(403);
    expect((await programRequest.get('/api/admin/subscribers?format=csv')).status()).toBe(403);
    expect(text).not.toContain(row.unsubscribeTokenHash);
    expect(text).not.toContain(subscriberToken(row.id, 'unsubscribe'));
  } finally {
    await programRequest.dispose();
    await cleanupByEmail(programEmail);
    await cleanupByEmail(email);
    await prisma.subscriber.delete({ where: { id: foreign.id } });
    await prisma.organization.delete({ where: { id: foreignOrg.id } });
  }
});

test('landing signup is an optional collapsed control below the primary CTA', async ({ page }) => {
  await page.setExtraHTTPHeaders({ ...freshIp('interest-ui'), 'x-forwarded-host': host });
  await page.goto('/');
  const signup = page.getByTestId('interest-signup');
  await expect(signup.locator('details')).not.toHaveAttribute('open');
  await signup.locator('summary').click();
  await expect(signup.locator('input[name="consent"]')).not.toBeChecked();
  await expect(signup.locator('input[type="email"]')).toBeVisible();
  const email = address();
  await signup.locator('input[type="email"]').fill(email);
  await signup.locator('input[name="consent"]').check();
  const start = Date.now();
  // The form's three-second minimum is a product rule, not a network wait.
  await expect.poll(() => Date.now() - start).toBeGreaterThan(3000);
  await signup.getByRole('button').click();
  await expect(signup.getByRole('status')).toBeVisible();
  expect(await prisma.subscriber.count({ where: { orgId, email, confirmedAt: null } })).toBe(1);
});

// This test owns a local sink; it never uses an external relay or real recipient.
test('confirmation mail contains the confirmation link and RFC 8058 unsubscribe headers', async ({ request }) => {
  const row = await signup(request);
  const smtp = await startFakeSmtp();
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_METER_MODE', 'MAIL_QUEUE_LANES'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'synthetic', SMTP_PASS: 'synthetic', SMTP_FROM: 'noreply@example.test', MAIL_METER_MODE: 'off', MAIL_QUEUE_LANES: '' });
    resetMailTransportsForTests();
    expect(await sendSubscriberMail(row.id, true)).toBe('SENT');
    expect(smtp.messages).toHaveLength(1);
    const message = smtp.messages[0].data;
    expect(message).toMatch(/List-Unsubscribe:/i);
    expect(message).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
    expect(message).toContain('/interest/confirm');
    expect(message).toContain('/interest/unsubscribe');
    expect(await sendSubscriberMail(row.id, false, { subject: 'Synthetic update', text: 'Must not send' })).toBe('SKIPPED');
    expect(smtp.messages).toHaveLength(1);
    await request.post('/api/subscribe/confirm', { data: { token: subscriberToken(row.id, 'confirm') } });
    expect(await sendSubscriberMail(row.id, false, { subject: 'Synthetic confirmed update', text: 'Capture only' })).toBe('SENT');
    expect(smtp.messages).toHaveLength(2);
    expect(smtp.messages[1].data).toMatch(/List-Id:/i);
    expect(smtp.messages[1].data).toMatch(/Precedence: bulk/i);
    expect(smtp.messages[1].data).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    resetMailTransportsForTests();
    await smtp.close();
  }
});

test('canonical attribution cleaning drops referrer queries and expired confirmation cannot grant consent', async ({ request }) => {
  const body = { ...data(), utm: { source: '  newsletter  ', campaign: 'spring' }, referrer: 'https://example.test/story?email=private#secret' };
  expect((await subscribe(request, body)).status()).toBe(200);
  const row = await prisma.subscriber.findUniqueOrThrow({ where: { orgId_email: { orgId, email: body.email } } });
  expect(row.utmSource).toBe('newsletter');
  expect(row.referrer).toBe('https://example.test/story');
  await prisma.subscriber.update({ where: { id: row.id }, data: { confirmationExpiresAt: new Date(Date.now() - 1000) } });
  await request.post('/api/subscribe/confirm', { data: { token: subscriberToken(row.id, 'confirm') } });
  expect((await prisma.subscriber.findUniqueOrThrow({ where: { id: row.id } })).confirmedAt).toBeNull();
  expect(await subscriberDeliveryAllowed(row.id, row.email, orgId, 'consent')).toBe(false);
  expect(await subscriberDeliveryAllowed(row.id, row.email, orgId, 'announcement')).toBe(false);
});

test('interest consent never overrides an existing account master email opt-out', async ({ request }) => {
  const row = await signup(request);
  await request.post('/api/subscribe/confirm', { data: { token: subscriberToken(row.id, 'confirm') } });
  const user = await seedUser(row.email, 'SyntheticPass123!', 'MENTEE', 'Synthetic Recipient', orgId);
  try {
    await prisma.user.update({ where: { id: user.id }, data: { emailNotifications: false } });
    expect(await subscriberDeliveryAllowed(row.id, row.email, orgId, 'announcement')).toBe(false);
    expect(await sendSubscriberMail(row.id, false, { subject: 'Synthetic update', text: 'Must stay suppressed' })).toBe('SKIPPED');
  } finally { await cleanupByEmail(row.email); }
});

test('default-tenant admin can list subscribers with a required orgId', async ({ request }) => {
  const body = data();
  expect((await request.post('/api/subscribe', { headers: freshIp('interest-default'), data: body })).status()).toBe(200);
  const row = await prisma.subscriber.findFirstOrThrow({ where: { email: body.email } });
  const email = uniqueEmail('interest-default-admin');
  await seedUser(email, 'SyntheticPass123!', 'ADMIN', 'Synthetic Default Admin', row.orgId);
  try {
    expect((await signInViaApi(request, email, 'SyntheticPass123!', { headers: freshIp('interest-default-admin') })).ok).toBe(true);
    const response = await request.get('/api/admin/subscribers');
    expect(response.status()).toBe(200);
    expect((await response.json()).items.map((item: { id: string }) => item.id)).toContain(row.id);
  } finally {
    await cleanupByEmail(email);
    await prisma.subscriber.delete({ where: { id: row.id } });
  }
});
