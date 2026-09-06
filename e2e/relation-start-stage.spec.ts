import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { loadOnboardingState } from '../src/lib/menteeOnboarding';

// A new relation starts on the TENANT'S first on-path stage (#1634).
//
// The schema default is the canonical `APPLICATION_100`, and every create path
// used to just let it apply. For an org that customised its pipeline that key is
// in no `PipelineStage` row, so the relation had no board column to render in
// and no funnel row to count in — the mentee was invisible from the moment they
// were assigned. Both halves are asserted here: the custom org lands on its own
// first on-path stage AND the card actually shows up in that column, and the org
// on the built-in catalogue still lands on `APPLICATION_100`, byte-identically.
test.afterAll(async () => {
  await prisma.$disconnect();
});

const PASSWORD = 'StartStagePass123!';

test('a relation created in a custom-pipeline org starts on that org\'s first on-path stage', { tag: '@smoke' }, async ({ page }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `Start Stage ${stamp}`, slug: `start-stage-${stamp}` },
  });
  // WITHDRAWN sits FIRST in the tenant's own order and is off-path: a start
  // stage is the first stage the happy path visits, never a drop-out bucket, so
  // this pins that `startStageKey` skips it rather than taking `order: 0`.
  await prisma.pipelineStage.createMany({
    data: [
      { orgId: org.id, key: 'WITHDRAWN', label: 'Withdrew', order: 0, isOffPath: true, isTerminal: true },
      { orgId: org.id, key: 'SOURCED', label: 'Sourced', order: 1 },
      { orgId: org.id, key: 'SCREENING', label: 'Screening', order: 2 },
      { orgId: org.id, key: 'PLACED', label: 'Placed', order: 3, isTerminal: true },
    ],
  });

  const adminEmail = uniqueEmail('startstage-admin');
  const mentorEmail = uniqueEmail('startstage-mentor');
  const menteeEmail = uniqueEmail('startstage-mentee');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Start Stage Admin');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Start Stage Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Start Stage Mentee');
  await prisma.user.updateMany({
    where: { id: { in: [admin.id, mentor.id, mentee.id] } },
    data: { orgId: org.id },
  });

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

    // The API takes no stage at all — the point of the fix is that the server
    // derives it, so a client that knows nothing about stages still gets it right.
    const res = await page.request.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(res.status()).toBe(201);

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee.id },
      select: { pipelineStatus: true },
    });
    expect(relation?.pipelineStatus).toBe('SOURCED');

    // …and it is visible where the admin looks for it: the first real column of
    // the tenant's own board, not a column that does not exist.
    await page.goto('/admin/board');
    const column = page.getByTestId('board-column-SOURCED');
    await expect(column.getByText('Start Stage Mentee', { exact: true })).toBeVisible({ timeout: 15_000 });

    // …and the mentor's onboarding checklist still asks them to move the mentee
    // off it. That step is DERIVED from "is the relation still on the first
    // stage?", so a hardcoded APPLICATION_100 would read as already done the
    // moment the relation exists — a tick no mentor could ever undo.
    const onboarding = await loadOnboardingState(mentor.id, mentee.id);
    expect(onboarding?.steps.pipeline.done).toBe(false);
  } finally {
    await prisma.statusChange.deleteMany({ where: { relation: { orgId: org.id } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    for (const email of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('an org on the built-in stages still starts a relation on APPLICATION_100', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('defaultstage-admin');
  const mentorEmail = uniqueEmail('defaultstage-mentor');
  const menteeEmail = uniqueEmail('defaultstage-mentee');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Default Stage Admin');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Default Stage Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Default Stage Mentee');

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
    const res = await page.request.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(res.status()).toBe(201);

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee.id },
      select: { pipelineStatus: true },
    });
    expect(relation?.pipelineStatus).toBe('APPLICATION_100');
  } finally {
    for (const email of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(email);
  }
});
