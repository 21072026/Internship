import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled } from './helpers/auth';
import { runRosterFeed } from '@/lib/rosterIngestStore';
import { hashFeedBytes } from '@/lib/rosterIngest';
import { rosterActor } from '@/lib/rosterDeprovisionRule';

// Roster-feed deprovisioning against the real database (#1966). The valves'
// arithmetic is pinned without a database in e2e/roster-deprovision.unit.spec.ts
// (the last-admin refusal among them: a feed only covers its org's mentees, so
// no database path here can put an admin in front of it); this spec pins what
// only the database can show:
//   - two runs on different days deactivate, one does not — and the person
//     deactivated cannot get back in, not even from a remembered browser;
//   - each abort leaves the roster exactly as it was;
//   - a feed reactivates only what a feed switched off, and never touches the
//     SSO break-glass account.

const PASSWORD = 'RosterDeprov123!';
const DAY = 24 * 60 * 60 * 1000;
const REMEMBER_COOKIES = ['internship.remember-token', '__Secure-internship.remember-token'];
const SESSION_COOKIES = ['next-auth.session-token', '__Secure-next-auth.session-token'];

test.afterAll(async () => {
  await prisma.$disconnect();
});

const fileOf = (emails: string[]) => `email,name\n${emails.map((e) => `${e},${e.split('@')[0]}`).join('\n')}\n`;
const transport = (text: string) => async () => ({
  text,
  fileHash: hashFeedBytes(text),
  bytes: Buffer.byteLength(text),
  source: 'https://hr.example/roster.csv',
});

