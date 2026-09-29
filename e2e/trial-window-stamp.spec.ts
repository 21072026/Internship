import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { findDueTrialReminders } from '../src/lib/trialReminders';
import {
  TRIAL_ACTIVE_STAGE_KEY,
  TRIAL_EXPIRED_STAGE_KEY,
  defaultTemplateForVertical,
  templateStagePayload,
} from '../src/lib/programTemplates';

// A board move into TRIAL_ACTIVE stamps the trial window (#2551).
//
// The rule is unit-tested (scripts/test/trial-reminder-rule.test.mjs) and the
// ratchet (scripts/test/trial-window-writers.test.mjs) holds every stage writer
// to it. What only a browser + database round trip can show is that the stamp
// actually lands through the path a person uses — the board's "Move to stage"
// select → PUT /api/mentorship/[id] — with the tenant's own trial length, that
// a second entry keeps the first window, and that the stamped record is then
// found by the reminder query on the right day.

// Serial: the second test changes the trial length (globally, on a
// single-tenant server), the first asserts the default.
test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'TrialStamp123!';

async function seedMarketingOrg(prefix: string) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const org = await prisma.organization.create({
    data: { name: `${prefix} ${stamp}`, slug: `${prefix}-${stamp}`, vertical: 'MARKETING' },
  });
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  const adminEmail = uniqueEmail(`${prefix}-admin`);
  const ownerEmail = uniqueEmail(`${prefix}-owner`);
  const leadEmail = uniqueEmail(`${prefix}-lead`);
  const leadName = `Trial Lead ${stamp}`;
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', `${prefix} Admin`);
  const owner = await seedUser(ownerEmail, PASSWORD, 'MENTOR', `${prefix} Owner`);
  const lead = await seedUser(leadEmail, PASSWORD, 'MENTEE', leadName);
  await prisma.user.updateMany({ where: { id: { in: [admin.id, owner.id, lead.id] } }, data: { orgId: org.id } });
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: owner.id, menteeId: lead.id, pipelineStatus: 'LEAD_QUALIFIED' },
  });
  return { org, relation, adminEmail, leadName, emails: [adminEmail, ownerEmail, leadEmail] };
}

async function cleanup(orgId: string, emails: string[]) {
  await prisma.trialReminder.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

async function moveOnBoard(page: Page, leadName: string, relationId: string, stage: string) {
  // The admin board lists every relation the tenant can see; scope to this
  // test's own card.
  const card = page.getByTestId('board-card').filter({ hasText: leadName });
  await card.getByLabel('Move to stage').selectOption(stage);
  await expect
    .poll(async () => (await prisma.mentorshipRelation.findUnique({ where: { id: relationId } }))?.pipelineStatus, {
      timeout: 10_000,
    })
    .toBe(stage);
}

test('a board move into TRIAL_ACTIVE stamps entry + 30 days; re-entry keeps the first window', async ({ page }) => {
  const seeded = await seedMarketingOrg('trial-stamp');
  try {
    // The org is MARKETING: its admin has a session on the marketing host only (#2590).
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/board');
    await expect(page.getByTestId('board-card').filter({ hasText: seeded.leadName })).toBeVisible({ timeout: 15_000 });

    const before = Date.now();
    await moveOnBoard(page, seeded.leadName, seeded.relation.id, TRIAL_ACTIVE_STAGE_KEY);
    const after = Date.now();

    const stamped = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relation.id } });
    expect(stamped.trialStartedAt).not.toBeNull();
    expect(stamped.trialEndsAt).not.toBeNull();
    const start = stamped.trialStartedAt!.getTime();
    // MySQL DATETIME(3) keeps milliseconds; allow a second either side for the
    // server clock vs. this process's clock.
    expect(start).toBeGreaterThanOrEqual(before - 1000);
    expect(start).toBeLessThanOrEqual(after + 1000);
    expect(stamped.trialEndsAt!.getTime() - start).toBe(30 * DAY);

    // Out of the stage and back in: the first window stands. A board drag must
    // not be able to extend a trial agreed with the customer.
    await moveOnBoard(page, seeded.leadName, seeded.relation.id, TRIAL_EXPIRED_STAGE_KEY);
    await moveOnBoard(page, seeded.leadName, seeded.relation.id, TRIAL_ACTIVE_STAGE_KEY);
    const reentered = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relation.id } });
    expect(reentered.trialStartedAt?.getTime()).toBe(stamped.trialStartedAt!.getTime());
    expect(reentered.trialEndsAt?.getTime()).toBe(stamped.trialEndsAt!.getTime());

    // And the stamped record is what the reminder ladder finds: seven calendar
    // days before its end, it is due for the seven-day mail.
    const tick = new Date(stamped.trialEndsAt!.getTime() - 7 * DAY);
    const due = await findDueTrialReminders(seeded.org.id, { now: tick });
    expect(due.map((d) => [d.relationId, d.threshold])).toEqual([[seeded.relation.id, 7]]);
  } finally {
    await cleanup(seeded.org.id, seeded.emails);
  }
});

test('the trial length comes from the org setting on /admin/settings', async ({ page }) => {
  const seeded = await seedMarketingOrg('trial-len');
  try {
    // The org is MARKETING: its admin has a session on the marketing host only (#2590).
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/settings');
    const field = page.getByTestId('trial-length-days');
    await expect(field).toHaveValue('30', { timeout: 15_000 });
    await field.fill('14');
    await field.press('Enter');
    // The layer written is the one the session binds: the tenant's own row with
    // isolation enforced, the global row on a single-tenant test server (see
    // src/lib/settings.ts). Either way it is the value this org resolves.
    await expect
      .poll(
        async () =>
          (
            await prisma.setting.findFirst({
              where: { key: 'trialLengthDays', OR: [{ orgId: seeded.org.id }, { orgId: null }] },
              orderBy: { orgId: 'desc' },
            })
          )?.value,
        { timeout: 10_000 },
      )
      .toBe('14');

    await gotoSettled(page, '/admin/board');
    await expect(page.getByTestId('board-card').filter({ hasText: seeded.leadName })).toBeVisible({ timeout: 15_000 });
    await moveOnBoard(page, seeded.leadName, seeded.relation.id, TRIAL_ACTIVE_STAGE_KEY);
    const stamped = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relation.id } });
    expect(stamped.trialEndsAt!.getTime() - stamped.trialStartedAt!.getTime()).toBe(14 * DAY);
  } finally {
    // Restore the code default for everyone else: on a single-tenant server
    // the save above wrote the GLOBAL row.
    await prisma.setting.deleteMany({ where: { key: 'trialLengthDays', orgId: null } }).catch(() => {});
    await cleanup(seeded.org.id, seeded.emails);
  }
});
