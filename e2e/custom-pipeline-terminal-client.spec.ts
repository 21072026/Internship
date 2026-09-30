import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1884, client slice: the cohorts table's "hired" column and the candidate
// page's "past the stage deadline" line decided "finished" with
// ['HIRED_660','EMPLOYED_700']. On a tenant's own stage catalogue neither key
// exists, so every cohort read 0 hired and a placed candidate with a stale
// deadline stayed flagged. Both now read the tenant's resolved stages: the
// cohorts page through the #1882 outcome rule, the chip through the one
// stage-clock rule (#1724).
test('a renamed pipeline: cohorts count its own finished stage, and a placed candidate is not overdue (#1884)', async ({ page }) => {
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: `Client Stages ${stamp}`, slug: `client-stages-${stamp}` } });
  await prisma.pipelineStage.createMany({
    data: [
      { orgId: org.id, key: 'STAGE_INTAKE', label: 'Intake', order: 0 },
      { orgId: org.id, key: 'STAGE_WORK', label: 'Working together', order: 1 },
      { orgId: org.id, key: 'STAGE_PLACED', label: 'Placed at partner', order: 2, isTerminal: true },
    ],
  });
  const adminEmail = uniqueEmail('cstage-client-admin');
  const mentorEmail = uniqueEmail('cstage-client-mentor');
  const menteeA = uniqueEmail('cstage-client-a');
  const menteeB = uniqueEmail('cstage-client-b');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Client Stage Admin', org.id);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Client Stage Mentor', org.id);
  const a = await seedUser(menteeA, 'MenteePass123', 'MENTEE', 'Still Working', org.id);
  const b = await seedUser(menteeB, 'x', 'MENTEE', 'Already Placed', org.id);
  const cohort = await prisma.cohort.create({ data: { name: `Cohort ${stamp}`, orgId: org.id } });
  const past = new Date('2020-01-01');
  const open = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: a.id, orgId: org.id, cohortId: cohort.id, pipelineStatus: 'STAGE_WORK', stageDeadline: past },
  });
  const done = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: b.id, orgId: org.id, cohortId: cohort.id, pipelineStatus: 'STAGE_PLACED', stageDeadline: past },
  });

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');

    // Cohorts: 2 interns, 1 on the tenant's finished stage → 1 hired, 50%.
    await gotoSettled(page, '/admin/cohorts');
    const row = page.getByTestId(`cohort-row-${cohort.id}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('td').nth(2)).toHaveText('2');
    await expect(row.locator('td').nth(3)).toHaveText('1');
    await expect(row.locator('td').nth(4)).toHaveText('50%');

    // Candidate page: the open stage's passed deadline is flagged, the placed one is not.
    await gotoSettled(page, `/admin/candidates/${a.id}`);
    await expect(page.getByText('past the stage deadline')).toBeVisible({ timeout: 20_000 });
    await gotoSettled(page, `/admin/candidates/${b.id}`);
    await expect(page.getByText('Already Placed').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('past the stage deadline')).toHaveCount(0);

    // The mentee's own journey tracker speaks the tenant's stage names.
    await signInAsFreshUser(page, menteeA, 'MenteePass123', '/portal');
    await gotoSettled(page, '/portal/journey');
    await expect(page.getByText('Working together').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('STAGE_WORK')).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [open.id, done.id] } } });
    await prisma.cohort.deleteMany({ where: { id: cohort.id } });
    for (const email of [menteeA, menteeB, mentorEmail, adminEmail]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
