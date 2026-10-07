import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { TRIAL_ACTIVE_STAGE_KEY, defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Product usage (#2448, #2449), from seeded CompanyUsage rows:
//   1. the rep's attention queue shows `usage_drop` and `trial_inactive`, and
//      its footnote counts the account with too short a history and the
//      dropping account nobody owns;
//   2. the account page charts 90 days, with a zero day and a no-data day
//      drawn differently.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;
const PW = 'UsageSignals123';
const utcDay = (offsetDays: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - offsetDays * DAY);
};

test('usage drop, inactive trial, footnotes and the account chart', async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `Usage ${stamp}`, slug: `usage-${stamp}`, vertical: 'MARKETING' } });
  const preset = defaultTemplateForVertical('MARKETING')!;
  const stages = templateStagePayload(preset).stages;
  await prisma.pipelineStage.createMany({ data: stages.map((s) => ({ ...s, orgId: org.id })) });
  const workingStage = stages.find((s) => s.key !== TRIAL_ACTIVE_STAGE_KEY && !s.isTerminal && !s.isOffPath)!.key;

  const emails = ['admin', 'rep', 'lead1', 'lead2', 'lead3'].map((k) => uniqueEmail(`usage-${k}`));
  const [adminEmail, repEmail] = emails;
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Usage Admin');
  const rep = await seedUser(repEmail, PW, 'MENTOR', 'Usage Rep');
  const leads = await Promise.all([
    seedUser(emails[2], PW, 'MENTEE', `Dropping Lead ${stamp}`),
    seedUser(emails[3], PW, 'MENTEE', `Idle Trial Lead ${stamp}`),
    seedUser(emails[4], PW, 'MENTEE', `New Lead ${stamp}`),
  ]);
  await prisma.user.updateMany({ where: { id: { in: [admin.id, rep.id, ...leads.map((l) => l.id)] } }, data: { orgId: org.id } });

  const mk = (name: string) => prisma.company.create({ data: { orgId: org.id, name: `${name} ${stamp}` } });
  const [dropping, trial, fresh, unowned] = await Promise.all([mk('Dropping'), mk('Trial'), mk('Fresh'), mk('Unowned')]);

  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: rep.id, menteeId: leads[0].id, companyId: dropping.id, pipelineStatus: workingStage } });
  await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id, mentorId: rep.id, menteeId: leads[1].id, companyId: trial.id, pipelineStatus: TRIAL_ACTIVE_STAGE_KEY,
      trialStartedAt: new Date(Date.now() - 10 * DAY), trialEndsAt: new Date(Date.now() + 20 * DAY),
    },
  });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: rep.id, menteeId: leads[2].id, companyId: fresh.id, pipelineStatus: workingStage } });

  // 70 days back: 10 a day for the earlier half, 2 a day for the last 30 —
  // with yesterday a recorded 0 and days 71..89 never delivered.
  const rows: { orgId: string; companyId: string; date: Date; transactions: number }[] = [];
  for (const c of [dropping, unowned]) {
    for (let d = 0; d <= 70; d++) rows.push({ orgId: org.id, companyId: c.id, date: utcDay(d), transactions: d === 1 ? 0 : d < 30 ? 2 : 10 });
  }
  for (let d = 0; d < 10; d++) rows.push({ orgId: org.id, companyId: fresh.id, date: utcDay(d), transactions: 5 });
  await prisma.companyUsage.createMany({ data: rows });

  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, repEmail, PW, '/sales');
    const queue = page.getByTestId('attention-queue');
    await expect(queue).toBeVisible({ timeout: 30_000 });
    const dropItem = queue.locator('a', { hasText: `Dropping Lead ${stamp}` });
    await expect(dropItem).toContainText('Usage dropped');
    await expect(queue.locator('a', { hasText: `Idle Trial Lead ${stamp}` })).toContainText('Trial not used yet');
    await expect(queue.locator('a', { hasText: `New Lead ${stamp}` })).toHaveCount(0);
    await expect(page.getByTestId('attention-usage-no-history')).toContainText('1');
    await expect(page.getByTestId('attention-usage-unowned')).toContainText('1');
    await expect(page.getByTestId('attention-usage-no-feed')).toHaveCount(0);
    // Signals only show: nothing moved.
    expect((await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: dropping.id } })).pipelineStatus).toBe(workingStage);

    await page.context().clearCookies();
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await gotoSettled(page, `/admin/companies/${dropping.id}`);
    const card = page.getByTestId('company-usage-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('usage-bar-89')).toHaveAttribute('data-state', 'value');
    await expect(card.getByTestId('usage-bar-88')).toHaveAttribute('data-state', 'zero');
    await expect(card.getByTestId('usage-bar-0')).toHaveAttribute('data-state', 'nodata');
    await expect(card.getByTestId('usage-summary')).toContainText('71 of 90 days');
    // An account with no usage at all draws no chart.
    await gotoSettled(page, `/admin/companies/${trial.id}`);
    await expect(page.getByTestId('company-detail-name')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('company-usage-card')).toHaveCount(0);
  } finally {
    await prisma.companyUsage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.setting.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { targetId: { in: [dropping.id, trial.id] } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
