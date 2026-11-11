import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { E2E_BOTFRAMEWORK_MOCK_PORT } from '../playwright.config';

// The Teams tab's pages (#1954, slice 2). Outside Teams the tab shows the
// "link your account" screen and signs nobody in. With an embed session (made
// through the real /sso → /session flow), /embed goes to the role home, which
// renders the SAME dashboard the shell renders, and the org's 2FA policy holds.

const CLIENT = 'e2e-teams-sso-client';
const PW = 'TeamsHome123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function embedSessionFor(api: APIRequestContext, mock: APIRequestContext, userId: string, orgId: string, stamp: string) {
  const tid = crypto.randomUUID();
  const oid = crypto.randomUUID();
  const ws = await prisma.chatWorkspace.create({ data: { orgId, platform: 'TEAMS', externalId: tid, name: 'Acme Teams', scope: 'bot', installedById: userId } });
  await prisma.chatIdentity.create({ data: { orgId, workspaceId: ws.id, userId, externalUserId: oid, verifiedAt: new Date() } });
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: CLIENT, iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, oid, iat: now, nbf: now - 10, exp: now + 600 };
  const token = (await (await mock.post(`http://127.0.0.1:${E2E_BOTFRAMEWORK_MOCK_PORT}/__sign`, { data: { claims } })).json()).token as string;
  const sso = await api.post('/api/integrations/chat/teams/sso', { data: { token }, timeout: 60_000 });
  const nonce = sso.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('embed-sso-nonce='))!.value.split(';')[0];
  const { grant } = (await sso.json()) as { grant: string };
  const res = await api.post('/api/integrations/chat/teams/session', { data: { grant }, headers: { cookie: nonce }, timeout: 60_000 });
  expect(res.status(), stamp).toBe(200);
  const cookie = res.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('embed-session='))!.value.split(';')[0];
  return { cookie, workspaceId: ws.id };
}

test('outside Teams the tab shows the link screen and signs nobody in', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/embed');
  await expect(page.getByTestId('embed-link')).toBeVisible({ timeout: 20_000 });
});

test('an embed session lands on the role home; the 2FA policy holds; other roles open the browser', async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Teams Home ${stamp}`, slug: `teams-home-${stamp}` } });
  const emails = { mentor: uniqueEmail('th-mentor'), mentee: uniqueEmail('th-mentee'), admin: uniqueEmail('th-admin') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', `TH Mentor ${stamp}`, { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', `TH Mentee ${stamp}`, { orgId: org.id });
  const admin = await seedUser(emails.admin, PW, 'ADMIN', `TH Admin ${stamp}`, { orgId: org.id });
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id, admin.id] } }, data: { emailVerified: true, isActive: true } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin } });
  const mock = await playwright.request.newContext();
  const workspaces: string[] = [];
  const asTab = async (cookie: string) => playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie } });
  try {
    // A mentor: /embed goes to the role home, which is the mentor dashboard.
    const m = await embedSessionFor(api, mock, mentor.id, org.id, stamp);
    workspaces.push(m.workspaceId);
    const mentorTab = await asTab(m.cookie);
    const landing = await mentorTab.get('/embed', { maxRedirects: 0, timeout: 60_000 });
    expect(landing.status()).toBeGreaterThanOrEqual(300);
    expect(landing.headers()['location']).toContain('/embed/home');
    const home = await mentorTab.get('/embed/home', { timeout: 60_000 });
    expect(home.status()).toBe(200);
    const html = await home.text();
    expect(html).toContain('data-testid="embed-home"');
    expect(html).toContain(`TH Mentee ${stamp}`);
    await mentorTab.dispose();

    // An admin: not a second copy of the admin shell — the way to it in the browser.
    const a = await embedSessionFor(api, mock, admin.id, org.id, stamp);
    workspaces.push(a.workspaceId);
    const adminTab = await asTab(a.cookie);
    const adminHome = await (await adminTab.get('/embed/home', { timeout: 60_000 })).text();
    expect(adminHome).not.toContain('data-testid="embed-home"');
    expect(adminHome).toContain('/admin');
    await adminTab.dispose();

    // The org requires 2FA for everyone: a mentee who has not enrolled is sent to set it up.
    await prisma.setting.create({ data: { key: 'require2fa', value: 'all', orgId: org.id } }).catch(async () => {
      await prisma.setting.updateMany({ where: { key: 'require2fa', orgId: org.id }, data: { value: 'all' } });
    });
    const e = await embedSessionFor(api, mock, mentee.id, org.id, stamp);
    workspaces.push(e.workspaceId);
    const menteeTab = await asTab(e.cookie);
    const gated = await (await menteeTab.get('/embed/home', { timeout: 60_000 })).text();
    expect(gated).not.toContain('data-testid="embed-home"');
    expect(gated).toContain('/security-setup');
    await menteeTab.dispose();
  } finally {
    await api.dispose();
    await mock.dispose();
    await prisma.setting.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.chatLoginGrant.deleteMany({ where: { userId: { in: [mentor.id, mentee.id, admin.id] } } });
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await prisma.chatWorkspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const em of Object.values(emails)) await cleanupByEmail(em);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
