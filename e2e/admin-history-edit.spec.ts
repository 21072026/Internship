import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can add and delete stage-history entries', async ({ page }) => {
  const adminEmail = uniqueEmail('histadmin');
  const mentorEmail = uniqueEmail('histmentor');
  const menteeEmail = uniqueEmail('histmentee');
  const admin = await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'History Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'History Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'History Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);

    // Add a manual history entry.
    await page.getByLabel('To', { exact: true }).selectOption('HIRED_660');
    const added = page.waitForResponse(
      (r) => r.url().includes('/api/status-changes') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Add entry' }).click();
    await added;

    const afterAdd = await prisma.statusChange.findMany({ where: { relationId: rel.id } });
    expect(afterAdd).toHaveLength(1);
    expect(afterAdd[0].changedById).toBe(admin.id);
    expect(afterAdd[0].toStatus).toBe('HIRED_660');

    await expect(page.getByRole('button', { name: 'Delete entry' })).toBeVisible();
    let detailReloads = 0;
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === `/api/users/${mentee.id}`) {
        detailReloads += 1;
      }
    });
    await page.route(`**/api/status-changes/${afterAdd[0].id}`, async (route) => {
      await route.fulfill({ status: 500, json: { error: 'Failed' } });
    }, { times: 1 });

    await page.getByRole('button', { name: 'Delete entry' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Something went wrong' })).toBeVisible();
    expect(detailReloads).toBe(0);
    expect(await prisma.statusChange.findMany({ where: { relationId: rel.id } })).toHaveLength(1);

    // Delete it again.
    const removed = page.waitForResponse(
      (r) => r.url().includes('/api/status-changes/') && r.request().method() === 'DELETE'
    );
    const reloaded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/users/${mentee.id}` && r.request().method() === 'GET'
    );
    await page.getByRole('button', { name: 'Delete entry' }).click();
    await removed;
    await reloaded;
    expect(detailReloads).toBe(1);

    const afterDelete = await prisma.statusChange.findMany({ where: { relationId: rel.id } });
    expect(afterDelete).toHaveLength(0);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
