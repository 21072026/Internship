import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { seedCustomPipelineOrg, cleanupCustomPipelineOrg } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// /admin/automations end to end (#1704 on #1703's engine): an admin creates a
// rule, dry-runs it against real stage history — which acts on nobody — switches
// it on, a relation moves into the stage, the job worker runs the rule and the
// run log shows what it did.

const PASSWORD = 'AutomationPass123!';
let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;

test.beforeAll(async () => {
  seeded = await seedCustomPipelineOrg('automation', PASSWORD);
  // A past move INTO the rule's stage, so the dry run has something to find.
  await prisma.statusChange.create({
    data: { relationId: seeded.relationId, fromStatus: 'STAGE_A', toStatus: 'STAGE_B', createdAt: new Date(Date.now() - 20 * 86_400_000) },
  });
});

test.afterAll(async () => {
  await prisma.automationRule.deleteMany({ where: { orgId: seeded.org.id } });
  await prisma.notification.deleteMany({ where: { user: { orgId: seeded.org.id } } });
  await prisma.domainEvent.deleteMany({ where: { orgId: seeded.org.id } });
  await prisma.activityLog.deleteMany({ where: { orgId: seeded.org.id } });
  await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  await prisma.$disconnect();
});

test('create → dry run (acts on nobody) → switch on → stage move → run log', async ({ page }) => {
  test.setTimeout(120_000);
  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId }, select: { mentorId: true } });
  const mentorNotifications = () => prisma.notification.count({ where: { userId: relation.mentorId, type: 'automation.stageReached' } });

  await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');
  await gotoSettled(page, '/admin/automations');

  // Create: enter "Custom B" → notify the mentor (the default first step).
  await page.getByTestId('automation-new').click();
  const editor = page.getByTestId('automation-editor');
  await editor.getByTestId('automation-name').fill('Interview prep');
  // The tenant's own stages, custom labels included.
  await expect(editor.getByTestId('automation-stage').locator('option', { hasText: 'Custom B' })).toHaveCount(1);
  await editor.getByTestId('automation-stage').selectOption('STAGE_B');
  await editor.getByTestId('automation-save').click();

  const list = page.getByTestId('automation-rule-list');
  await expect(list.getByText('Interview prep', { exact: true })).toBeVisible();
  const rule = await prisma.automationRule.findFirstOrThrow({ where: { orgId: seeded.org.id } });
  expect(rule).toMatchObject({ enabled: false, stageKey: 'STAGE_B', trigger: 'STAGE_ENTRY' });

  // Not dry-run yet: the switch is off-limits and the server agrees.
  await expect(page.getByTestId(`automation-warning-${rule.id}`)).toBeVisible();
  await expect(page.getByTestId(`automation-toggle-${rule.id}`)).toBeDisabled();
  const early = await page.request.patch(`/api/admin/automations/${rule.id}`, { data: { enabled: true } });
  expect(early.status()).toBe(409);
  expect((await early.json()).code).toBe('simulate_first');

  // Dry run: the past A → B move would have fired — and nothing happened.
  await page.getByTestId(`automation-simulate-${rule.id}`).click();
  const output = page.getByTestId('automation-simulate-output');
  await expect(output.getByTestId('automation-simulate-summary')).toContainText('1 would have fired');
  await expect(output.getByText('automation Mentee')).toBeVisible();
  expect(await prisma.automationRun.count({ where: { ruleId: rule.id } })).toBe(0);
  expect(await mentorNotifications()).toBe(0);

  // Switch on.
  await page.getByTestId(`automation-toggle-${rule.id}`).click();
  await expect(page.getByTestId(`automation-state-${rule.id}`)).toHaveText('On');

  // The relation (parked in Custom F) moves into Custom B.
  const moved = await page.request.post('/api/status-changes', { data: { relationId: seeded.relationId, fromStatus: 'STAGE_F', toStatus: 'STAGE_B' } });
  expect(moved.status()).toBe(201);

  // The worker delivers the event (5 s tick) and the rule runs once.
  await expect.poll(async () => (await prisma.automationRun.findFirst({ where: { ruleId: rule.id } }))?.status ?? null, { timeout: 60_000, intervals: [1000] }).toBe('SUCCESS');
  expect(await mentorNotifications()).toBe(1);

  // The run log shows it, per step.
  await page.getByTestId('automation-tab-runs').click();
  const log = page.getByTestId('automation-run-log');
  await expect(log.getByTestId('automation-run-status').first()).toHaveText('Done');
  await expect(log.locator('li').getByText('Interview prep', { exact: true })).toBeVisible();
  await expect(log.getByText(/Notify — done/)).toBeVisible();
});

test("another org's rule is not listable, editable or simulatable", async ({ page }) => {
  const other = await prisma.organization.create({ data: { name: 'Other automation org', slug: `other-automation-${Date.now()}` } });
  try {
    const foreign = await prisma.automationRule.create({
      data: { orgId: other.id, name: 'Foreign', trigger: 'STAGE_ENTRY', stageKey: 'STAGE_B', conditions: [], actions: [{ type: 'notifyRole', role: 'mentor' }] },
    });
    await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');
    const listed = await (await page.request.get('/api/admin/automations')).json();
    expect((listed.rules as { id: string }[]).map((r) => r.id)).not.toContain(foreign.id);
    expect((await page.request.patch(`/api/admin/automations/${foreign.id}`, { data: { name: 'x' } })).status()).toBe(404);
    expect((await page.request.post(`/api/admin/automations/${foreign.id}/simulate`, { data: {} })).status()).toBe(404);
    expect((await page.request.delete(`/api/admin/automations/${foreign.id}`)).status()).toBe(404);
    // And an unknown action is refused at write time.
    const bad = await page.request.post('/api/admin/automations', {
      data: { name: 'Bad', trigger: 'STAGE_ENTRY', stageKey: 'STAGE_B', actions: [{ type: 'callUrl', url: 'https://evil.example' }] },
    });
    expect(bad.status()).toBe(400);
  } finally {
    await prisma.automationRule.deleteMany({ where: { orgId: other.id } });
    await prisma.organization.delete({ where: { id: other.id } });
  }
});
