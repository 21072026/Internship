import { test, expect, type Browser, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultOrgId } from '../src/lib/defaultOrg';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import {
  TRIAL_ACTIVE_STAGE_KEY,
  TRIAL_EXPIRED_STAGE_KEY,
  defaultTemplateForVertical,
  templateStagePayload,
} from '../src/lib/programTemplates';

// Setting and extending a trial end by hand (#2553, story #2392).
//
// The rule is unit-tested (scripts/test/trial-end-change.test.mjs). What only a
// real round trip shows:
//
//   1. PATCH /api/mentorship/[id]/trial moves the date, and an EXPIRED trial
//      extended into the future is back in TRIAL_ACTIVE with a StatusChange
//      written by the person who did it, plus the `trial.end_changed` audit row;
//   2. the claim rows survive the extension, so the reminder job then sends the
//      mark the new window still has ahead of it (3 days) and NOT a mark it
//      already sent (7 days) — the issue's acceptance criterion;
//   3. only the owner and a tenant ADMIN may write it: another owner of the same
//      tenant and the lead on the record get 403, an anonymous caller 401, and
//      an ADMIN of another tenant 404 — the id does not exist for them (#2542);
//   4. an undated running trial shows the "date missing" badge on the board and
//      on the record, and the badge goes once the date is entered there.

test.describe.configure({ mode: 'serial' });

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'TrialEnd123!';
const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const platformAdminEmail = uniqueEmail(`trialend-platform-${STAMP}`);
const adminEmail = uniqueEmail(`trialend-admin-${STAMP}`);
const ownerEmail = uniqueEmail(`trialend-owner-${STAMP}`);
const otherOwnerEmail = uniqueEmail(`trialend-other-${STAMP}`);
const leadEmail = uniqueEmail(`trialend-lead-${STAMP}`);
const undatedLeadEmail = uniqueEmail(`trialend-undated-${STAMP}`);
const foreignAdminEmail = uniqueEmail(`trialend-foreign-${STAMP}`);
const emails = [platformAdminEmail, adminEmail, ownerEmail, otherOwnerEmail, leadEmail, undatedLeadEmail, foreignAdminEmail];

let orgId = '';
let relationId = '';
let undatedRelationId = '';
let undatedLeadId = '';
const undatedLeadName = `Undated Trial Lead ${STAMP}`;

/** A UTC calendar day `offset` days from today, as `YYYY-MM-DD` and at midday. */
function utcDay(offset: number) {
  const now = new Date();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, 12, 0));
  return { iso: at.toISOString().slice(0, 10), at };
}

async function signedIn(browser: Browser, email: string, landing: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (landing === '/admin') {
    await signInAndSettle(page, email, PASSWORD, landing);
    return page;
  }
  // MENTOR/MENTEE accounts of a MARKETING tenant have no mentorship shell
  // (#2351) and land on /account, which has no account-menu button to settle
  // on — only the session cookie matters to the API calls below.
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 30_000 });
  return page;
}

