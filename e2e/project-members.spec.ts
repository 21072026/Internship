import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #617: multi-owner/multi-mentor membership. Creating a person-owned project
// writes an OWNER member row; members can be added/promoted/removed via
// /api/projects/[id]/members; the last OWNER can never be removed or demoted;
// removing the legacy owner repoints the legacy pointer at a remaining OWNER.
test('project members: add, promote, last-owner guard, legacy-owner repointing', async ({ browser }) => {
  const adminEmail = uniqueEmail('pm-admin');
  const m1Email = uniqueEmail('pm-mentor1');
  const m2Email = uniqueEmail('pm-mentor2');
  const pw = 'MembersPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Members Admin');
  const m1 = await seedUser(m1Email, 'x', 'MENTOR', 'Members Mentor One');
  const m2 = await seedUser(m2Email, 'x', 'MENTOR', 'Members Mentor Two');

  const ctx = await browser.newContext();
  let projectId = '';
  try {
    const page = await ctx.newPage();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Create → the person owner automatically becomes an OWNER member.
    const created = await page.request.post('/api/projects', {
      data: { name: 'Members Project', ownerType: 'MENTOR', ownerUserId: m1.id },
    });
    expect(created.ok()).toBeTruthy();
    projectId = (await created.json()).project.id;
    let members = (await (await page.request.get(`/api/projects/${projectId}/members`)).json()).members as
      { role: string; user: { id: string } }[];
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: 'OWNER', user: { id: m1.id } });

    // Add a second mentor, then promote them to OWNER.
    const added = await page.request.post(`/api/projects/${projectId}/members`, { data: { userId: m2.id, role: 'MENTOR' } });
    expect(added.status()).toBe(201);
    const promoted = await page.request.post(`/api/projects/${projectId}/members`, { data: { userId: m2.id, role: 'OWNER' } });
    expect(promoted.status()).toBe(201);

    // Remove the original owner → allowed (another OWNER remains) and the
    // legacy pointer follows.
    const removed = await page.request.delete(`/api/projects/${projectId}/members`, { data: { userId: m1.id } });
    expect(removed.ok()).toBeTruthy();
    const after = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true } });
    expect(after!.ownerUserId).toBe(m2.id);

    // Last-owner guards: neither removal nor demotion may leave zero owners.
    const lastRemove = await page.request.delete(`/api/projects/${projectId}/members`, { data: { userId: m2.id } });
    expect(lastRemove.status()).toBe(409);
    expect((await lastRemove.json()).code).toBe('last_owner');
    const lastDemote = await page.request.post(`/api/projects/${projectId}/members`, { data: { userId: m2.id, role: 'MENTOR' } });
    expect(lastDemote.status()).toBe(409);

    members = (await (await page.request.get(`/api/projects/${projectId}/members`)).json()).members;
    expect(members.filter((m) => m.role === 'OWNER')).toHaveLength(1);
  } finally {
    await ctx.close();
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await cleanupByEmail(m1Email);
    await cleanupByEmail(m2Email);
    await cleanupByEmail(adminEmail);
  }
});
