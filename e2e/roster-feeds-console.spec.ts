import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';
import { claimFeed, releaseFeed, runFeed } from '@/lib/rosterFeedRunner';
import { E2E_ROSTER_SOURCE_PORT } from '../playwright.config';

// The roster feeds console and its runner (#1967):
//   - an admin creates a feed with the column mapper driven by a real sample
//     header, dry-runs it (nothing written), runs it, and reads the per-row
//     outcome and its CSV — through the real HTTPS transport against a local
//     HR-export stub (e2e/support/roster-source.mjs);
//   - another org's feed is invisible AND unrunnable, proven by API calls with
//     its id, not by a hidden button;
//   - the claim lets exactly one caller run a feed, and three failures in a row
//     pause it with a reason.

const PASSWORD = 'RosterConsole123!';
const SOURCE = `http://127.0.0.1:${E2E_ROSTER_SOURCE_PORT}`;

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function orgWithAdmin(tag: string) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${tag}`;
  const org = await prisma.organization.create({ data: { name: `RC ${tag} ${stamp}`, slug: `rc-${stamp}` } });
  const email = uniqueEmail(`rc-${tag}`);
  const admin = await seedUser(email, PASSWORD, 'ADMIN', `${tag} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  return { org, email, stamp };
}

async function serve(name: string, csv: string) {
  const res = await fetch(`${SOURCE}/__roster`, { method: 'POST', body: JSON.stringify({ name, csv }) });
  expect(res.ok).toBe(true);
}

