import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { makeChatState } from '@/lib/chat/oauthState';
import { slackSignatureFor } from '@/lib/chat/slackSignature';
import { E2E_SLACK_MOCK_PORT } from '../playwright.config';

// The Slack / Teams app install (#1935): connect → callback → platform
// uninstall, against the local Slack stub (e2e/support/slack-mock.mjs).
//
//  · /connect is the admin's only, refused ON THE ROUTE for anyone else;
//  · a callback whose state was minted for another user, another org, another
//    platform or more than ten minutes ago installs nothing;
//  · the tokens land sealed (no `xoxb` in the row) and the install is audited;
//  · Slack's signed `app_uninstalled` switches the workspace off and clears its
//    tokens, an unsigned or stale one changes nothing.

const PW = 'ChatInstall123!';
const SIGNING = 'e2e-slack-signing-secret';

test.afterAll(async () => {
  await prisma.$disconnect();
});

function signed(body: string, ts = Math.floor(Date.now() / 1000)) {
  return { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': slackSignatureFor(SIGNING, String(ts), body) };
}

test('connect → callback → uninstall: admin-only, state-bound, sealed, audited', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `ChatInst ${stamp}`, slug: `chatinst-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `ChatInst O ${stamp}`, slug: `chatinst-o-${stamp}` } });
  const emails = {
    admin: uniqueEmail('chatinst-admin'),
    admin2: uniqueEmail('chatinst-admin2'),
    observer: uniqueEmail('chatinst-observer'),
    mentor: uniqueEmail('chatinst-mentor'),
    foreign: uniqueEmail('chatinst-foreign'),
  };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'ChatInst Admin', { orgId: org.id });
  await seedUser(emails.admin2, PW, 'ADMIN', 'ChatInst Admin Two', { orgId: org.id });
  const observer = await seedUser(emails.observer, PW, 'ADMIN', 'ChatInst Observer', { orgId: org.id });
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });
  await seedUser(emails.mentor, PW, 'MENTOR', 'ChatInst Mentor', { orgId: org.id });
  await seedUser(emails.foreign, PW, 'ADMIN', 'ChatInst Foreign', { orgId: other.id });

  const ctxs: APIRequestContext[] = [];
  const as = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL });
    ctxs.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { headers: freshIp(`chatinst-${email}`) })).error).toBeNull();
    return ctx;
  };
  const location = (r: { headers(): Record<string, string> }) => r.headers()['location'] ?? '';
  const team = `T${stamp}`;
  try {
    // 1. Who may start it.
    for (const email of [emails.mentor, emails.observer]) {
      expect((await (await as(email)).get('/api/integrations/chat/slack/connect', { maxRedirects: 0 })).status(), email).toBe(403);
    }
    const a = await as(emails.admin);
    expect((await a.get('/api/integrations/chat/discord/connect', { maxRedirects: 0 })).status()).toBe(404);
    const start = await a.get('/api/integrations/chat/slack/connect', { maxRedirects: 0 });
    expect(start.status()).toBe(307);
    const consent = new URL(location(start));
    expect(consent.origin).toBe(`http://127.0.0.1:${E2E_SLACK_MOCK_PORT}`);
    expect(consent.searchParams.get('client_id')).toBe('e2e-slack-client');
    expect(consent.searchParams.get('scope')).toBe('chat:write,im:write,users:read,users:read.email,commands');
    const state = consent.searchParams.get('state')!;
    expect(state.split('.')).toHaveLength(6);

    // 2. A state that is not this admin's, this org's, this platform's or fresh installs nothing.
    const callback = (ctx: APIRequestContext, slug: string, q: string) => ctx.get(`/api/integrations/chat/${slug}/callback?${q}`, { maxRedirects: 0 });
    const a2 = await as(emails.admin2);
    expect(location(await callback(a2, 'slack', `code=good-${stamp}&state=${encodeURIComponent(state)}`))).toContain('chat=failed');
    expect(location(await callback(a, 'teams', `admin_consent=True&tenant=tid${stamp}&state=${encodeURIComponent(state)}`))).toContain('chat=failed');
    const f = await as(emails.foreign);
    expect(location(await callback(f, 'slack', `code=good-${stamp}&state=${encodeURIComponent(state)}`))).toContain('chat=failed');
    const stale = makeChatState({ platform: 'SLACK', orgId: org.id, userId: admin.id, nonce: 'n' }, Date.now() - 11 * 60_000);
    expect(location(await callback(a, 'slack', `code=good-${stamp}&state=${encodeURIComponent(stale)}`))).toContain('chat=failed');
    expect(location(await callback(a, 'slack', `code=bad-${stamp}&state=${encodeURIComponent(state)}`))).toContain('chat=failed');
    expect(location(await callback(a, 'slack', `error=access_denied&state=${encodeURIComponent(state)}`))).toContain('chat=cancelled');
    expect(await prisma.chatWorkspace.count({ where: { externalId: { in: [team, `tid${stamp}`] } } })).toBe(0);

    // 3. The real one: sealed, audited, back on the console with a banner.
    const done = await callback(a, 'slack', `code=good-${stamp}&state=${encodeURIComponent(state)}`);
    expect(location(done)).toContain('/admin/integrations?chat=connected');
    const ws = await prisma.chatWorkspace.findUniqueOrThrow({ where: { platform_externalId: { platform: 'SLACK', externalId: team } } });
    expect(ws).toMatchObject({ orgId: org.id, name: `Acme Mock ${stamp}`, enabled: true, installedById: admin.id });
    expect(ws.botTokenEnc).toBeTruthy();
    expect(ws.botTokenEnc).not.toContain('xoxb');
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'CHAT_INSTALL' } })).toBe(1);
    const mock = await (await playwright.request.newContext()).get(`http://127.0.0.1:${E2E_SLACK_MOCK_PORT}/__received`);
    const exchange = (await mock.json()).exchanges.find((x: { code: string }) => x.code === `good-${stamp}`);
    expect(exchange).toMatchObject({ clientId: 'e2e-slack-client', secretSent: true });
    expect(exchange.redirectUri).toMatch(/\/api\/integrations\/chat\/slack\/callback$/);

    // 4. Teams: admin consent, no workspace token.
    const tStart = await a.get('/api/integrations/chat/teams/connect', { maxRedirects: 0 });
    const tUrl = new URL(location(tStart));
    expect(tUrl.pathname).toBe('/organizations/adminconsent');
    const tState = tUrl.searchParams.get('state')!;
    expect(location(await callback(a, 'teams', `admin_consent=True&tenant=tid${stamp}&state=${encodeURIComponent(tState)}`))).toContain('chat=connected');
    expect(await prisma.chatWorkspace.findUnique({ where: { platform_externalId: { platform: 'TEAMS', externalId: `tid${stamp}` } } })).toMatchObject({ orgId: org.id, botTokenEnc: null });

    // 5. The console says so.
    expect((await signInViaApi(page.request, emails.admin, PW, { headers: freshIp('chatinst-ui') })).error).toBeNull();
    await gotoSettled(page, '/admin/integrations?chat=connected');
    await expect(page.getByTestId('chat-banner-connected')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('chat-install-SLACK')).toHaveAttribute('href', '/api/integrations/chat/slack/connect');
    await expect(page.getByTestId(`chat-workspace-${ws.id}`)).toBeVisible();

    // 6. Slack removes the app: unsigned / stale / wrong-secret changes nothing; signed switches it off.
    const anon = await playwright.request.newContext({ baseURL });
    ctxs.push(anon);
    const evt = JSON.stringify({ type: 'event_callback', team_id: team, event: { type: 'app_uninstalled' } });
    // The first request compiles the route under `next dev`: give it room.
    expect((await anon.post('/api/integrations/chat/slack/uninstall', { data: evt, headers: { 'content-type': 'application/json' }, timeout: 60_000 })).status()).toBe(401);
    expect((await anon.post('/api/integrations/chat/slack/uninstall', { data: evt, headers: signed(evt, Math.floor(Date.now() / 1000) - 600) })).status()).toBe(401);
    expect((await prisma.chatWorkspace.findUniqueOrThrow({ where: { id: ws.id } })).enabled).toBe(true);
    const challenge = JSON.stringify({ type: 'url_verification', challenge: `c-${stamp}` });
    expect(await (await anon.post('/api/integrations/chat/slack/uninstall', { data: challenge, headers: signed(challenge) })).json()).toEqual({ challenge: `c-${stamp}` });
    const gone = await anon.post('/api/integrations/chat/slack/uninstall', { data: evt, headers: signed(evt) });
    expect(gone.status()).toBe(200);
    const after = await prisma.chatWorkspace.findUniqueOrThrow({ where: { id: ws.id } });
    expect(after).toMatchObject({ enabled: false, botTokenEnc: null, refreshTokenEnc: null, lastError: 'platform_app_uninstalled' });
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'CHAT_PLATFORM_UNINSTALL' } })).toBe(1);
    expect((await anon.post('/api/integrations/chat/teams/uninstall', { data: '{}' })).status()).toBe(404);
  } finally {
    for (const c of ctxs) await c.dispose();
    await prisma.chatWorkspace.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.auditLog.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  }
});