async function setup(tag: string, mentees: number, feed: Record<string, unknown> = {}) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${tag}`;
  const org = await prisma.organization.create({
    data: { name: `RD ${tag} ${stamp}`, slug: `rd-${stamp}`, supportEmail: `support-${stamp}@example.test` },
  });
  const emails: string[] = [];
  for (let i = 0; i < mentees; i++) {
    const email = uniqueEmail(`rd-${tag}-${i}`);
    const user = await seedUser(email, PASSWORD, 'MENTEE', `RD ${tag} ${i}`);
    await prisma.user.update({ where: { id: user.id }, data: { orgId: org.id } });
    emails.push(email);
  }
  const created = await prisma.rosterFeed.create({
    data: {
      orgId: org.id,
      name: `RD feed ${tag}`,
      url: 'https://hr.example/roster.csv',
      columnMap: { email: 'email', fullName: 'name' },
      deprovision: true,
      ...feed,
    },
  });
  return { org, emails, feedId: created.id };
}

async function teardown(ctx: { org: { id: string }; emails: string[] }, extra: string[] = []) {
  for (const email of [...ctx.emails, ...extra]) await cleanupByEmail(email);
  await prisma.organization.delete({ where: { id: ctx.org.id } }).catch(() => {});
}

const userOf = (email: string) => prisma.user.findFirstOrThrow({ where: { email } });

async function signInRemembered(page: Page, email: string) {
  await gotoSettled(page, '/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.getByTestId('remember-me').check();
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
  await page.waitForLoadState('load');
}

async function cookie(context: BrowserContext, names: string[]) {
  return (await context.cookies()).find((c) => names.includes(c.name))?.value;
}

test.describe('roster deprovisioning', { tag: '@smoke' }, () => {
  test('absent on two runs a day apart: deactivated, sessions and remembered devices revoked', async ({ browser }) => {
    // 100% ceiling so this test is about the grace, not the valve.
    const ctx = await setup('grace', 2, { maxDeactivatePercent: 100 });
    const [stays, leaves] = ctx.emails;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await signInRemembered(page, leaves);
      await expect.poll(() => cookie(context, REMEMBER_COOKIES), { timeout: 10_000 }).toBeTruthy();

      // Run 1: absent once — stamped, still active.
      const first = await runRosterFeed(ctx.feedId, {}, { fetchFile: transport(fileOf([stays])) });
      expect(first.outcome).toBe('APPLIED');
      let gone = await userOf(leaves);
      expect(gone.isActive).toBe(true);
      expect(gone.rosterAbsentSince).not.toBeNull();

      // A second run the same day is not a second night.
      await runRosterFeed(ctx.feedId, {}, { fetchFile: transport(fileOf([stays])) });
      expect((await userOf(leaves)).isActive).toBe(true);

      // Run 2, a day later (the same file — the usual case): deactivated.
      const second = await runRosterFeed(
        ctx.feedId,
        { now: new Date(Date.now() + DAY) },
        { fetchFile: transport(fileOf([stays])) },
      );
      expect(second.deprovision?.deactivated).toBe(1);
      gone = await userOf(leaves);
      expect(gone.isActive).toBe(false);
      expect(gone.deactivatedBy).toBe(rosterActor(ctx.feedId));
      expect(gone.sessionsValidFrom).not.toBeNull();
      const devices = await prisma.trustedDevice.findMany({ where: { userId: gone.id } });
      expect(devices.length).toBeGreaterThan(0);
      for (const d of devices) expect(d.revokedAt).not.toBeNull();
      expect((await userOf(stays)).isActive).toBe(true);

      // Nothing deleted; the run log names the person; the trail has the line.
      const row = await prisma.rosterRowResult.findFirst({ where: { userId: gone.id, status: 'DEACTIVATE' } });
      expect(row?.rowNumber).toBeLessThan(0);
      expect(
        await prisma.activityLog.count({ where: { action: 'roster.deprovisioned', targetId: ctx.feedId } }),
      ).toBe(1);

      // The auditor's test: the live session is dead AND the remembered browser
      // does not sign itself back in.
      for (const name of SESSION_COOKIES) await context.clearCookies({ name });
      await page.goto('/portal');
      await page.waitForLoadState('load');
      expect(new URL(page.url()).pathname).not.toBe('/portal');
      const session = await (await page.request.get('/api/auth/session')).json();
      expect(session?.user?.email ?? null).toBeNull();

      // Back in the feed: the feed undoes its own decision.
      const back = await runRosterFeed(
        ctx.feedId,
        { now: new Date(Date.now() + 2 * DAY) },
        { fetchFile: transport(fileOf([stays, leaves])) },
      );
      expect(back.deprovision?.reactivated).toBe(1);
      const returned = await userOf(leaves);
      expect(returned.isActive).toBe(true);
      expect(returned.deactivatedBy).toBeNull();
      expect(returned.rosterAbsentSince).toBeNull();
    } finally {
      await context.close();
      await teardown(ctx);
    }
  });

  test('the deactivation ceiling aborts with nothing written and alerts', async () => {
    const ctx = await setup('ceiling', 10);
    const newcomer = uniqueEmail('rd-newcomer');
    try {
      const result = await runRosterFeed(ctx.feedId, {}, { fetchFile: transport(fileOf([ctx.emails[0], newcomer])) });
      expect(result.outcome).toBe('ABORTED_SAFETY');
      expect(result.safety?.reason).toBe('deactivation_ceiling');
      const run = await prisma.rosterRun.findFirstOrThrow({ where: { feedId: ctx.feedId } });
      expect(run.status).toBe('ABORTED_SAFETY');
      expect(run.safetyReason).toContain('deactivation_ceiling');
      // Zero writes: no newcomer, no stamps, nobody switched off.
      expect(await prisma.user.count({ where: { email: newcomer } })).toBe(0);
      const roster = await prisma.user.findMany({ where: { orgId: ctx.org.id } });
      for (const u of roster) {
        expect(u.isActive).toBe(true);
        expect(u.rosterAbsentSince).toBeNull();
      }
      // The alert went to the tenant's support address.
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
      await expect
        .poll(() => prisma.emailLog.count({ where: { to: org.supportEmail!, category: 'ops-alert' } }))
        .toBeGreaterThan(0);
    } finally {
      await teardown(ctx, [newcomer]);
    }
  });

  test('a file below the row floor aborts with nothing written', async () => {
    const ctx = await setup('floor', 3, { minRowCount: 3, maxDeactivatePercent: 100 });
    const newcomer = uniqueEmail('rd-floor-new');
    try {
      const result = await runRosterFeed(ctx.feedId, {}, { fetchFile: transport(fileOf([ctx.emails[0], newcomer])) });
      expect(result.outcome).toBe('ABORTED_SAFETY');
      expect(result.safety?.reason).toBe('row_floor');
      expect(await prisma.user.count({ where: { email: newcomer } })).toBe(0);
      for (const email of ctx.emails) expect((await userOf(email)).rosterAbsentSince).toBeNull();
    } finally {
      await teardown(ctx, [newcomer]);
    }
  });

  test('the break-glass account is refused and an admin decision is never undone', async () => {
    const ctx = await setup('guards', 3, { maxDeactivatePercent: 100 });
    const [exempt, byAdmin, plain] = ctx.emails;
    try {
      const exemptUser = await prisma.user.update({
        where: { id: (await userOf(exempt)).id },
        data: { ssoExempt: true, rosterAbsentSince: new Date(Date.now() - 3 * DAY) },
      });
      await prisma.user.update({
        where: { id: (await userOf(byAdmin)).id },
        data: { isActive: false, deactivatedBy: 'some-admin-id' },
      });
      // Absent: the exempt account. Present: the admin-deactivated one.
      await runRosterFeed(ctx.feedId, {}, { fetchFile: transport(fileOf([byAdmin, plain])) });
      expect((await userOf(exempt)).isActive).toBe(true);
      expect(
        await prisma.rosterRowResult.count({ where: { userId: exemptUser.id, message: { contains: 'break-glass' } } }),
      ).toBe(1);
      expect((await userOf(byAdmin)).isActive).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });
});