test('create a feed from a sample header, dry run, run, and read the run detail', async ({ page }) => {
  const a = await orgWithAdmin('ui');
  const person = uniqueEmail('rc-person');
  const file = `rc-${a.stamp.replace(/[^\w-]/g, '')}`;
  await serve(file, `WorkEmail,DisplayName,Team\n${person},Pat Example,Ops\n`);
  try {
    await signInAndSettle(page, a.email, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/roster-feeds');
    await page.getByTestId('roster-feed-new').click();
    const form = page.getByTestId('roster-feed-form');
    await form.getByTestId('feed-name').fill('Nightly HR');
    await form.getByTestId('feed-url').fill(`${SOURCE}/roster/${file}.csv`);
    await form.getByTestId('feed-cron').fill('0 3 * * *');
    await expect(form.getByTestId('feed-cron-preview')).not.toBeEmpty();

    // The mapper offers the sample's own headers.
    await form.getByTestId('feed-sample-paste').fill('WorkEmail,DisplayName,Team\nx@example.com,X,Y');
    await expect(form.getByTestId('feed-sample-columns')).toBeVisible();
    await form.getByTestId('column-email').selectOption('WorkEmail');
    await form.getByTestId('column-fullName').selectOption('DisplayName');
    await form.getByTestId('roster-feed-save').click();
    await expect(form).toBeHidden();

    const feed = await prisma.rosterFeed.findFirstOrThrow({ where: { orgId: a.org.id } });
    expect(feed.columnMap).toEqual({ email: 'WorkEmail', fullName: 'DisplayName' });
    const row = page.getByTestId(`roster-feed-${feed.id}`);
    await expect(row).toBeVisible();

    // Dry run: a report, and nothing written.
    await row.getByTestId(`roster-dry-run-${feed.id}`).click();
    await expect(page.getByTestId('roster-notice')).toContainText('1');
    expect(await prisma.user.count({ where: { email: person } })).toBe(0);

    // Run: the person exists.
    await row.getByTestId(`roster-run-${feed.id}`).click();
    await expect.poll(() => prisma.user.count({ where: { email: person, orgId: a.org.id } })).toBe(1);
    await expect(page.getByTestId(`roster-feed-last-${feed.id}`)).toContainText(/Succeeded/);

    // Run detail: the row, its action, and the CSV.
    await row.getByTestId(`roster-history-${feed.id}`).click();
    const run = await prisma.rosterRun.findFirstOrThrow({ where: { feedId: feed.id, dryRun: false } });
    await page.getByTestId(`roster-detail-${run.id}`).click();
    const rows = page.getByTestId('roster-rows');
    await expect(rows).toContainText(person);
    await expect(rows).toContainText('Created');
    await page.getByTestId('roster-row-filter').selectOption('ERROR');
    await expect(rows).not.toContainText(person);

    const csv = await page.request.get(`/api/admin/roster-feeds/${feed.id}/runs/${run.id}?format=csv`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect(await csv.text()).toContain(person);
  } finally {
    await cleanupByEmail(person);
    await cleanupByEmail(a.email);
    await prisma.organization.delete({ where: { id: a.org.id } }).catch(() => {});
  }
});

test.describe('roster feed console boundaries', { tag: '@smoke' }, () => {
  test("another org's feed is invisible and unrunnable", async ({ page }) => {
    const a = await orgWithAdmin('A');
    const b = await orgWithAdmin('B');
    const foreign = await prisma.rosterFeed.create({
      data: { orgId: b.org.id, name: 'Foreign', url: 'https://example.com/b.csv', columnMap: { email: 'Mail' } },
    });
    const foreignRun = await prisma.rosterRun.create({
      data: {
        orgId: b.org.id,
        feedId: foreign.id,
        fileHash: 'b'.repeat(64),
        status: 'ABORTED_SAFETY',
        safetyReason: 'deactivation_ceiling: test',
      },
    });
    try {
      await signInAndSettle(page, a.email, PASSWORD, '/admin');
      const base = `/api/admin/roster-feeds/${foreign.id}`;
      expect((await page.request.post(`${base}/run`, { data: { dryRun: true } })).status()).toBe(404);
      expect((await page.request.post(`${base}/run`, { data: {} })).status()).toBe(404);
      expect((await page.request.get(`${base}/runs`)).status()).toBe(404);
      expect((await page.request.get(`${base}/runs/${foreignRun.id}`)).status()).toBe(404);
      expect((await page.request.get(`${base}/runs/${foreignRun.id}?format=csv`)).status()).toBe(404);
      expect((await page.request.post(`${base}/runs/${foreignRun.id}/approve`)).status()).toBe(404);
      expect((await page.request.post(`${base}/runs/${foreignRun.id}/acknowledge`)).status()).toBe(404);
      // Nothing ran, nothing was stamped.
      expect(await prisma.rosterRun.count({ where: { feedId: foreign.id } })).toBe(1);
      const after = await prisma.rosterRun.findUniqueOrThrow({ where: { id: foreignRun.id } });
      expect(after.approvedById).toBeNull();
      expect(after.acknowledgedAt).toBeNull();
      expect((await prisma.rosterFeed.findUniqueOrThrow({ where: { id: foreign.id } })).lastRunAt).toBeNull();
    } finally {
      for (const x of [a, b]) {
        await cleanupByEmail(x.email);
        await prisma.organization.delete({ where: { id: x.org.id } }).catch(() => {});
      }
    }
  });

  test('one claim per feed, and three failures in a row pause it', async () => {
    const a = await orgWithAdmin('claim');
    // A URL the stub answers 404 for: every run fails.
    const feed = await prisma.rosterFeed.create({
      data: {
        orgId: a.org.id,
        name: 'Broken',
        url: `${SOURCE}/roster/missing-${a.stamp.replace(/[^\w-]/g, '')}.csv`,
        columnMap: { email: 'email' },
        enabled: true,
        cronExpression: '0 3 * * *',
      },
    });
    const previous = process.env.ROSTER_FEED_ALLOW_INSECURE_STUB;
    process.env.ROSTER_FEED_ALLOW_INSECURE_STUB = '1';
    try {
      // The claim: exactly one winner until it is released.
      expect(await claimFeed(feed.id)).toBe(true);
      expect(await claimFeed(feed.id)).toBe(false);
      expect((await runFeed(feed.id)).status).toBe('claimed_elsewhere');
      await releaseFeed(feed.id);

      for (let i = 0; i < 3; i++) expect((await runFeed(feed.id)).status).toBe('error');
      const paused = await prisma.rosterFeed.findUniqueOrThrow({ where: { id: feed.id } });
      expect(paused.enabled).toBe(false);
      expect(paused.consecutiveFailures).toBe(3);
      expect(paused.pausedReason).toContain('404');
      expect(paused.claimedUntil).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.ROSTER_FEED_ALLOW_INSECURE_STUB;
      else process.env.ROSTER_FEED_ALLOW_INSECURE_STUB = previous;
      await cleanupByEmail(a.email);
      await prisma.organization.delete({ where: { id: a.org.id } }).catch(() => {});
    }
  });
});
