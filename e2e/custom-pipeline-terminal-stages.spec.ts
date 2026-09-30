import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
// Static import, not `await import()`: Playwright resolves the `@/…` alias only
// for the spec's static import graph (see e2e/erasure-free-text.spec.ts).
import { weeklyAnalyticsStats } from '../src/services/emailService';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1884: the deadline reminder, the calendar's overdue flag and the weekly
// report each decided "is this relation finished?" with the default keys
// (HIRED_660 / EMPLOYED_700 / INTERNSHIP_FOUND_ELSEWHERE_800). A tenant on its
// own stage catalogue has none of them, so a placed candidate stayed "overdue"
// forever and the report said 0% hired with raw keys in its table. All three
// now read the tenant's stages through the one stage-clock rule (#1724).
//
// The reminder job itself is deliberately not run here: it is installation-
// wide, and running it would mark other specs' overdue relations as reminded
// mid-run. It uses the same `isStageOverdue(…, stages)` the calendar does.
test('a renamed pipeline: its terminal stage is not overdue, and the weekly figures are its own (#1884)', async ({ page }) => {
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: `Custom Stages ${stamp}`, slug: `custom-stages-${stamp}` } });
  await prisma.pipelineStage.createMany({
    data: [
      { orgId: org.id, key: 'STAGE_INTAKE', label: 'Intake', order: 0 },
      { orgId: org.id, key: 'STAGE_WORK', label: 'Working together', order: 1 },
      { orgId: org.id, key: 'STAGE_PLACED', label: 'Placed at partner', order: 2, isTerminal: true },
    ],
  });
  const adminEmail = uniqueEmail('cstage-admin');
  const mentorEmail = uniqueEmail('cstage-mentor');
  const menteeA = uniqueEmail('cstage-mentee-a');
  const menteeB = uniqueEmail('cstage-mentee-b');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Custom Stage Admin', org.id);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Custom Stage Mentor', org.id);
  const a = await seedUser(menteeA, 'x', 'MENTEE', 'Still Working', org.id);
  const b = await seedUser(menteeB, 'x', 'MENTEE', 'Already Placed', org.id);
  const past = new Date('2020-01-01');
  const open = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: a.id, orgId: org.id, pipelineStatus: 'STAGE_WORK', stageDeadline: past },
  });
  const done = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: b.id, orgId: org.id, pipelineStatus: 'STAGE_PLACED', stageDeadline: past },
  });

  try {
    // Calendar: the open stage's passed deadline is overdue, the placed one is not.
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    const cal = await (await page.request.get('/api/calendar-events')).json();
    const byId = (id: string) => (cal.events as { id: string; overdue?: boolean }[]).find((e) => e.id === `deadline-${id}`);
    expect(byId(open.id)?.overdue).toBe(true);
    expect(byId(done.id)?.overdue).toBe(false);

    // Weekly report figures: this org's relations only, "hired" = its own
    // finished stage, and the table speaks its labels, not its keys.
    const stats = await weeklyAnalyticsStats(org.id, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    expect(stats.total).toBe(2);
    expect(stats.conversion).toBe(50);
    expect(stats.stageRows).toContain('Placed at partner');
    expect(stats.stageRows).toContain('Working together');
    expect(stats.stageRows).not.toContain('STAGE_PLACED');
    expect(stats.stageRows).not.toContain('HIRED_660');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [open.id, done.id] } } });
    for (const email of [menteeA, menteeB, mentorEmail, adminEmail]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
