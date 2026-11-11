import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { recordChatInstall } from '@/lib/chat/workspaces';

// The chat delivery ledger (#1960) on /admin/integrations: a seeded FAILED
// delivery renders with its reason; Retry goes through the router (the e2e
// server's stub platform client) and APPENDS a row — the failed one is never
// rewritten; the endpoint carries no card body and no token, and is the
// caller's org only.

const PW = 'ChatLedger123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the ledger shows a failed delivery and its reason; retry appends a new row', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `ChatLed ${stamp}`, slug: `chatled-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `ChatLed O ${stamp}`, slug: `chatled-o-${stamp}` } });
  const emails = { admin: uniqueEmail('chatled-admin'), mentor: uniqueEmail('chatled-mentor'), foreign: uniqueEmail('chatled-foreign') };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'ChatLed Admin', { orgId: org.id });
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'Ledger Mentor', { orgId: org.id });
  await seedUser(emails.foreign, PW, 'ADMIN', 'ChatLed Foreign', { orgId: other.id });
  const ctxs: APIRequestContext[] = [];
  const as = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL });
    ctxs.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { headers: freshIp(`chatled-${email}`) })).error).toBeNull();
    return ctx;
  };
  try {
    const ws = await recordChatInstall({
      orgId: org.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'Acme Ledger', botToken: 'xoxb-synthetic-ledger', scope: 'chat:write', installedById: admin.id,
    });
    const identity = await prisma.chatIdentity.create({
      data: { orgId: org.id, workspaceId: ws.id, userId: mentor.id, externalUserId: `U${stamp}`, dmChannelId: `D${stamp}`, verifiedAt: new Date() },
    });
    // What the router wrote for one event: the bell row, then a failed chat attempt.
    await prisma.notification.create({
      data: { userId: mentor.id, type: 'deadline.stagePassed', params: { menteeName: 'Ledger Mentee' }, link: '/mentor/mentees/rel-ledger' },
    });
    const failed = await prisma.chatDelivery.create({
      data: { orgId: org.id, workspaceId: ws.id, identityId: identity.id, eventKey: 'deadline.stagePassed', target: `D${stamp}`, status: 'FAILED', error: 'channel_not_found' },
    });

    // The endpoint: own org, metadata only.
    const a = await as(emails.admin);
    const res = await a.get(`/api/admin/integrations/chat/deliveries?workspaceId=${ws.id}`);
    expect(res.status()).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('xoxb');
    expect(raw).not.toContain('Ledger Mentee');
    expect(JSON.parse(raw).items).toEqual([
      { id: failed.id, eventKey: 'deadline.stagePassed', recipient: 'Ledger Mentor', status: 'FAILED', error: 'channel_not_found', createdAt: failed.createdAt.toISOString() },
    ]);
    const f = await as(emails.foreign);
    expect((await f.get(`/api/admin/integrations/chat/deliveries?workspaceId=${ws.id}`)).status()).toBe(404);
    expect((await f.post(`/api/admin/integrations/chat/deliveries/${failed.id}/retry`)).status()).toBe(404);
    const m = await as(emails.mentor);
    expect((await m.get(`/api/admin/integrations/chat/deliveries?workspaceId=${ws.id}`)).status()).toBe(403);
    expect((await m.post(`/api/admin/integrations/chat/deliveries/${failed.id}/retry`)).status()).toBe(403);

    // The page: the failed row and its reason, then Retry.
    expect((await signInViaApi(page.request, emails.admin, PW, { headers: freshIp('chatled-ui') })).error).toBeNull();
    await gotoSettled(page, '/admin/integrations');
    await page.getByTestId(`chat-ledger-toggle-${ws.id}`).locator('summary').click({ timeout: 20_000 });
    const row = page.getByTestId(`chat-delivery-${failed.id}`);
    await expect(row).toHaveAttribute('data-status', 'FAILED', { timeout: 15_000 });
    await expect(page.getByTestId(`chat-delivery-error-${failed.id}`)).toHaveText('channel_not_found');
    await expect(row).toContainText('Ledger Mentor');
    const [retried] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/chat/deliveries/${failed.id}/retry`), { timeout: 30_000 }),
      page.getByTestId(`chat-retry-${failed.id}`).click(),
    ]);
    expect(retried.status(), await retried.text()).toBe(200);
    expect(await retried.json()).toMatchObject({ ok: true, status: 'SENT' });
    await expect(page.getByTestId('chat-retry-note')).toHaveText('Sent again.');

    // Append-only: the failed row is untouched and a new SENT row exists.
    const rows = await prisma.chatDelivery.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: failed.id, status: 'FAILED', error: 'channel_not_found' });
    expect(rows[1]).toMatchObject({ status: 'SENT', eventKey: 'deadline.stagePassed', identityId: identity.id });
    await expect(page.locator(`[data-testid^="chat-delivery-"][data-status="SENT"]`)).toHaveCount(1);

    // A second retry of the same attempt, or a retry of a sent one, is refused.
    expect((await a.post(`/api/admin/integrations/chat/deliveries/${failed.id}/retry`)).status()).toBe(409);
    expect((await a.post(`/api/admin/integrations/chat/deliveries/${rows[1].id}/retry`)).status()).toBe(409);
  } finally {
    for (const c of ctxs) await c.dispose();
    await prisma.notificationDelivery.deleteMany({ where: { userId: mentor.id } });
    await prisma.notification.deleteMany({ where: { userId: mentor.id } });
    await prisma.chatDelivery.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.chatWorkspace.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.auditLog.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  }
});
