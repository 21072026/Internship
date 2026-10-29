import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi } from './helpers/auth';
import { runNudgeSend } from '@/lib/nudges/evaluate';

// /admin/nudges (#1686): an ADMIN creates a rule, dry-runs it (the count, a
// sample and the drop reasons — and NOTHING is sent: no EmailLog, no
// NudgeSend), switches it on (an ActivityLog row names the actor and the
// rule), and sees the send history once it has fired. A MENTOR calling the
// API directly gets 403 from the route; a stage-change trigger is refused.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('create → dry run → enable → history, with the route refusing a mentor', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `Nudges ${stamp}`, slug: `nudges-${stamp}` } });
  const emails = { admin: uniqueEmail('nudge-admin'), mentor: uniqueEmail('nudge-mentor'), active: uniqueEmail('nudge-active'), dormant: uniqueEmail('nudge-dormant') };
  const admin = await seedUser(emails.admin, 'NudgePass123', 'ADMIN', 'Nudge Admin', org.id);
  const mentor = await seedUser(emails.mentor, 'NudgePass123', 'MENTOR', 'Nudge Mentor', org.id);
  const active = await seedUser(emails.active, 'NudgePass123', 'MENTEE', 'Ada Active', org.id);
  const dormant = await seedUser(emails.dormant, 'NudgePass123', 'MENTEE', 'Dora Dormant', org.id);
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: active.id, pipelineStatus: 'INTERVIEW_PENDING_250' } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: dormant.id, pipelineStatus: 'INTERVIEW_PENDING_250', dormantSince: new Date() } });
  const mentorCtx = await playwright.request.newContext({ baseURL });
  try {
    // The route is the authorization, not the hidden nav item.
    expect((await signInViaApi(mentorCtx, emails.mentor, 'NudgePass123')).ok).toBe(true);
    expect((await mentorCtx.get('/api/admin/nudges')).status()).toBe(403);
    expect((await mentorCtx.post('/api/admin/nudges', { data: { name: 'x', trigger: { kind: 'scan' }, bodyEn: 'x' } })).status()).toBe(403);

    await signInAndSettle(page, emails.admin, 'NudgePass123', '/admin');

    // A stage-change trigger is refused at write time (that is /admin/automations).
    const stage = await page.request.post('/api/admin/nudges', {
      data: { name: 'Stage', trigger: { kind: 'event', event: 'pipeline.stage_change' }, subjectEn: 'a', bodyEn: 'b' },
    });
    expect(stage.status()).toBe(400);
    expect((await stage.json()).code).toBe('stage_trigger');

    // Create through the editor.
    await page.goto('/admin/nudges');
    await page.getByTestId('nudge-new').click();
    await page.getByTestId('nudge-name').fill('Interview check-in');
    await page.getByTestId('nudge-add-condition').click();
    await page.getByTestId('nudge-condition-0').locator('select').first().selectOption('stage');
    await page.getByTestId('nudge-condition-0').locator('select').nth(2).selectOption(['INTERVIEW_PENDING_250']);
    await page.getByTestId('nudge-subject-en').fill('How is it going, {name}?');
    await page.getByTestId('nudge-body-en').fill('Hi {name}, tell us how the interview prep is going.');
    // Only English written: the editor says so.
    await expect(page.getByTestId('nudge-missing-langs')).toBeVisible();
    await page.getByTestId('nudge-save').click();
    await page.waitForURL(/\/admin\/nudges\/[^/]+$/);
    const rule = await prisma.nudgeRule.findFirstOrThrow({ where: { orgId: org.id } });
    expect(rule.enabled).toBe(false);

    // Dry run: no role condition, so the active mentee AND the mentor of that
    // stage match; the dormant mentee is dropped by the guard — and nothing is sent.
    const emailLogsBefore = await prisma.emailLog.count({ where: { orgId: org.id } });
    await page.getByTestId('nudge-preview').click();
    await expect(page.getByTestId('nudge-preview-count')).toContainText('2');
    await expect(page.getByTestId('nudge-preview-sample')).toContainText('Ada Active');
    await expect(page.getByTestId('nudge-preview-sample')).toContainText('Nudge Mentor');
    await expect(page.getByTestId('nudge-preview-sample')).not.toContainText('Dora Dormant');
    await expect(page.getByTestId('nudge-drop-dormancy')).toContainText('1');
    expect(await prisma.nudgeSend.count({ where: { ruleId: rule.id } })).toBe(0);
    expect(await prisma.emailLog.count({ where: { orgId: org.id } })).toBe(emailLogsBefore);
    expect(await prisma.job.count({ where: { name: 'nudge.send', orgId: org.id } })).toBe(0);

    // Enable: audited.
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('nudge-toggle').click();
    await expect(page.getByTestId('nudge-status')).toHaveText(/On/);
    const log = await prisma.activityLog.findFirst({ where: { action: 'nudge.enabled', targetId: rule.id } });
    expect(log?.actorId).toBe(admin.id);

    // It fires (the send job, run directly), and the history shows the recipient.
    // In-app here: the spec process cannot load the mailer's lazy imports, and
    // the e-mail path is pinned in nudge-engine.spec.ts / by hand.
    await prisma.nudgeRule.update({ where: { id: rule.id }, data: { channel: 'IN_APP' } });
    expect(await runNudgeSend({ ruleId: rule.id, userId: active.id, dedupeKey: 'scan', eventId: null })).toBe('sent');
    await page.reload();
    await expect(page.getByTestId('nudge-history')).toContainText('Ada Active');
  } finally {
    await mentorCtx.dispose();
    await prisma.job.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.nudgeRule.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
