import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1637 — bulk advance on a FULLY custom pipeline. It used to walk the
// canonical constant, which knows none of these keys, so every row was skipped
// while the response still looked like success. Now it walks the org's own
// on-path order, never targets an off-path stage, and reports what it skipped.
test('bulk advance moves along a fully custom order and reports skipped rows with a reason', async ({ page }) => {
  test.slow();
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: `Phases ${stamp}`, slug: `phases-${stamp}` } });
  await prisma.pipelineStage.createMany({
    data: [
      { orgId: org.id, key: 'P_INTAKE', label: 'Intake', order: 0, phase: 'pre' },
      { orgId: org.id, key: 'P_GONE', label: 'Withdrew', order: 1, isOffPath: true, isTerminal: true },
      { orgId: org.id, key: 'P_WORK', label: 'Working together', order: 2, phase: 'internship' },
      { orgId: org.id, key: 'P_PLACED', label: 'Placed', order: 3, isTerminal: true, phase: 'result' },
    ],
  });
  const adminEmail = uniqueEmail('phases-admin');
  const mentorEmail = uniqueEmail('phases-mentor');
  const emails = ['a', 'b', 'c', 'd'].map((x) => uniqueEmail(`phases-mentee-${x}`));
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Phases Admin', org.id);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Phases Mentor', org.id);
  const [a, b, c, d] = await Promise.all(emails.map((e, i) => seedUser(e, 'x', 'MENTEE', `Phases Mentee ${i}`, org.id)));
  const rel = (menteeId: string, pipelineStatus: string) =>
    prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId, orgId: org.id, status: 'ACTIVE', pipelineStatus } });
  const ra = await rel(a.id, 'P_INTAKE');
  const rb = await rel(b.id, 'P_PLACED');
  const rc = await rel(c.id, 'P_GONE');
  // d has no active relation at all.

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    const res = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [a.id, b.id, c.id, d.id], action: 'advanceStage' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({
      advanced: 1,
      updated: 1,
      skipped: 3,
      reasons: { final_stage: 1, off_path: 1, no_active_relation: 1 },
    });

    // Intake → Working together: the off-path stage in between is skipped over.
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: ra.id } })).pipelineStatus).toBe('P_WORK');
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rb.id } })).pipelineStatus).toBe('P_PLACED');
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rc.id } })).pipelineStatus).toBe('P_GONE');
    // Through the shared stage write path: one history row, one activity line.
    expect(await prisma.statusChange.count({ where: { relationId: ra.id, fromStatus: 'P_INTAKE', toStatus: 'P_WORK' } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { action: 'pipeline.stage_change', targetId: ra.id } })).toBe(1);

    // The stage read the editor prefills from carries the phase.
    const stages = (await (await page.request.get(`/api/admin/organizations/${org.id}/pipeline-stages`)).json()).stages;
    expect(stages.find((s: { key: string }) => s.key === 'P_WORK').phase).toBe('internship');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [ra.id, rb.id, rc.id] } } });
    for (const email of [...emails, mentorEmail, adminEmail]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
