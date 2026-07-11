import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #619: owner-only field permissions. A non-owner MENTOR member may edit the
// collaborative fields (description, tech, links, goals, tasks) but gets 403
// for owner-protected fields (name/status/isPublic/dates/owner) and delete.
test('owner-only fields: mentor member edits collaborative fields, protected ones are 403', async ({ browser }) => {
  const ownerEmail = uniqueEmail('perm-owner');
  const memberEmail = uniqueEmail('perm-member');
  const pw = 'PermsPass123';
  const owner = await seedUser(ownerEmail, 'x', 'MENTOR', 'Perm Owner');
  const member = await seedUser(memberEmail, pw, 'MENTOR', 'Perm Member');

  const project = await prisma.project.create({
    data: {
      name: 'Perms Project', ownerType: 'MENTOR', ownerUserId: owner.id, technologies: [],
      members: {
        create: [
          { userId: owner.id, role: 'OWNER' },
          { userId: member.id, role: 'MENTOR' },
        ],
      },
    },
  });

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', memberEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    // Member sees the project in their list (not owner, still a member).
    const listed = await (await page.request.get('/api/projects')).json();
    expect((listed.projects as { id: string }[]).some((pr) => pr.id === project.id)).toBe(true);

    // Collaborative edit works…
    const okEdit = await page.request.put(`/api/projects/${project.id}`, {
      data: { description: 'Updated by a mentor member', technologies: ['TypeScript'] },
    });
    expect(okEdit.ok()).toBeTruthy();

    // …owner-protected fields are rejected with the field list…
    const blocked = await page.request.put(`/api/projects/${project.id}`, {
      data: { name: 'Hijacked', status: 'ARCHIVED' },
    });
    expect(blocked.status()).toBe(403);
    const body = await blocked.json();
    expect(body.code).toBe('owner_only');
    expect(body.fields).toContain('name');

    // …tasks are collaborative…
    const task = await page.request.post(`/api/projects/${project.id}/tasks`, { data: { title: 'Member task' } });
    expect(task.status()).toBe(201);

    // …and deletion is owner-only.
    const del = await page.request.delete(`/api/projects/${project.id}`);
    expect(del.status()).toBe(403);
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(1);
    const after = await prisma.project.findUnique({ where: { id: project.id }, select: { name: true, description: true } });
    expect(after!.name).toBe('Perms Project');
    expect(after!.description).toBe('Updated by a mentor member');
  } finally {
    await ctx.close();
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(memberEmail);
    await cleanupByEmail(ownerEmail);
  }
});
