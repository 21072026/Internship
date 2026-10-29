import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { recordChatInstall } from '@/lib/chat/workspaces';

// The chat apps' governance (#1958): install → disable → uninstall, with the
// tables queried afterwards.
//
//  · the console shows the install and never a token;
//  · only an ORG_ADMIN may switch or uninstall (an OBSERVER and a mentor are
//    refused on the route), and another org's workspace id is a 404;
//  · uninstall revokes with the platform (the e2e server's stub client) and
//    leaves ZERO workspace and identity rows and no sealed token; delivery
//    history survives with the workspace link nulled;
//  · install, disable, enable and uninstall each wrote an AuditLog row with the org.

const PW = 'ChatConsole123!';

test.beforeAll(() => {
  process.env.NEXTAUTH_SECRET ||= 'unit-test-secret-not-for-production';
});
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('install → disable → uninstall: real state, admin-only, nothing left behind', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `ChatCon ${stamp}`, slug: `chatcon-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `ChatCon O ${stamp}`, slug: `chatcon-o-${stamp}` } });
  const emails = {
    admin: uniqueEmail('chatcon-admin'),
    observer: uniqueEmail('chatcon-observer'),
    mentor: uniqueEmail('chatcon-mentor'),
    foreign: uniqueEmail('chatcon-foreign'),
  };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'ChatCon Admin', { orgId: org.id });
  const observer = await seedUser(emails.observer, PW, 'ADMIN', 'ChatCon Observer', { orgId: org.id });
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'ChatCon Mentor', { orgId: org.id });
  await seedUser(emails.foreign, PW, 'ADMIN', 'ChatCon Foreign', { orgId: other.id });

  const ctxs: APIRequestContext[] = [];
  const as = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL });
    ctxs.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { headers: freshIp(`chatcon-${email}`) })).error).toBeNull();
    return ctx;
  };
  let wsId = '';
  try {
    // INSTALL (the OAuth callback's writer) + one confirmed identity + one delivery.
    const ws = await recordChatInstall({
      orgId: org.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'Acme Slack', botToken: 'xoxb-synthetic-console',
      scope: 'chat:write,im:write,users:read', installedById: admin.id,
    });
    wsId = ws.id;
    await prisma.chatIdentity.create({ data: { orgId: org.id, workspaceId: wsId, userId: mentor.id, externalUserId: `U${stamp}`, verifiedAt: new Date() } });
    await prisma.chatDelivery.create({ data: { orgId: org.id, workspaceId: wsId, eventKey: 'deadline.stagePassed', target: 'D1', status: 'SENT' } });
    // The same Slack team cannot be installed into another org.
    await expect(
      recordChatInstall({ orgId: other.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'x', botToken: 'y', scope: '', installedById: admin.id }),
    ).rejects.toThrow('workspace_in_other_org');

    // The console: real state, never a token.
    const a = await as(emails.admin);
    const res = await a.get('/api/admin/integrations/chat/status');
    expect(res.status()).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('xoxb');
    expect(raw).not.toContain('TokenEnc');
    const status = JSON.parse(raw);
    expect(status.platforms.map((p: { platform: string }) => p.platform)).toEqual(['SLACK', 'TEAMS']);
    expect(status.workspaces).toHaveLength(1);
    expect(status.workspaces[0]).toMatchObject({
      id: wsId, name: 'Acme Slack', enabled: true, verifiedIdentities: 1, scopes: ['chat:write', 'im:write', 'users:read'],
      installedBy: { email: emails.admin },
    });
    // Another org sees nothing, and cannot touch it (404, not 403).
    const f = await as(emails.foreign);
    expect((await (await f.get('/api/admin/integrations/chat/status')).json()).workspaces).toEqual([]);
    expect((await f.patch(`/api/admin/integrations/chat/${wsId}`, { data: { enabled: false } })).status()).toBe(404);
    expect((await f.delete(`/api/admin/integrations/chat/${wsId}`)).status()).toBe(404);

    // Who may switch: an OBSERVER reads but may not write; a mentor may do neither.
    const o = await as(emails.observer);
    expect((await o.get('/api/admin/integrations/chat/status')).status()).toBe(200);
    expect((await o.patch(`/api/admin/integrations/chat/${wsId}`, { data: { enabled: false } })).status()).toBe(403);
    const m = await as(emails.mentor);
    expect((await m.get('/api/admin/integrations/chat/status')).status()).toBe(403);
    expect((await m.delete(`/api/admin/integrations/chat/${wsId}`)).status()).toBe(403);

    // DISABLE through the page.
    expect((await signInViaApi(page.request, emails.admin, PW, { headers: freshIp('chatcon-ui') })).error).toBeNull();
    await gotoSettled(page, '/admin/integrations');
    const row = page.getByTestId(`chat-workspace-${wsId}`);
    await expect(row).toHaveAttribute('data-enabled', '1', { timeout: 20_000 });
    const [patched] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/admin/integrations/chat/${wsId}`) && r.request().method() === 'PATCH', { timeout: 30_000 }),
      page.getByTestId(`chat-toggle-${wsId}`).click(),
    ]);
    expect(patched.status(), await patched.text()).toBe(200);
    expect((await prisma.chatWorkspace.findUnique({ where: { id: wsId } }))?.enabled, 'the switch reached the database').toBe(false);
    await expect(row).toHaveAttribute('data-enabled', '0', { timeout: 15_000 });
    expect((await prisma.chatWorkspace.findUnique({ where: { id: wsId } }))?.enabled).toBe(false);
    // …and on again through the API, then malformed bodies are refused.
    expect((await a.patch(`/api/admin/integrations/chat/${wsId}`, { data: { enabled: true } })).status()).toBe(200);
    expect((await a.patch(`/api/admin/integrations/chat/${wsId}`, { data: { enabled: 'no' } })).status()).toBe(400);

    // UNINSTALL: revoked with the platform, then nothing of it left here.
    const del = await a.delete(`/api/admin/integrations/chat/${wsId}`);
    expect(del.status()).toBe(200);
    expect(await del.json()).toMatchObject({ ok: true, revoke: 'revoked', identitiesRemoved: 1 });
    expect(await prisma.chatWorkspace.count({ where: { id: wsId } })).toBe(0);
    expect(await prisma.chatIdentity.count({ where: { workspaceId: wsId } })).toBe(0);
    expect(await prisma.chatWorkspace.count({ where: { orgId: org.id, botTokenEnc: { not: null } } })).toBe(0);
    const kept = await prisma.chatDelivery.findMany({ where: { orgId: org.id } });
    expect(kept).toHaveLength(1);
    expect(kept[0].workspaceId).toBeNull();
    expect((await a.delete(`/api/admin/integrations/chat/${wsId}`)).status()).toBe(404);

    // A revoke the platform refuses is recorded, and our copy goes anyway.
    const failing = await recordChatInstall({
      orgId: org.id, platform: 'SLACK', externalId: `T2${stamp}`, name: 'Acme Two', botToken: 'xoxb-x-revoke-fails', scope: 'chat:write', installedById: admin.id,
    });
    const del2 = await a.delete(`/api/admin/integrations/chat/${failing.id}`);
    expect(await del2.json()).toMatchObject({ revoke: 'failed:invalid_auth' });
    expect(await prisma.chatWorkspace.count({ where: { id: failing.id } })).toBe(0);

    // Every step is on the audit trail, with the org.
    const audit = await prisma.auditLog.findMany({ where: { orgId: org.id, action: { startsWith: 'CHAT_' } }, orderBy: { createdAt: 'asc' }, select: { action: true, actorId: true, detail: true } });
    expect(audit.map((r) => r.action)).toEqual(['CHAT_INSTALL', 'CHAT_DISABLE', 'CHAT_ENABLE', 'CHAT_UNINSTALL', 'CHAT_INSTALL', 'CHAT_UNINSTALL']);
    expect(audit.every((r) => r.actorId === admin.id)).toBe(true);
    expect(audit.map((r) => r.detail).join('')).not.toContain('xoxb');
    expect(audit[5].detail).toContain('failed:invalid_auth');
  } finally {
    for (const c of ctxs) await c.dispose();
    await prisma.chatDelivery.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.chatWorkspace.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.auditLog.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  }
});