async function patchTrial(page: Page, id: string, trialEndsAt: string) {
  return page.request.patch(`/api/mentorship/${id}/trial`, { data: { trialEndsAt } });
}

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Trial End ${STAMP}`, slug: `trial-end-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })),
  });

  // The cron endpoint is the operator's trigger — a platform admin, no org.
  await seedUser(platformAdminEmail, PASSWORD, 'ADMIN', 'Trial End Platform Admin');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Trial End Admin');
  const owner = await seedUser(ownerEmail, PASSWORD, 'MENTOR', 'Trial End Owner');
  const other = await seedUser(otherOwnerEmail, PASSWORD, 'MENTOR', 'Other Owner');
  const lead = await seedUser(leadEmail, PASSWORD, 'MENTEE', 'Trial End Lead');
  const undatedLead = await seedUser(undatedLeadEmail, PASSWORD, 'MENTEE', undatedLeadName);
  undatedLeadId = undatedLead.id;
  // An ADMIN of the default (INTERNSHIP) tenant: a real admin, of the wrong tenant.
  const foreignAdmin = await seedUser(foreignAdminEmail, PASSWORD, 'ADMIN', 'Trial End Foreign Admin');
  await prisma.user.update({ where: { id: foreignAdmin.id }, data: { orgId: await defaultOrgId() } });
  await prisma.user.updateMany({
    where: { id: { in: [admin.id, owner.id, other.id, lead.id, undatedLead.id] } },
    data: { orgId: org.id },
  });

  const company = await prisma.company.create({ data: { orgId: org.id, name: `Trial End Account ${STAMP}` } });

  // A trial that ran out two days ago and was parked in TRIAL_EXPIRED. Its
  // 7-day and 0-day mails went out (the 3-day tick was missed) — so the claim
  // rows for 7 and 0 exist.
  const ended = utcDay(-2).at;
  const relation = await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id,
      mentorId: owner.id,
      menteeId: lead.id,
      companyId: company.id,
      pipelineStatus: TRIAL_EXPIRED_STAGE_KEY,
      trialStartedAt: new Date(ended.getTime() - 30 * DAY),
      trialEndsAt: ended,
    },
  });
  relationId = relation.id;
  await prisma.trialReminder.createMany({
    data: [
      { orgId: org.id, relationId: relation.id, threshold: 7, sentAt: new Date(ended.getTime() - 7 * DAY) },
      { orgId: org.id, relationId: relation.id, threshold: 0, sentAt: ended },
    ],
  });

  // A running trial nobody dated.
  const undated = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: owner.id, menteeId: undatedLead.id, pipelineStatus: TRIAL_ACTIVE_STAGE_KEY },
  });
  undatedRelationId = undated.id;
});

test.afterAll(async () => {
  if (orgId) {
    const ids = [relationId, undatedRelationId].filter(Boolean);
    await prisma.activityLog.deleteMany({ where: { targetId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } }).catch(() => {});
    await prisma.trialReminder.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  }
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } }).catch(() => null);
    if (user) await prisma.notification.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await cleanupByEmail(email);
  }
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('extending a trial reopens it, keeps the claims, and the job sends only the mark still ahead', async ({ browser }) => {
  test.slow();
  const admin = await signedIn(browser, adminEmail, '/admin');
  const operator = await signedIn(browser, platformAdminEmail, '/admin');
  const cron = `/api/cron?job=trial-reminders&orgId=${orgId}`;

  // A past day is not an extension.
  const past = await patchTrial(admin, relationId, utcDay(-1).iso);
  expect(past.status()).toBe(400);
  expect((await past.json()).code).toBe('in_the_past');

  // Three days out: the record goes back to "trial running".
  const in3 = utcDay(3);
  const res = await patchTrial(admin, relationId, in3.iso);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ changed: true, reopened: true, relation: { pipelineStatus: TRIAL_ACTIVE_STAGE_KEY } });

  const reopened = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(reopened.pipelineStatus).toBe(TRIAL_ACTIVE_STAGE_KEY);
  expect(reopened.trialEndsAt?.toISOString().slice(0, 10)).toBe(in3.iso);

  // A human stage move, recorded as one.
  const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
  const moves = await prisma.statusChange.findMany({ where: { relationId } });
  expect(moves.map((m) => [m.fromStatus, m.toStatus, m.changedById])).toEqual([
    [TRIAL_EXPIRED_STAGE_KEY, TRIAL_ACTIVE_STAGE_KEY, adminUser.id],
  ]);
  const audit = await prisma.activityLog.findMany({ where: { action: 'trial.end_changed', targetId: relationId } });
  expect(audit.length).toBe(1);
  expect(audit[0].detail).toBe(`${utcDay(-2).iso} → ${in3.iso}`);

  // The claims were kept.
  const claimsAfterExtend = await prisma.trialReminder.findMany({ where: { relationId }, orderBy: { threshold: 'asc' } });
  expect(claimsAfterExtend.map((c) => c.threshold)).toEqual([0, 7]);

  // The job now sends the 3-day mark — the one the new window has ahead of it.
  const first = await operator.request.get(cron);
  expect(first.ok()).toBeTruthy();
  expect((await first.json()).trialReminders).toMatchObject({ considered: 1, sent: 1, failed: 0, expired: 0 });
  const claimsAfterRun = await prisma.trialReminder.findMany({ where: { relationId }, orderBy: { threshold: 'asc' } });
  expect(claimsAfterRun.map((c) => c.threshold)).toEqual([0, 3, 7]);

  // The OWNER extends it again, to seven days out. The 7-day mark was mailed in
  // the old window, so the job must stay silent about it.
  const owner = await signedIn(browser, ownerEmail, '/account');
  const in7 = utcDay(7);
  const byOwner = await patchTrial(owner, relationId, in7.iso);
  expect(byOwner.status()).toBe(200);
  expect(await byOwner.json()).toMatchObject({ changed: true, reopened: false });

  const second = await operator.request.get(cron);
  expect(second.ok()).toBeTruthy();
  expect((await second.json()).trialReminders).toMatchObject({ considered: 0, sent: 0 });
  expect(await prisma.trialReminder.count({ where: { relationId } })).toBe(3);
  const ownerUser = await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } });
  expect(await prisma.notification.count({ where: { userId: ownerUser.id, type: 'trial.endingSoon' } })).toBe(1);

  // The same day again is a no-op, not a second audit row.
  const same = await patchTrial(owner, relationId, in7.iso);
  expect(await same.json()).toMatchObject({ changed: false });
  expect(await prisma.activityLog.count({ where: { action: 'trial.end_changed', targetId: relationId } })).toBe(2);
});

