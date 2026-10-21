import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The decision window (#2843, #2927): an expired trial's window closes
// trialEndsAt + the org's `decisionWindowDays` (30 by default). A week before,
// it shows in the owner's queue and the daily sweep rings them once — never a
// stage move.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'DecisionWin123';
const DAY = 86_400_000;

test('a closing decision window is in the queue and rings once', async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `Window ${stamp}`, slug: `window-${stamp}`, vertical: 'MARKETING' } });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  const emails = ['admin', 'rep', 'lead1', 'lead2'].map((k) => uniqueEmail(`window-${k}`));
  await seedUser(emails[0], PW, 'ADMIN', 'Window Admin', org.id);
  const rep = await seedUser(emails[1], PW, 'MENTOR', 'Window Rep');
  const closing = await seedUser(emails[2], PW, 'MENTEE', `Closing Window ${stamp}`);
  const fresh = await seedUser(emails[3], PW, 'MENTEE', `Fresh Window ${stamp}`);
  await prisma.user.updateMany({ where: { id: { in: [rep.id, closing.id, fresh.id] } }, data: { orgId: org.id } });
  const today = new Date();
  const utc = (offset: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - offset * DAY);
  const late = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: rep.id, menteeId: closing.id, pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: utc(25) },
  });
  await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: rep.id, menteeId: fresh.id, pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: utc(2) },
  });

  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, emails[1], PW, '/sales');
    await gotoSettled(page, '/sales');
    const queue = page.getByTestId('attention-queue');
    await expect(queue.locator('a', { hasText: `Closing Window ${stamp}` })).toContainText('Decision window closes', { timeout: 20_000 });
    await expect(queue.locator('a', { hasText: `Fresh Window ${stamp}` })).not.toContainText('Decision window closes');

    await page.context().clearCookies();
    // The org's own ADMIN on the org's own host runs its trial sweep: `orgId`
    // is honoured only for the caller's org or a super admin's (#1575).
    await signInAndSettle(page, emails[0], PW, '/admin');
    const first = await page.request.get(`/api/cron?job=trial-reminders&orgId=${org.id}`);
    expect((await first.json()).trialReminders).toMatchObject({ decisionWindows: 1 });
    const second = await page.request.get(`/api/cron?job=trial-reminders&orgId=${org.id}`);
    expect((await second.json()).trialReminders).toMatchObject({ decisionWindows: 0 });
    expect(await prisma.notification.count({ where: { userId: rep.id, type: 'trial.decisionWindowClosing' } })).toBe(1);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: late.id } })).pipelineStatus).toBe('TRIAL_EXPIRED');
  } finally {
    await prisma.notification.deleteMany({ where: { userId: rep.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});

test("the organization's own window length decides when it is closing", async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `Short Window ${stamp}`, slug: `short-window-${stamp}`, vertical: 'MARKETING' } });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  // A ten-day window: a trial that ended four days ago has six days left.
  await prisma.setting.create({ data: { orgId: org.id, key: 'decisionWindowDays', value: '10' } });
  const emails = ['admin', 'rep', 'lead'].map((k) => uniqueEmail(`short-window-${k}`));
  await seedUser(emails[0], PW, 'ADMIN', 'Short Window Admin', org.id);
  const rep = await seedUser(emails[1], PW, 'MENTOR', 'Short Window Rep');
  const lead = await seedUser(emails[2], PW, 'MENTEE', `Short Window Lead ${stamp}`);
  await prisma.user.updateMany({ where: { id: { in: [rep.id, lead.id] } }, data: { orgId: org.id } });
  const today = new Date();
  const ended = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 4 * DAY);
  await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: rep.id, menteeId: lead.id, pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: ended },
  });

  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, emails[1], PW, '/sales');
    await gotoSettled(page, '/sales');
    // With the default 30 days this record would have 26 days left and not show.
    await expect(
      page.getByTestId('attention-queue').locator('a', { hasText: `Short Window Lead ${stamp}` }),
    ).toContainText('Decision window closes', { timeout: 20_000 });

    await page.context().clearCookies();
    // The org's own ADMIN on the org's own host runs its trial sweep: `orgId`
    // is honoured only for the caller's org or a super admin's (#1575).
    await signInAndSettle(page, emails[0], PW, '/admin');
    const run = await page.request.get(`/api/cron?job=trial-reminders&orgId=${org.id}`);
    expect((await run.json()).trialReminders).toMatchObject({ decisionWindows: 1 });
  } finally {
    await prisma.notification.deleteMany({ where: { userId: rep.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.setting.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
