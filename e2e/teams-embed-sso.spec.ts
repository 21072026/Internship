import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { E2E_BOTFRAMEWORK_MOCK_PORT } from '../playwright.config';

// The Teams tab sign-in (#1954, docs/teams-tab-sso.md), over HTTP against the
// app, with Entra tokens signed by the local stub. Every refusal is tested
// first; nothing refused may mint a grant, create an account or a session.

const CLIENT = 'e2e-teams-sso-client';
const PW = 'TeamsSso123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function setup(playwright: { request: { newContext: (o?: object) => Promise<APIRequestContext> } }, baseURL: string | undefined) {
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const tid = crypto.randomUUID();
  const oid = crypto.randomUUID();
  const org = await prisma.organization.create({ data: { name: `Teams SSO ${stamp}`, slug: `teams-sso-${stamp}` } });
  const email = uniqueEmail('teams-sso');
  const user = await seedUser(email, PW, 'MENTEE', `Teams Person ${stamp}`, { orgId: org.id });
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, isActive: true } });
  const ws = await prisma.chatWorkspace.create({ data: { orgId: org.id, platform: 'TEAMS', externalId: tid, name: 'Acme Teams', scope: 'bot', installedById: user.id } });
  const identity = await prisma.chatIdentity.create({ data: { orgId: org.id, workspaceId: ws.id, userId: user.id, externalUserId: oid, verifiedAt: new Date() } });
  // Our own page's origin, as the tab's fetch would carry it.
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin } });
  const mock = await playwright.request.newContext();
  const now = Math.floor(Date.now() / 1000);
  const claims = (over: Record<string, unknown> = {}) => ({ aud: CLIENT, iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, oid, iat: now, nbf: now - 10, exp: now + 600, ...over });
  const sign = async (c: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    (await (await mock.post(`http://127.0.0.1:${E2E_BOTFRAMEWORK_MOCK_PORT}/__sign`, { data: { claims: c, ...opts } })).json()).token as string;
  const sso = (token: string) => api.post('/api/integrations/chat/teams/sso', { data: { token }, timeout: 60_000 });
  // A grant and the nonce cookie /sso gave this browser, as the tab would hold them.
  const ssoGrant = async (token: string) => {
    const res = await sso(token);
    const nonce = res.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('embed-sso-nonce='))?.value.split(';')[0] ?? '';
    return { grant: ((await res.json()) as { grant: string }).grant, nonce };
  };
  const session = (grant: string, nonce = '', headers: Record<string, string> = {}) =>
    api.post('/api/integrations/chat/teams/session', { data: { grant }, headers: { ...(nonce ? { cookie: nonce } : {}), ...headers }, timeout: 60_000 });
  const grants = () => prisma.chatLoginGrant.count({ where: { userId: user.id } });
  const cleanup = async () => {
    await api.dispose();
    await mock.dispose();
    await prisma.chatLoginGrant.deleteMany({ where: { userId: user.id } });
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } });
  };
  // Another browser: a fresh context with no cookie jar, so only the nonce passed here is sent.
  const elsewhere = async (grant: string, nonce = '') => {
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin } });
    try {
      return (await ctx.post('/api/integrations/chat/teams/session', { data: { grant }, headers: nonce ? { cookie: nonce } : {}, timeout: 60_000 })).status();
    } finally {
      await ctx.dispose();
    }
  };
  return { stamp, tid, oid, user, identity, api, claims, sign, sso, ssoGrant, session, elsewhere, grants, cleanup };
}

const embedCookie = (setCookie: string[]) => setCookie.find((c) => c.startsWith('embed-session='));

