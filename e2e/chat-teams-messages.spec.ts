import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { recordChatInstall } from '@/lib/chat/workspaces';
import { E2E_BOTFRAMEWORK_MOCK_PORT } from '../playwright.config';

// The Teams bot's messaging endpoint (#3322) against the local Bot Framework
// stub (e2e/support/botframework-mock.mjs): only a token the stub's published
// key signed, for our app id and this activity's serviceUrl, gets through; a
// verified installationUpdate/remove switches the tenant's workspace off and
// clears it, with an audit row. No real Microsoft key is involved.

const SERVICE = 'https://smba.trafficmanager.net/emea/';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('Teams removal: forged tokens change nothing, a verified one switches the workspace off', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const tenant = `tid-${stamp}`;
  const org = await prisma.organization.create({ data: { name: `Teams ${stamp}`, slug: `teams-${stamp}` } });
  const email = uniqueEmail('teams-admin');
  const admin = await seedUser(email, 'TeamsMsg123!', 'ADMIN', 'Teams Admin', { orgId: org.id });
  const api = await playwright.request.newContext({ baseURL });
  const mock = await playwright.request.newContext();
  const sign = async (claims: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    (await (await mock.post(`http://127.0.0.1:${E2E_BOTFRAMEWORK_MOCK_PORT}/__sign`, { data: { claims, ...opts } })).json()).token as string;
  try {
    const ws = await recordChatInstall({ orgId: org.id, platform: 'TEAMS', externalId: tenant, name: 'Acme Teams', botToken: null, scope: 'bot', installedById: admin.id });
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: 'https://api.botframework.com', aud: 'e2e-teams-app', nbf: now - 10, exp: now + 600, serviceUrl: SERVICE };
    const activity = { type: 'installationUpdate', action: 'remove', serviceUrl: SERVICE, channelData: { tenant: { id: tenant } }, conversation: { tenantId: tenant } };
    const post = (authorization: string | null, body: unknown = activity) =>
      api.post('/api/integrations/chat/teams/messages', {
        data: body,
        headers: authorization ? { authorization } : {},
        // The first request compiles the route under `next dev`.
        timeout: 60_000,
      });

    expect((await post(null)).status()).toBe(401);
    expect((await post(`Bearer ${await sign(claims, { foreign: true })}`)).status()).toBe(401);
    expect((await post(`Bearer ${await sign({ ...claims, aud: 'another-bot' })}`)).status()).toBe(401);
    expect((await post(`Bearer ${await sign({ ...claims, exp: now - 3600 })}`)).status()).toBe(401);
    expect((await post(`Bearer ${await sign({ ...claims, serviceUrl: 'https://elsewhere.trafficmanager.net/' })}`)).status()).toBe(401);
    expect((await prisma.chatWorkspace.findUniqueOrThrow({ where: { id: ws.id } })).enabled).toBe(true);
    expect((await api.post('/api/integrations/chat/slack/messages', { data: {} })).status()).toBe(404);

    // Another activity, verified: acknowledged and ignored.
    const msg = await post(`Bearer ${await sign(claims)}`, { type: 'message', text: 'hi', serviceUrl: SERVICE });
    expect(await msg.json()).toEqual({ ok: true, ignored: true });

    // The removal, verified.
    const res = await post(`Bearer ${await sign(claims)}`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 1 });
    expect(await prisma.chatWorkspace.findUniqueOrThrow({ where: { id: ws.id } })).toMatchObject({
      enabled: false,
      botTokenEnc: null,
      refreshTokenEnc: null,
      lastError: 'platform_installation_removed',
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: 'CHAT_PLATFORM_UNINSTALL' } });
    expect(audit.actorId).toBe('platform:teams');
  } finally {
    await api.dispose();
    await mock.dispose();
    await prisma.chatWorkspace.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
