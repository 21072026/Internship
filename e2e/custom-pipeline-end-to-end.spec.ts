import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Story #1632 — "a custom pipeline that survives the demo", driven end to end
// in one pass. Each child task has its own spec (#1634 relation-start-stage,
// #1635 stage-editor-add-remove, #1637 stage-phases-bulk-advance); this one
// chains them the way a demo does, so a regression in the hand-off between them
// (a stage set the board cannot place, a start stage the advance cannot walk
// from) fails the PR gate rather than the scheduled run.
//
//   define a fully custom set (with phases)  →  create a relation, no stage given
//   →  it lands on the set's first on-path stage, in the phase the admin chose
//   →  bulk advance walks the TENANT's order, stepping over the off-path stage
test('a fully custom stage set: define it, start a relation on it, see its phases, bulk advance along it', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const stamp = Date.now();
  // The editor is premium (the PUT 403s on FREE); everything after it is free core.
  const org = await prisma.organization.create({ data: { name: `Custom E2E ${stamp}`, slug: `custom-e2e-${stamp}`, plan: 'ENTERPRISE' } });
  const adminEmail = uniqueEmail('custom-e2e-admin');
  const mentorEmail = uniqueEmail('custom-e2e-mentor');
  const menteeEmail = uniqueEmail('custom-e2e-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Custom E2E Admin', org.id);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Custom E2E Mentor', org.id);
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Custom E2E Mentee', org.id);

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');

    // 1. The set, through the same write the editor saves with. None of these
    //    keys is canonical; the off-path stage sits between the two on-path ones.
    const put = await page.request.put(`/api/admin/organizations/${org.id}/pipeline-stages`, {
      data: {
        stages: [
          { key: 'CX_SOURCED', label: 'Sourced', order: 0, phase: 'pre' },
          { key: 'CX_WITHDREW', label: 'Withdrew', order: 1, isOffPath: true, isTerminal: true },
          { key: 'CX_WORKING', label: 'Working together', order: 2, phase: 'internship' },
          { key: 'CX_PLACED', label: 'Placed', order: 3, isTerminal: true, phase: 'result' },
        ],
      },
    });
    expect(put.ok()).toBeTruthy();

    // 2. A relation created with no stage at all starts on the set's first
    //    on-path stage — not the schema default, which this org does not have.
    const created = await page.request.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: mentee.id } });
    expect(created.status()).toBe(201);
    const relation = await prisma.mentorshipRelation.findFirstOrThrow({
      where: { mentorId: mentor.id, menteeId: mentee.id },
      select: { id: true, pipelineStatus: true },
    });
    expect(relation.pipelineStatus).toBe('CX_SOURCED');

    // 3. The board places each stage in the phase its admin chose, and the card
    //    is in the first column of the "pre" phase.
    await gotoSettled(page, '/admin/board');
    const pre = page.getByTestId('board-scroll-pre');
    await expect(pre.getByTestId('board-column-CX_SOURCED').getByText('Custom E2E Mentee', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('board-scroll-internship').getByTestId('board-column-CX_WORKING')).toBeVisible();
    await expect(page.getByTestId('board-scroll-result').getByTestId('board-column-CX_PLACED')).toBeVisible();
    // A stage given no phase (the off-path one here) is what still falls into
    // the trailing "custom" group — never one whose admin picked a phase.
    const custom = page.getByTestId('board-scroll-custom');
    await expect(custom.getByTestId('board-column-CX_WITHDREW')).toBeVisible();
    for (const key of ['CX_SOURCED', 'CX_WORKING', 'CX_PLACED']) {
      await expect(custom.getByTestId(`board-column-${key}`)).toHaveCount(0);
    }

    // 4. Bulk advance walks the tenant's on-path order: Sourced → Working
    //    together, stepping over the off-path stage in between.
    const bulk = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [mentee.id], action: 'advanceStage' },
    });
    expect(bulk.ok()).toBeTruthy();
    expect(await bulk.json()).toMatchObject({ advanced: 1, skipped: 0 });
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe('CX_WORKING');

    await gotoSettled(page, '/admin/board');
    await expect(
      page.getByTestId('board-scroll-internship').getByTestId('board-column-CX_WORKING').getByText('Custom E2E Mentee', { exact: true })
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await prisma.statusChange.deleteMany({ where: { relation: { orgId: org.id } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    for (const email of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
