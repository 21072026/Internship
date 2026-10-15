import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// A won customer's notice period (#2841):
//   1. the owner records the notice on the lead page; the record stays won and
//      shows `cancellation_pending` in their queue;
//   2. only a won record takes a date, never one in the past;
//   3. on the end day the daily sweep rings the owner once — and moves nothing;
//   4. withdrawing the notice clears it.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'ContractEnd123';

test('notice period: record, queue, end-day bell, withdraw', async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `Notice ${stamp}`, slug: `notice-${stamp}`, vertical: 'MARKETING' } });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  const emails = ['admin', 'rep', 'lead', 'lead2'].map((k) => uniqueEmail(`notice-${k}`));
  await seedUser(emails[0], PW, 'ADMIN', 'Notice Admin');
  const rep = await seedUser(emails[1], PW, 'MENTOR', 'Notice Rep');
  const lead = await seedUser(emails[2], PW, 'MENTEE', `Leaving Customer ${stamp}`);
  const lead2 = await seedUser(emails[3], PW, 'MENTEE', `Trial Lead ${stamp}`);
  await prisma.user.updateMany({ where: { id: { in: [rep.id, lead.id, lead2.id] } }, data: { orgId: org.id } });
  const company = await prisma.company.create({ data: { orgId: org.id, name: `Leaving GmbH ${stamp}` } });
  const won = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: rep.id, menteeId: lead.id, companyId: company.id, pipelineStatus: 'DEAL_WON' },
  });
  const trial = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: rep.id, menteeId: lead2.id, pipelineStatus: 'TRIAL_ACTIVE', trialEndsAt: new Date(Date.now() + 10 * 86_400_000) },
  });
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, emails[1], PW, '/sales');

    // 1. Record the notice from the lead page.
    await gotoSettled(page, `/sales/leads/${won.id}`);
    const panel = page.getByTestId('contract-end-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByTestId('contract-end-input').fill(future);
    await panel.getByTestId('contract-end-save').click();
    await expect(panel.getByTestId('contract-end-date')).toBeVisible({ timeout: 20_000 });
    const stored = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: won.id } });
    expect(stored.contractEndsAt?.toISOString().slice(0, 10)).toBe(future);
    expect(stored.pipelineStatus).toBe('DEAL_WON');

    await gotoSettled(page, '/sales');
    await expect(page.getByTestId('attention-queue').locator('a', { hasText: `Leaving Customer ${stamp}` })).toContainText('Notice given', { timeout: 20_000 });

    // 2. Only a won record, never a past day; another tenant's id is a 404 like any.
    expect((await page.request.patch(`/api/mentorship/${trial.id}/contract-end`, { data: { contractEndsAt: future } })).status()).toBe(409);
    const past = await page.request.patch(`/api/mentorship/${won.id}/contract-end`, { data: { contractEndsAt: '2020-01-01' } });
    expect(past.status()).toBe(400);
    expect((await past.json()).code).toBe('in_the_past');

    // 3. The end day: the sweep rings once and moves nothing.
    const today = new Date();
    await prisma.mentorshipRelation.update({
      where: { id: won.id },
      data: { contractEndsAt: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) },
    });
    await page.context().clearCookies();
    await page.context().setExtraHTTPHeaders({});
    // A PLATFORM admin (no org) is the operator who runs the named job — the
    // same shape as e2e/trial-reminders-job.spec.ts.
    await signInAndSettle(page, emails[0], PW, '/admin');
    const run = await page.request.get(`/api/cron?job=trial-reminders&orgId=${org.id}`);
    expect(run.ok()).toBeTruthy();
    expect((await run.json()).trialReminders).toMatchObject({ contractEnds: 1 });
    const again = await page.request.get(`/api/cron?job=trial-reminders&orgId=${org.id}`);
    expect((await again.json()).trialReminders).toMatchObject({ contractEnds: 0 });
    expect(await prisma.notification.count({ where: { userId: rep.id, type: 'contract.endsToday' } })).toBe(1);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: won.id } })).pipelineStatus).toBe('DEAL_WON');

    // 4. Withdrawn: the rep clears it.
    await page.context().clearCookies();
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, emails[1], PW, '/sales');
    const cleared = await page.request.patch(`/api/mentorship/${won.id}/contract-end`, { data: { contractEndsAt: null } });
    expect(cleared.ok()).toBeTruthy();
    const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: won.id } });
    expect(after.contractEndsAt).toBeNull();
    expect(after.contractEndRemindedAt).toBeNull();
  } finally {
    await prisma.notification.deleteMany({ where: { userId: rep.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { targetId: won.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
