import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { orgScoped, assertSameOrg, requireOrg, isIsolationEnforced } from '../src/lib/orgScope';
import { prisma as appPrisma } from '../src/lib/prisma';
import { runWithOrg } from '../src/lib/orgContext';
import { signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// Tenant isolation building blocks (#543). These prove that the orgScope
// helpers genuinely separate two tenants at the DB level — the guarantee the
// guarded MT_ENFORCE_ISOLATION rollout depends on. They exercise the helpers +
// Prisma directly (no HTTP), so they pass regardless of the server's flag.
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('orgScoped isolates one tenant’s relations from another’s', async () => {
  const stamp = uniqueEmail('iso').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `Org A ${stamp}`, slug: `orga-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Org B ${stamp}`, slug: `orgb-${stamp}` } });

  const mentorA = await seedUser(uniqueEmail('iso-mentorA'), 'x', 'MENTOR', 'Iso MentorA');
  const menteeA = await seedUser(uniqueEmail('iso-menteeA'), 'x', 'MENTEE', 'Iso MenteeA');
  const mentorB = await seedUser(uniqueEmail('iso-mentorB'), 'x', 'MENTOR', 'Iso MentorB');
  const menteeB = await seedUser(uniqueEmail('iso-menteeB'), 'x', 'MENTEE', 'Iso MenteeB');

  const relA = await prisma.mentorshipRelation.create({ data: { mentorId: mentorA.id, menteeId: menteeA.id, orgId: orgA.id } });
  const relB = await prisma.mentorshipRelation.create({ data: { mentorId: mentorB.id, menteeId: menteeB.id, orgId: orgB.id } });

  try {
    // Scoped to A → only A's relation; B is invisible.
    const seenByA = await prisma.mentorshipRelation.findMany({
      where: orgScoped({ id: { in: [relA.id, relB.id] } }, orgA.id),
    });
    expect(seenByA.map((r) => r.id)).toEqual([relA.id]);
    expect(seenByA.some((r) => r.id === relB.id)).toBe(false);

    // Scoped to B → only B's relation.
    const seenByB = await prisma.mentorshipRelation.findMany({
      where: orgScoped({ id: { in: [relA.id, relB.id] } }, orgB.id),
    });
    expect(seenByB.map((r) => r.id)).toEqual([relB.id]);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relA.id, relB.id] } } });
    await cleanupByEmail(mentorA.email); await cleanupByEmail(menteeA.email);
    await cleanupByEmail(mentorB.email); await cleanupByEmail(menteeB.email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});

test('assertSameOrg blocks cross-tenant access (enforcement on)', () => {
  const prev = process.env.MT_ENFORCE_ISOLATION;
  process.env.MT_ENFORCE_ISOLATION = 'true';
  try {
    expect(isIsolationEnforced()).toBe(true);
    // Same tenant → allowed.
    expect(() => assertSameOrg('org-1', 'org-1', 'org-default')).not.toThrow();
    // Cross tenant → denied.
    expect(() => assertSameOrg('org-2', 'org-1', 'org-default')).toThrow(/Cross-tenant/);
    // requireOrg fails closed when no org resolves under enforcement.
    expect(() => requireOrg({ user: {} } as never)).toThrow(/enforced/);
    // Resolves the org when present.
    expect(requireOrg({ user: { orgId: 'org-9' } } as never)).toBe('org-9');
  } finally {
    process.env.MT_ENFORCE_ISOLATION = prev;
  }
});

test('with enforcement off, requireOrg is a no-op but assertSameOrg still guards (#3588)', () => {
  const prev = process.env.MT_ENFORCE_ISOLATION;
  delete process.env.MT_ENFORCE_ISOLATION;
  try {
    expect(isIsolationEnforced()).toBe(false);
    // The one-row guard holds with the flag off too (#3588): it used to be a
    // no-op here, which left every route that leaned on it unguarded.
    expect(() => assertSameOrg('org-2', 'org-1', 'org-default')).toThrow(/Cross-tenant/);
    expect(() => assertSameOrg(null, 'org-default', 'org-default')).not.toThrow();
    // requireOrg returns null instead of throwing.
    expect(requireOrg({ user: {} } as never)).toBeNull();
  } finally {
    if (prev !== undefined) process.env.MT_ENFORCE_ISOLATION = prev;
  }
});

