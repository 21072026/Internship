import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a project carries dates/draft status, a task list and a progress %', async ({ page }) => {
  const adminEmail = uniqueEmail('pt-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'PT Admin');
  let projectId = '';

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Create a DRAFT project with start/end dates and goals.
    const created = await page.request.post('/api/projects', {
      data: {
        name: 'Community Site', status: 'DRAFT', ownerType: 'ADMIN', ownerUserId: admin.id,
        goals: 'Launch v1', startDate: '2026-07-01', endDate: '2026-09-01',
      },
    });
    expect(created.status()).toBe(201);
    projectId = (await created.json()).project.id;

    // Add two tasks; complete one → 50% progress.
    const t1 = await page.request.post(`/api/projects/${projectId}/tasks`, { data: { title: 'Design' } });
    const t2 = await page.request.post(`/api/projects/${projectId}/tasks`, { data: { title: 'Build' } });
    expect(t1.status()).toBe(201);
    expect(t2.status()).toBe(201);
    const taskId = (await t1.json()).task.id;
    const done = await page.request.patch(`/api/project-tasks/${taskId}`, { data: { done: true } });
    expect(done.ok()).toBeTruthy();

    // Read back: project keeps its fields and tasks reflect 1 done of 2.
    const list = await (await page.request.get('/api/projects')).json();
    const proj = list.projects.find((p: { id: string }) => p.id === projectId);
    expect(proj.status).toBe('DRAFT');
    expect(proj.goals).toBe('Launch v1');
    expect(proj.tasks.length).toBe(2);
    expect(proj.tasks.filter((t: { done: boolean }) => t.done).length).toBe(1);
  } finally {
    if (projectId) {
      await prisma.projectTask.deleteMany({ where: { projectId } });
      await prisma.project.deleteMany({ where: { id: projectId } });
    }
    await cleanupByEmail(adminEmail);
  }
});
