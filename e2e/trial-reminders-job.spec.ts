import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import {
  TRIAL_ACTIVE_STAGE_KEY,
  TRIAL_EXPIRED_STAGE_KEY,
  defaultTemplateForVertical,
  templateStagePayload,
} from '../src/lib/programTemplates';

// The `trial-reminders` job, end to end (#2416, story #2392).
//
// WHAT THIS PROVES, and only this:
//
//   1. the named job runs on its own through `GET /api/cron?job=trial-reminders`
//      and reports its counts;
//   2. running it TWICE writes exactly ONE `TrialReminder` row and the second
//      run reports `sent: 0` — the claim row is what makes the sweep safe to
//      re-trigger, and it is the story's own acceptance criterion;
//   3. a trial that has already run out is moved out of TRIAL_ACTIVE, once
//      (#2417).
//
// NOT re-asserted here: that the cron ENDPOINTS refuse an anonymous caller.
// `e2e/cron-start.spec.ts` owns that as a @smoke test and writing it twice would
// mean two places to update when the refusal changes.
//
// NO SMTP IS NEEDED and no new mail transport mode was added. `sendEmail`
// answers 'SKIPPED' when `SMTP_USER` is unset, per-send failures are caught
// inside the job, and everything asserted below is database state plus the JSON
// counts — exactly the shape `e2e/cron-jobs.spec.ts` established.

const DAY = 24 * 60 * 60 * 1000;
const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const adminEmail = uniqueEmail(`trialjob-admin-${STAMP}`);
const ownerEmail = uniqueEmail(`trialjob-owner-${STAMP}`);
const leadEmail = uniqueEmail(`trialjob-lead-${STAMP}`);
const staleLeadEmail = uniqueEmail(`trialjob-stale-${STAMP}`);
const emails = [adminEmail, ownerEmail, leadEmail, staleLeadEmail];

let orgId = '';

test.afterAll(async () => {
  if (orgId) {
    // The audit rows the sweep writes carry `actorId: 'system'`, so they are
    // found by the relation they are ABOUT — which means reading the relation
    // ids before the relations go.
    const relationIds = (
      await prisma.mentorshipRelation.findMany({ where: { orgId }, select: { id: true } }).catch(() => [])
    ).map((r) => r.id);
    if (relationIds.length) {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: relationIds } } }).catch(() => {});
    }
    await prisma.trialReminder.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  }
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } }).catch(() => null);
    if (!user) continue;
    await prisma.notification.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the trial-reminders job warns once, expires what has run out, and does nothing on a second run', async ({ page }) => {
  const org = await prisma.organization.create({
    data: { name: `Trial Job ${STAMP}`, slug: `trial-job-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;

  // The admin is a PLATFORM admin (no org): the cron endpoint is the operator's
  // trigger, not a tenant screen, and the sweep resolves its tenants itself.
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Trial Job Admin');
  const owner = await seedUser(ownerEmail, 'TrialPass123!', 'MENTOR', 'Trial Job Owner');
  const lead = await seedUser(leadEmail, 'TrialPass123!', 'MENTEE', 'Trial Job Lead');
  const staleLead = await seedUser(staleLeadEmail, 'TrialPass123!', 'MENTEE', 'Stale Trial Lead');
  for (const u of [owner, lead, staleLead]) {
    await prisma.user.update({ where: { id: u.id }, data: { orgId: org.id } });
  }

  // The tenant's own stage rows, from the shipped preset — the trial keys are
  // resolved through them, never written as literals at a query site.
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })),
  });

  const company = await prisma.company.create({
    data: { orgId: org.id, name: `Trial Job Account ${STAMP}` },
  });

  // EXACTLY seven calendar days out (UTC), at midday so no wall-clock hour can
  // push it across a day boundary between seeding and the tick.
  const today = new Date();
  const endsAt = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 7, 12, 0),
  );
  const relation = await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id,
      mentorId: owner.id,
      menteeId: lead.id,
      companyId: company.id,
      pipelineStatus: TRIAL_ACTIVE_STAGE_KEY,
      trialStartedAt: new Date(endsAt.getTime() - 30 * DAY),
      trialEndsAt: endsAt,
    },
  });

  // A trial that ran out days ago: nothing is due for it (the ladder is an
  // exact match, so a negative number of days equals no threshold — this is the
  // baseline guarantee, #2410), and the auto-advance must move it (#2417).
  const stale = await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id,
      mentorId: owner.id,
      menteeId: staleLead.id,
      pipelineStatus: TRIAL_ACTIVE_STAGE_KEY,
      trialEndsAt: new Date(Date.now() - 5 * DAY),
    },
  });

  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', adminEmail);
  await page.fill('input[type="password"]', 'AdminPass123');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

  // `orgId` narrows the sweep to the tenant this spec seeded, so the counts
  // below are exact rather than "at least".
  const url = `/api/cron?job=trial-reminders&orgId=${org.id}`;

  const first = await page.request.get(url);
  expect(first.ok()).toBeTruthy();
  const firstBody = (await first.json()).trialReminders;
  expect(firstBody).toMatchObject({ considered: 1, sent: 1, skipped: 0, failed: 0, expired: 1, orgs: 1 });

  // ONE claim row, for the seven-day mark.
  const claims = await prisma.trialReminder.findMany({ where: { relationId: relation.id } });
  expect(claims.map((c) => c.threshold)).toEqual([7]);
  expect(claims[0].orgId).toBe(org.id);

  // The bell reached the account OWNER (the relation's mentorId), carrying the
  // account name rather than a rendered sentence.
  const bell = await prisma.notification.findMany({ where: { userId: owner.id, type: 'trial.endingSoon' } });
  expect(bell.length).toBe(1);
  expect((bell[0].params as { company?: string; days?: string }).company).toBe(company.name);
  expect((bell[0].params as { days?: string }).days).toBe('7');

  // The already-elapsed trial moved, and the live one did not.
  expect((await prisma.mentorshipRelation.findUnique({ where: { id: stale.id } }))!.pipelineStatus)
    .toBe(TRIAL_EXPIRED_STAGE_KEY);
  expect((await prisma.mentorshipRelation.findUnique({ where: { id: relation.id } }))!.pipelineStatus)
    .toBe(TRIAL_ACTIVE_STAGE_KEY);
  // …and the move left an audit row written by the system actor, because
  // StatusChange.changedById is a required FK to a real User.
  const audits = await prisma.auditLog.findMany({ where: { action: 'trial.expire', targetId: stale.id } });
  expect(audits.length).toBe(1);
  expect(audits[0].actorId).toBe('system');

  // SECOND RUN — the claim row is what makes this silent. Nothing new is
  // considered (the 7-day mark is spent), nothing is sent, and the expiry finds
  // nothing left to move.
  const second = await page.request.get(url);
  expect(second.ok()).toBeTruthy();
  const secondBody = (await second.json()).trialReminders;
  expect(secondBody).toMatchObject({ considered: 0, sent: 0, skipped: 0, failed: 0, expired: 0 });

  expect(await prisma.trialReminder.count({ where: { relationId: relation.id } })).toBe(1);
  expect(await prisma.notification.count({ where: { userId: owner.id, type: 'trial.endingSoon' } })).toBe(1);
  expect(await prisma.auditLog.count({ where: { action: 'trial.expire', targetId: stale.id } })).toBe(1);
});