// The central middleware (#543) is the "can't forget the filter" guarantee: a
// query that NEVER calls orgScoped() is still isolated, purely because it ran
// inside runWithOrg() with enforcement on. This is what makes criterion 1 —
// "every tenant-scoped query returns only its tenant's data" — hold app-wide.
test('central middleware auto-scopes a plain (non-orgScoped) query under runWithOrg', async () => {
  const stamp = uniqueEmail('mw').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `MW A ${stamp}`, slug: `mwa-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `MW B ${stamp}`, slug: `mwb-${stamp}` } });

  // Seed with the plain helper client (no middleware) so seeding is never scoped.
  const emailA = uniqueEmail('mw-a');
  const emailB = uniqueEmail('mw-b');
  const userA = await prisma.user.create({ data: { email: emailA, password: 'x', role: 'MENTEE', fullName: 'MW A', skills: [], orgId: orgA.id } });
  const userB = await prisma.user.create({ data: { email: emailB, password: 'x', role: 'MENTEE', fullName: 'MW B', skills: [], orgId: orgB.id } });

  const prev = process.env.MT_ENFORCE_ISOLATION;
  const ids = { id: { in: [userA.id, userB.id] } };
  try {
    process.env.MT_ENFORCE_ISOLATION = 'true';

    // Plain findMany — NO orgScoped() — bound to org A sees only A's user.
    const seenByA = await runWithOrg(orgA.id, () => appPrisma.user.findMany({ where: ids }));
    expect(seenByA.map((u) => u.id)).toEqual([userA.id]);

    const seenByB = await runWithOrg(orgB.id, () => appPrisma.user.findMany({ where: ids }));
    expect(seenByB.map((u) => u.id)).toEqual([userB.id]);

    // findUnique across tenants returns null (extendedWhereUnique + orgId).
    const crossTenant = await runWithOrg(orgB.id, () => appPrisma.user.findUnique({ where: { id: userA.id } }));
    expect(crossTenant).toBeNull();

    // create auto-stamps the bound org even when data omits orgId.
    const emailC = uniqueEmail('mw-c');
    const created = await runWithOrg(orgA.id, () =>
      appPrisma.user.create({ data: { email: emailC, password: 'x', role: 'MENTEE', fullName: 'MW C', skills: [] } })
    );
    expect(created.orgId).toBe(orgA.id);
    await prisma.user.delete({ where: { id: created.id } });

    // Flag OFF: the same bound query is a no-op — both tenants are visible.
    process.env.MT_ENFORCE_ISOLATION = 'false';
    const seenBoth = await runWithOrg(orgA.id, () => appPrisma.user.findMany({ where: ids }));
    expect(seenBoth.map((u) => u.id).sort()).toEqual([userA.id, userB.id].sort());
  } finally {
    if (prev === undefined) delete process.env.MT_ENFORCE_ISOLATION;
    else process.env.MT_ENFORCE_ISOLATION = prev;
    await cleanupByEmail(emailA);
    await cleanupByEmail(emailB);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await appPrisma.$disconnect();
  }
});

test('central middleware auto-scopes Requisition reads and creates', async () => {
  const stamp = uniqueEmail('req-mw').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `Req MW A ${stamp}`, slug: `req-mwa-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Req MW B ${stamp}`, slug: `req-mwb-${stamp}` } });
  const companyA = await prisma.company.create({ data: { name: `Req MW A ${stamp}`, orgId: orgA.id } });
  const companyB = await prisma.company.create({ data: { name: `Req MW B ${stamp}`, orgId: orgB.id } });
  const reqA = await prisma.requisition.create({ data: { orgId: orgA.id, companyId: companyA.id, title: 'A', openings: 1, requiredSkills: [] } });
  const reqB = await prisma.requisition.create({ data: { orgId: orgB.id, companyId: companyB.id, title: 'B', openings: 1, requiredSkills: [] } });
  const prev = process.env.MT_ENFORCE_ISOLATION;
  try {
    process.env.MT_ENFORCE_ISOLATION = 'true';
    const rows = await runWithOrg(orgA.id, () => appPrisma.requisition.findMany({ where: { id: { in: [reqA.id, reqB.id] } } }));
    expect(rows.map((row) => row.id)).toEqual([reqA.id]);
    const created = await runWithOrg(orgA.id, () => appPrisma.requisition.create({ data: { companyId: companyA.id, title: 'Stamped', openings: 1, requiredSkills: [] } as never }));
    expect(created.orgId).toBe(orgA.id);
  } finally {
    if (prev === undefined) delete process.env.MT_ENFORCE_ISOLATION; else process.env.MT_ENFORCE_ISOLATION = prev;
    await prisma.requisition.deleteMany({ where: { companyId: { in: [companyA.id, companyB.id] } } });
    await prisma.company.deleteMany({ where: { id: { in: [companyA.id, companyB.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});

// The admin door of canMessage() stays inside the admin's tenant
// (src/lib/messageAdminRule.ts). It used to read "an admin may message anyone":
// with MT_ENFORCE_ISOLATION off — every deployment — org A's admin opened a chat
// with org B's user (200), wrote into it (201) and B read it (200). Now: a 404,
// the answer a non-existent id gets, in both directions, for a super admin too,
// and through the inbox's `?to=` as well; a chat that already crossed orgs
// takes no new message. HTTP, against the default (flag-off) server. Each
// create-or-get POST carries its own address (freshIp, #2159): the route's
// 20/15min bucket is per IP and a shard's specs share one.
test('an admin cannot open, or write into, a chat with another tenant\'s user', { tag: '@smoke' }, async ({ browser }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const PW = 'XorgChat123!';
  const orgA = await prisma.organization.create({ data: { name: `Xorg A ${stamp}`, slug: `xorg-a-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Xorg B ${stamp}`, slug: `xorg-b-${stamp}` } });
  const mails = {
    adminA: uniqueEmail('xorg-admin-a'),
    superA: uniqueEmail('xorg-super-a'),
    menteeB: uniqueEmail('xorg-mentee-b'),
    mentorB: uniqueEmail('xorg-mentor-b'),
    menteeA: uniqueEmail('xorg-mentee-a'),
  };
  const adminA = await seedUser(mails.adminA, PW, 'ADMIN', 'Xorg Admin A', orgA.id);
  const superA = await seedUser(mails.superA, PW, 'ADMIN', 'Xorg Super A', orgA.id);
  await prisma.user.update({ where: { id: superA.id }, data: { isSuperAdmin: true } });
  const menteeB = await seedUser(mails.menteeB, PW, 'MENTEE', 'Xorg Mentee B', orgB.id);
  const mentorB = await seedUser(mails.mentorB, PW, 'MENTOR', 'Xorg Mentor B', orgB.id);
  const menteeA = await seedUser(mails.menteeA, PW, 'MENTEE', 'Xorg Mentee A', orgA.id);
  const people = [adminA.id, superA.id, menteeB.id, mentorB.id, menteeA.id];
  const contexts: Array<{ close: () => Promise<void> }> = [];
  const as = async (email: string) => {
    const context = await browser.newContext();
    contexts.push(context);
    expect((await signInViaApi(context.request, email, PW)).ok, email).toBe(true);
    return context;
  };
  try {
    const admin = await as(mails.adminA);
    for (const target of [menteeB.id, mentorB.id]) {
      expect((await admin.request.post('/api/conversations', { data: { userId: target }, headers: freshIp('xorg-chat') })).status()).toBe(404);
    }
    // The same answer as an id that does not exist.
    expect((await admin.request.post('/api/conversations', { data: { userId: 'no-such-user' }, headers: freshIp('xorg-chat') })).status()).toBe(404);
    // Its own tenant still opens: the door is narrowed, not shut.
    expect((await admin.request.post('/api/conversations', { data: { userId: menteeA.id }, headers: freshIp('xorg-chat') })).status()).toBe(200);
    // The inbox's ?to= takes the same rule: the inbox with a notice, no chat.
    const page = await admin.newPage();
    await page.goto(`/messages?to=${menteeB.id}`);
    expect(new URL(page.url()).pathname).toBe('/messages');
    await expect(page.getByTestId('messages-to-refused')).toBeVisible();

    // A super admin's tenant permission does not cross an org either.
    const superAdmin = await as(mails.superA);
    expect((await superAdmin.request.post('/api/conversations', { data: { userId: menteeB.id }, headers: freshIp('xorg-chat') })).status()).toBe(404);

    // The other direction: B's user cannot open a chat with A's admin.
    const mentee = await as(mails.menteeB);
    expect((await mentee.request.post('/api/conversations', { data: { userId: adminA.id }, headers: freshIp('xorg-chat') })).status()).toBe(404);

    expect(
      await prisma.conversation.count({
        where: { type: 'DIRECT', AND: [{ participants: { some: { userId: { in: [adminA.id, superA.id] } } } }, { participants: { some: { userId: { in: [menteeB.id, mentorB.id] } } } }] },
      }),
    ).toBe(0);

    // A chat that crossed orgs before this fix (seeded directly): no new message
    // goes in, from either side. Reading stays with its participants, as for
    // every conversation whose permission has lapsed (#770).
    const stale = await prisma.conversation.create({
      data: { type: 'DIRECT', directKey: [adminA.id, menteeB.id].sort().join('|'), participants: { create: [{ userId: adminA.id }, { userId: menteeB.id }] } },
    });
    expect((await admin.request.post('/api/messages', { data: { conversationId: stale.id, body: 'cross-org' } })).status()).toBe(403);
    expect((await mentee.request.post('/api/messages', { data: { conversationId: stale.id, body: 'cross-org' } })).status()).toBe(403);
    expect(await prisma.message.count({ where: { conversationId: stale.id } })).toBe(0);
  } finally {
    for (const context of contexts) await context.close();
    const conversations = await prisma.conversation.findMany({ where: { participants: { some: { userId: { in: people } } } }, select: { id: true } });
    await prisma.message.deleteMany({ where: { conversationId: { in: conversations.map((c) => c.id) } } });
    await prisma.conversation.deleteMany({ where: { id: { in: conversations.map((c) => c.id) } } });
    for (const email of Object.values(mails)) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