test('only the owner and a tenant admin may set it', async ({ browser, playwright }) => {
  const target = utcDay(20).iso;

  const other = await signedIn(browser, otherOwnerEmail, '/account');
  expect((await patchTrial(other, relationId, target)).status()).toBe(403);

  const lead = await signedIn(browser, leadEmail, '/account');
  expect((await patchTrial(lead, relationId, target)).status()).toBe(403);

  const anonymous = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  const anon = await anonymous.patch(`/api/mentorship/${relationId}/trial`, { data: { trialEndsAt: target } });
  expect(anon.status()).toBe(401);
  await anonymous.dispose();

  // An admin of ANOTHER tenant does not get a 403 — the record is not theirs to
  // know about, so it reads as not found (#2542, tenantWhere/withinTenant).
  const foreign = await signedIn(browser, foreignAdminEmail, '/admin');
  expect((await patchTrial(foreign, relationId, target)).status()).toBe(404);

  // Nothing moved.
  const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(row.trialEndsAt?.toISOString().slice(0, 10)).toBe(utcDay(7).iso);
});

test('an undated running trial is flagged on the board and the record until a date is entered', async ({ page }) => {
  test.slow();
  await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

  await gotoSettled(page, '/admin/board');
  const card = page.getByTestId('board-card').filter({ hasText: undatedLeadName });
  await expect(card.getByTestId('trial-end-missing')).toBeVisible({ timeout: 15_000 });

  await gotoSettled(page, `/admin/candidates/${undatedLeadId}`);
  const panel = page.getByTestId('trial-end-panel');
  await expect(panel.getByTestId('trial-end-missing')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId('trial-end-missing-hint')).toBeVisible();

  const in10 = utcDay(10).iso;
  await panel.getByTestId('trial-end-input').fill(in10);
  await panel.getByTestId('trial-end-save').click();

  await expect(panel.getByTestId('trial-end-missing')).toHaveCount(0, { timeout: 10_000 });
  await expect(panel.getByTestId('trial-end-status')).toHaveText(/10/);
  const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: undatedRelationId } });
  expect(row.trialEndsAt?.toISOString().slice(0, 10)).toBe(in10);
  expect(row.pipelineStatus).toBe(TRIAL_ACTIVE_STAGE_KEY);
});
