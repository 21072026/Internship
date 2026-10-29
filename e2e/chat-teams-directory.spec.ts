import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { recordChatInstall } from '@/lib/chat/workspaces';
import { teamsClient } from '@/lib/chat/client/teams';
import { E2E_BOTFRAMEWORK_MOCK_PORT } from '../playwright.config';

// Teams "Find people" (#3327): the tenant directory read through Microsoft
// Graph — against the local stub (e2e/support/botframework-mock.mjs), never a
// real tenant. Proposals only for enabled, mailbox-holding directory users
// whose address belongs to a verified, active account of the same org; paging
// is followed on the Graph host only; without TEAMS_GRAPH_DIRECTORY_ENABLED
// the answer stays not_supported.

const PW = 'TeamsDir123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('without the flag, Teams has no directory read', { tag: '@smoke' }, async () => {
  const saved = process.env.TEAMS_GRAPH_DIRECTORY_ENABLED;
  delete process.env.TEAMS_GRAPH_DIRECTORY_ENABLED;
  try {
    await expect(teamsClient.listMembers({ token: '', externalId: 'tid' })).rejects.toThrow('not_supported');
  } finally {
    if (saved !== undefined) process.env.TEAMS_GRAPH_DIRECTORY_ENABLED = saved;
  }
});

test('Teams Find people proposes only verified matches, pages on the Graph host only', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `TeamsDir ${stamp}`, slug: `teamsdir-${stamp}` } });
  const emails = {
    admin: uniqueEmail('teamsdir-admin'),
    a: uniqueEmail('teamsdir-a'),
    b: uniqueEmail('teamsdir-b'),
    c: uniqueEmail('teamsdir-unverified'),
    late: uniqueEmail('teamsdir-late'),
  };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'TeamsDir Admin', { orgId: org.id });
  const a = await seedUser(emails.a, PW, 'MENTOR', 'TeamsDir A', { orgId: org.id });
  const b = await seedUser(emails.b, PW, 'MENTOR', 'TeamsDir B', { orgId: org.id });
  const c = await seedUser(emails.c, PW, 'MENTOR', 'TeamsDir C', { orgId: org.id });
  await prisma.user.update({ where: { id: c.id }, data: { emailVerified: false } });
  await seedUser(emails.late, PW, 'MENTOR', 'TeamsDir Late', { orgId: org.id });

  const mock = await playwright.request.newContext();
  const setDir = (tenant: string, users: unknown[], foreignNextLink = false) =>
    mock.post(`http://127.0.0.1:${E2E_BOTFRAMEWORK_MOCK_PORT}/__graph-users`, { data: { tenant, users, foreignNextLink } });
  const tid = `tid-${stamp}`;
  const tid2 = `tid2-${stamp}`;
  const api = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(api, emails.admin, PW, { headers: freshIp('teamsdir-admin') })).error).toBeNull();
    const ws = await recordChatInstall({ orgId: org.id, platform: 'TEAMS', externalId: tid, name: 'Acme Teams', botToken: null, scope: 'bot', installedById: admin.id });
    // Three pages of two: a match, a disabled account, an unverified CRM user,
    // a mailbox-less user, a stranger and a second match.
    await setDir(tid, [
      { id: `oid-a-${stamp}`, displayName: 'A in Teams', mail: emails.a.toUpperCase(), accountEnabled: true },
      { id: `oid-off-${stamp}`, displayName: 'Disabled', mail: emails.b, accountEnabled: false },
      { id: `oid-c-${stamp}`, displayName: 'Unverified', mail: emails.c, accountEnabled: true },
      { id: `oid-nomail-${stamp}`, displayName: 'No Mail', mail: null, accountEnabled: true },
      { id: `oid-x-${stamp}`, displayName: 'Stranger', mail: `stranger-${stamp}@acme.example`, accountEnabled: true },
      { id: `oid-b-${stamp}`, displayName: 'B in Teams', mail: emails.b, accountEnabled: true },
    ]);
    const usersBefore = await prisma.user.count();
    const propose = (id: string) => api.post(`/api/admin/integrations/chat/${id}/propose`, { timeout: 60_000 });
    const r1 = await propose(ws.id);
    expect(r1.status(), await r1.text()).toBe(200);
    expect(await r1.json()).toEqual({ proposed: 2, alreadyLinked: 0, unmatched: 2 });
    expect(await prisma.user.count()).toBe(usersBefore);
    const rows = await prisma.chatIdentity.findMany({ where: { workspaceId: ws.id }, orderBy: { externalUserId: 'asc' } });
    expect(rows.map((r) => [r.userId, r.externalUserId, r.displayName, r.verifiedAt])).toEqual([
      [a.id, `oid-a-${stamp}`, 'A in Teams', null],
      [b.id, `oid-b-${stamp}`, 'B in Teams', null],
    ]);
    // Idempotent.
    expect(await (await propose(ws.id)).json()).toEqual({ proposed: 0, alreadyLinked: 2, unmatched: 2 });

    // A nextLink pointing off the Graph host is not followed: the match on page 2 is never read.
    const ws2 = await recordChatInstall({ orgId: org.id, platform: 'TEAMS', externalId: tid2, name: 'Acme Teams Two', botToken: null, scope: 'bot', installedById: admin.id });
    await setDir(
      tid2,
      [
        { id: `oid2-x-${stamp}`, displayName: 'Stranger', mail: `s2-${stamp}@acme.example`, accountEnabled: true },
        { id: `oid2-y-${stamp}`, displayName: 'Stranger 2', mail: `s3-${stamp}@acme.example`, accountEnabled: true },
        { id: `oid2-late-${stamp}`, displayName: 'Late', mail: emails.late, accountEnabled: true },
      ],
      true,
    );
    expect(await (await propose(ws2.id)).json()).toEqual({ proposed: 0, alreadyLinked: 0, unmatched: 2 });
    expect(await prisma.chatIdentity.count({ where: { workspaceId: ws2.id } })).toBe(0);
  } finally {
    await api.dispose();
    await mock.dispose();
    await prisma.chatWorkspace.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