test('refusals: wrong tid, wrong aud, expired, foreign key, unknown member, reused grant, 2FA, inactive user', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.setTimeout(120_000);
  const s = await setup(playwright, baseURL);
  try {
    // Not a platform with a tab.
    expect((await s.api.post('/api/integrations/chat/slack/sso', { data: { token: 'x' } })).status()).toBe(404);
    // Garbage, a foreign key, the wrong audience, an expired token.
    expect((await s.sso('not.a.jwt')).status()).toBe(401);
    expect((await s.sso(await s.sign(s.claims(), { foreign: true }))).status()).toBe(401);
    expect((await s.sso(await s.sign(s.claims({ aud: 'another-app' })))).status()).toBe(401);
    expect((await s.sso(await s.sign(s.claims({ exp: Math.floor(Date.now() / 1000) - 3600 })))).status()).toBe(401);
    // A tenant nobody installed, and an issuer that names another tenant than the token.
    const other = crypto.randomUUID();
    expect((await s.sso(await s.sign(s.claims({ tid: other, iss: `https://login.microsoftonline.com/${other}/v2.0` })))).status()).toBe(401);
    expect((await s.sso(await s.sign(s.claims({ iss: `https://login.microsoftonline.com/${other}/v2.0` })))).status()).toBe(401);
    // An unknown member: the link prompt, no grant, no account.
    const users = await prisma.user.count();
    const unknown = await s.sso(await s.sign(s.claims({ oid: crypto.randomUUID() })));
    expect(await unknown.json()).toEqual({ link: true });
    expect(await prisma.user.count()).toBe(users);
    expect(await s.grants()).toBe(0);

    // A good token: one grant, bound to this browser's nonce, spent once.
    const ok = await s.ssoGrant(await s.sign(s.claims()));
    expect(typeof ok.grant).toBe('string');
    expect(ok.nonce).toMatch(/^embed-sso-nonce=/);
    const first = await s.session(ok.grant, ok.nonce);
    expect(first.status()).toBe(200);
    expect((await s.session(ok.grant, ok.nonce)).status()).toBe(401);
    // Only the hash is stored.
    expect(await prisma.chatLoginGrant.count({ where: { tokenHash: ok.grant } })).toBe(0);

    // An enrolled authenticator is not bypassed: 2FA_REQUIRED, the grant left unspent.
    await prisma.user.update({ where: { id: s.user.id }, data: { twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP' } });
    const twoFa = await s.ssoGrant(await s.sign(s.claims()));
    const asked = await s.session(twoFa.grant, twoFa.nonce);
    expect(asked.status()).toBe(401);
    expect(await asked.json()).toMatchObject({ code: '2FA_REQUIRED' });
    expect(await prisma.chatLoginGrant.count({ where: { userId: s.user.id, used: false } })).toBe(1);
    await prisma.chatLoginGrant.deleteMany({ where: { userId: s.user.id, used: false } });
    await prisma.user.update({ where: { id: s.user.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } });

    // Inactive: the grant is minted, but redeeming it is refused and leaves it unspent.
    const again = await s.ssoGrant(await s.sign(s.claims()));
    await prisma.user.update({ where: { id: s.user.id }, data: { isActive: false } });
    const refused = await s.session(again.grant, again.nonce);
    expect(refused.status()).toBe(401);
    expect(embedCookie(refused.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value))).toBeUndefined();
    expect(await prisma.chatLoginGrant.count({ where: { userId: s.user.id, used: false } })).toBe(1);
  } finally {
    await s.cleanup();
  }
});

test('a signed-in tab: its own Partitioned cookie, eight hours, revoked with every session', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.setTimeout(120_000);
  const s = await setup(playwright, baseURL);
  try {
    const { grant, nonce } = await s.ssoGrant(await s.sign(s.claims()));
    const res = await s.session(grant, nonce);
    expect(res.status()).toBe(200);
    const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
    const cookie = embedCookie(setCookies)!;
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=28800/);
    // Never NextAuth's own session cookie.
    expect(setCookies.some((c) => c.startsWith('next-auth.session-token'))).toBe(false);
    const value = cookie.split(';')[0];

    // The embed cookie is a session, and a refresh stays in the embed cookie.
    const viewer = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: value } });
    const sessionRes = await viewer.get('/api/auth/session');
    expect((await sessionRes.json()).user?.id).toBe(s.user.id);
    const refreshed = sessionRes.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
    expect(refreshed.some((c) => c.startsWith('next-auth.session-token'))).toBe(false);
    expect(await (await viewer.get('/embed')).text()).toContain(`Teams Person ${s.stamp}`);

    // Never a remembered device; a cross-site write is refused like any other.
    expect((await viewer.post('/api/auth/remember', { data: {} })).status()).toBe(400);
    expect((await viewer.post('/api/auth/remember', { data: {}, headers: { origin: 'https://evil.example' } })).status()).toBe(403);

    // "Sign out of all devices" ends it on the next request.
    await prisma.user.update({ where: { id: s.user.id }, data: { sessionsValidFrom: new Date(Date.now() + 1000) } });
    const after = (await (await viewer.get('/api/auth/session')).json()) as { user?: unknown } | null;
    expect(after?.user).toBeUndefined();
    await viewer.dispose();
  } finally {
    await s.cleanup();
  }
});

