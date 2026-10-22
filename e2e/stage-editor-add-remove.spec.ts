import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1635 — the stage editor builds a custom set from the UI: add a stage (its
// key derived once from the label), remove an unused one, and never drop a
// stage records still sit on — the UI disables it AND a crafted PUT gets 409.
test('add a stage from the editor; an in-use stage cannot be removed through the UI or a crafted PUT', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: `Editor ${stamp}`, slug: `editor-${stamp}`, plan: 'ENTERPRISE' } });
  await prisma.pipelineStage.createMany({
    data: [
      { orgId: org.id, key: 'E_INTAKE', label: 'Intake', order: 0 },
      { orgId: org.id, key: 'E_SPARE', label: 'Spare', order: 1 },
      { orgId: org.id, key: 'E_DONE', label: 'Done', order: 2, isTerminal: true },
    ],
  });
  const adminEmail = uniqueEmail('editor-admin');
  const mentorEmail = uniqueEmail('editor-mentor');
  const menteeEmail = uniqueEmail('editor-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Editor Admin', org.id);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Editor Mentor', org.id);
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Editor Mentee', org.id);
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id, status: 'ACTIVE', pipelineStatus: 'E_INTAKE' },
  });

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');

    // A crafted PUT that drops the in-use stage is refused with the count.
    const crafted = await page.request.put(`/api/admin/organizations/${org.id}/pipeline-stages`, {
      data: { stages: [{ key: 'E_DONE', label: 'Done', order: 0, isTerminal: true }] },
    });
    expect(crafted.status()).toBe(409);
    expect(await crafted.json()).toMatchObject({ code: 'stage_in_use', inUse: { E_INTAKE: 1 } });
    expect(await prisma.pipelineStage.count({ where: { orgId: org.id } })).toBe(3);

    await gotoSettled(page, `/admin/organizations/${org.id}/pipeline`);
    // The in-use stage's remove control is disabled and says why.
    await expect(page.getByTestId('stage-remove-E_INTAKE')).toBeDisabled();
    await expect(page.getByTestId('stage-in-use-E_INTAKE')).toBeVisible();

    // Remove the unused one, add a new one and name it.
    await page.getByTestId('stage-remove-E_SPARE').click();
    await expect(page.getByTestId('stage-row-E_SPARE')).toHaveCount(0);
    await page.getByTestId('stage-add').click();
    await page.getByTestId('stage-label-NEW_STAGE').fill('Ready to place');
    await expect(page.getByTestId('stage-row-READY_TO_PLACE')).toBeVisible();
    await page.getByTestId('pipeline-stages-save').click();

    await expect(async () => {
      const keys = (await prisma.pipelineStage.findMany({ where: { orgId: org.id }, orderBy: { order: 'asc' } })).map((s) => s.key);
      expect(keys).toEqual(['E_INTAKE', 'E_DONE', 'READY_TO_PLACE']);
    }).toPass({ timeout: 10_000 });

    // A later label edit never rewrites the saved key.
    await page.getByTestId('stage-label-READY_TO_PLACE').fill('Ready for placement');
    await page.getByTestId('pipeline-stages-save').click();
    await expect(async () => {
      const row = await prisma.pipelineStage.findFirst({ where: { orgId: org.id, key: 'READY_TO_PLACE' } });
      expect(row?.label).toBe('Ready for placement');
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    for (const email of [menteeEmail, mentorEmail, adminEmail]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
