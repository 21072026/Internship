import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can move a completed mentee back to an earlier stage; history is appended', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  const menteeEmail = uniqueEmail('mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Status Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Status Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'EMPLOYED_700' },
  });
  // Pre-existing history that must be preserved
  await prisma.statusChange.create({
    data: { relationId: relation.id, fromStatus: 'APPLICATION_100', toStatus: 'EMPLOYED_700', changedById: mentor.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByLabel('Stage')).toBeVisible();
    // Move backward 700 -> 220, waiting for the PUT to complete
    const putDone = page.waitForResponse(
      (r) => r.url().includes(`/api/mentorship/${relation.id}`) && r.request().method() === 'PUT'
    );
    await page.getByLabel('Stage').selectOption('APPROVAL_PENDING_220');
    await putDone;
    await page.waitForTimeout(600);

    const updated = await prisma.mentorshipRelation.findUnique({ where: { id: relation.id } });
    expect(updated?.pipelineStatus).toBe('APPROVAL_PENDING_220');

    // Old history preserved + new entry appended (2 total)
    const changes = await prisma.statusChange.findMany({ where: { relationId: relation.id } });
    expect(changes.length).toBe(2);
    expect(changes.some((c) => c.fromStatus === 'EMPLOYED_700' && c.toStatus === 'APPROVAL_PENDING_220')).toBe(true);
    expect(changes.some((c) => c.fromStatus === 'APPLICATION_100' && c.toStatus === 'EMPLOYED_700')).toBe(true);
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('same-stage writes are no-ops and legacy no-op history stays hidden for custom stages', async ({ page }) => {
  const adminEmail = uniqueEmail('noop-admin');
  const mentorEmail = uniqueEmail('noop-mentor');
  const menteeEmail = uniqueEmail('noop-mentee');
  const password = 'NoopStage123!';
  const admin = await seedUser(adminEmail, password, 'ADMIN', 'No-op Admin');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'No-op Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'No-op Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'custom-review' },
  });
  await prisma.statusChange.createMany({
    data: [
      { relationId: relation.id, fromStatus: 'custom-review', toStatus: 'custom-review', changedById: admin.id },
      { relationId: relation.id, fromStatus: 'custom-start', toStatus: 'custom-review', changedById: admin.id },
    ],
  });

  try {
    await signInAsFreshUser(page, adminEmail, password, '/admin');

    const notificationCount = () => prisma.notification.count({ where: { userId: mentee.id } });
    const beforeNotifications = await notificationCount();
    const noOp = await page.request.post('/api/status-changes', {
      data: { relationId: relation.id, fromStatus: 'client-stale-stage', toStatus: 'custom-review' },
    });
    expect(noOp.status()).toBe(200);
    expect(await noOp.json()).toMatchObject({ change: null, changed: false });
    expect(await prisma.statusChange.count({ where: { relationId: relation.id } })).toBe(2);
    expect(await notificationCount()).toBe(beforeNotifications);

    const backdatedNoOp = await page.request.post('/api/status-changes', {
      data: {
        relationId: relation.id,
        fromStatus: 'custom-review',
        toStatus: 'custom-review',
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    });
    expect(backdatedNoOp.status()).toBe(200);
    expect(await backdatedNoOp.json()).toMatchObject({ change: null, changed: false });
    expect(await prisma.statusChange.count({ where: { relationId: relation.id } })).toBe(2);

    const backdatedReturn = await page.request.post('/api/status-changes', {
      data: {
        relationId: relation.id,
        fromStatus: 'custom-interview',
        toStatus: 'custom-review',
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    });
    expect(backdatedReturn.status()).toBe(201);
    expect((await backdatedReturn.json()).changed).toBe(true);
    expect(await prisma.statusChange.findFirst({
      where: { relationId: relation.id, fromStatus: 'custom-interview', toStatus: 'custom-review' },
    })).toBeTruthy();
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe('custom-review');
    expect(await notificationCount()).toBe(beforeNotifications);

    const backdatedPastMove = await page.request.post('/api/status-changes', {
      data: {
        relationId: relation.id,
        fromStatus: 'custom-start',
        toStatus: 'custom-archived',
        createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      },
    });
    expect(backdatedPastMove.status()).toBe(201);
    expect((await backdatedPastMove.json()).changed).toBe(true);
    expect(await prisma.statusChange.findFirst({
      where: { relationId: relation.id, fromStatus: 'custom-start', toStatus: 'custom-archived' },
    })).toBeTruthy();
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe('custom-review');
    expect(await notificationCount()).toBe(beforeNotifications);

    const changed = await page.request.post('/api/status-changes', {
      data: { relationId: relation.id, fromStatus: 'client-stale-stage', toStatus: 'custom-interview' },
    });
    expect(changed.status()).toBe(201);
    expect((await changed.json()).changed).toBe(true);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe('custom-interview');
    expect(await prisma.statusChange.findFirst({
      where: { relationId: relation.id, fromStatus: 'custom-review', toStatus: 'custom-interview' },
    })).toBeTruthy();

    const beforePutChanges = await prisma.statusChange.count({ where: { relationId: relation.id } });
    const beforePutNotifications = await notificationCount();
    const noOpPut = await page.request.put(`/api/mentorship/${relation.id}`, {
      data: { pipelineStatus: 'custom-interview' },
    });
    expect(noOpPut.status()).toBe(200);
    expect((await noOpPut.json()).changed).toBe(false);
    expect(await prisma.statusChange.count({ where: { relationId: relation.id } })).toBe(beforePutChanges);
    expect(await notificationCount()).toBe(beforePutNotifications);

    const changedPut = await page.request.put(`/api/mentorship/${relation.id}`, {
      data: { pipelineStatus: 'custom-final' },
    });
    expect(changedPut.status()).toBe(200);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe('custom-final');
    expect(await prisma.statusChange.findFirst({
      where: { relationId: relation.id, fromStatus: 'custom-interview', toStatus: 'custom-final' },
    })).toBeTruthy();

    const relationResponse = await page.request.get(`/api/mentorship/${relation.id}`);
    expect(relationResponse.ok()).toBeTruthy();
    const relationBody = await relationResponse.json();
    expect(relationBody.relation.statusChanges).not.toContainEqual(expect.objectContaining({
      fromStatus: 'custom-review',
      toStatus: 'custom-review',
    }));

    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByText('custom-start').first()).toBeVisible();
    await expect(page.getByText('custom-interview').first()).toBeVisible();
    await expect(page.getByText('custom-final').first()).toBeVisible();
    await expect(page.locator('li').filter({ hasText: /custom-review\s*→\s*custom-review/ })).toHaveCount(0);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