test('login CSRF: a foreign origin is refused; a grant without its nonce is never spent', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.setTimeout(120_000);
  const s = await setup(playwright, baseURL);
  try {
    const token = await s.sign(s.claims());
    // Another site's page: 403 before anything is read.
    expect((await s.api.post('/api/integrations/chat/teams/sso', { data: { token }, headers: { origin: 'https://evil.example' } })).status()).toBe(403);
    expect((await s.session('x', '', { origin: 'https://evil.example' })).status()).toBe(403);
    expect(await s.grants()).toBe(0);

    // The right grant, but not this browser's nonce: refused, and still unspent.
    const { grant, nonce } = await s.ssoGrant(token);
    expect(await s.elsewhere(grant)).toBe(401);
    expect(await s.elsewhere(grant, 'embed-sso-nonce=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(401);
    expect(await prisma.chatLoginGrant.count({ where: { userId: s.user.id, used: false } })).toBe(1);
    // With its own nonce it works.
    expect(await s.elsewhere(grant, nonce)).toBe(200);
  } finally {
    await s.cleanup();
  }
});

test('framing: /embed is framable by Teams only; every other path stays DENY', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL });
  try {
    const embed = await api.get('/embed', { timeout: 60_000 });
    const csp = embed.headers()['content-security-policy'] ?? '';
    expect(csp).toContain('frame-ancestors https://teams.microsoft.com');
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(embed.headers()['x-frame-options']).toBeUndefined();
    for (const path of ['/features', '/auth/signin', '/embedded', '/api/health']) {
      const r = await api.get(path, { timeout: 60_000 });
      expect(r.headers()['x-frame-options'], path).toBe('DENY');
      expect(r.headers()['content-security-policy'] ?? '', path).toContain("frame-ancestors 'none'");
    }
  } finally {
    await api.dispose();
  }
});

test('the first-party session cookie keeps its name and SameSite=Lax', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const email = uniqueEmail('teams-sso-lax');
  await seedUser(email, PW, 'MENTEE', 'Lax Person');
  const api = await playwright.request.newContext({ baseURL });
  try {
    const { csrfToken } = (await (await api.get('/api/auth/csrf')).json()) as { csrfToken: string };
    const res = await api.post('/api/auth/callback/credentials', {
      form: { csrfToken, email, password: PW, json: 'true' },
      maxRedirects: 0,
      timeout: 60_000,
    });
    const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
    const main = setCookies.find((c) => c.startsWith('next-auth.session-token='));
    expect(main).toBeDefined();
    expect(main).toMatch(/SameSite=Lax/i);
    expect(main).not.toMatch(/Partitioned/i);
    expect(setCookies.some((c) => c.startsWith('embed-session='))).toBe(false);
  } finally {
    await api.dispose();
    await cleanupByEmail(email);
  }
});
