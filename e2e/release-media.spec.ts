import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, statSync } from 'fs';
import path from 'path';
// Static, not `await import()`: Playwright resolves the `@/…` alias only for the
// spec's static import graph (see e2e/erasure-free-text.spec.ts).
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * Release-note media capture (#2233) — a PRODUCER, not a test.
 *
 * Everything else under e2e/ verifies behaviour. This file makes the picture a
 * release note carries: it drives the screen the change is about and writes the
 * result into public/release-media/, where the release fragment points at it
 * (releases/README.md -> "Media on a release note").
 *
 * IT DOES NOT RUN IN CI. Not in the PR smoke gate, and not in the scheduled
 * full suite: playwright.config.ts only declares the `release-media` project
 * when CAPTURE_RELEASE_MEDIA is set, and the default `chromium` project ignores
 * this file. A capture job that ran on its own would silently rewrite committed
 * bytes on someone else's PR; the author captures deliberately and commits the
 * result:
 *
 *     npm run test:e2e:media                      # everything below
 *     npm run test:e2e:media -- --grep "poster"   # one capture
 *
 * Deliberately NOT screenshot diffing. `e2e/mobile-chat-layout.spec.ts` states
 * the house rule — geometric assertions, never pixel comparison — and this file
 * does not change it. Nothing here asserts that an image looks like anything;
 * it only produces one.
 *
 * TWO SHAPES OF CAPTURE
 *
 *   Still  — `locator.screenshot()`, ALWAYS an element, never `page`. A cropped
 *            component is 40-80 KB (the validator caps a poster at 150 KB) and
 *            it does not churn every time unrelated page chrome moves.
 *   Clip   — Playwright's own `recordVideo`, so the output is WebM with no
 *            ffmpeg anywhere. Video is recorded per BrowserContext, whole
 *            viewport, for the WHOLE test — Playwright can neither crop it to
 *            an element nor trim it to the interesting seconds. So do not try:
 *            keep the test minimal, so the whole test *is* the thing worth
 *            showing, and keep it under five seconds (WCAG 2.2.2 — the
 *            validator rejects a longer clip).
 *
 * A still is always required; a clip almost never is. Add one only when motion
 * is the point (a drag, a reveal, a live update).
 */

const MEDIA_DIR = path.join(__dirname, '..', 'public', 'release-media');

/** Loud, because the file is the deliverable: name it and give its size. */
function report(label: string, file: string) {
  const kb = statSync(file).size / 1024;
  console.log(`captured ${label}: public/release-media/${path.basename(file)} (${kb.toFixed(0)} KB)`);
}

/**
 * One element, cropped, into public/release-media/<slug>.png.
 * `slug` is the release fragment's slug — one poster per fragment, so the name
 * cannot collide with another change's.
 */
async function capturePoster(target: Locator, slug: string) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, `${slug}.png`);
  await target.waitFor({ state: 'visible' });
  await target.screenshot({ path: file, animations: 'disabled', scale: 'css' });
  report('poster', file);
  return file;
}

/**
 * The page's recording, into public/release-media/<slug>.webm.
 *
 * The page has to be CLOSED first: Playwright finalises a video when its page
 * closes, and `video.saveAs()` waits for exactly that — calling it on a page
 * that is still open waits for the end of the test still driving it.
 */
async function captureClip(page: Page, slug: string) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, `${slug}.webm`);
  const video = page.video();
  expect(video, 'no video recorded — did the context set recordVideo?').toBeTruthy();
  await page.close();
  await video!.saveAs(file);
  report('clip', file);
  return file;
}

test.describe('release media', () => {
  // Captures are light-theme only and framed by the page, so nothing here
  // touches the theme. A fixed, modest viewport keeps a poster's pixel size
  // stable between authors and machines.
  test.use({ viewport: { width: 1100, height: 800 } });

  /**
   * TEMPLATE — a still of one component.
   *
   * Copy this test for your own change: point it at the element the release
   * note is about, and name the file after your fragment's slug. The example
   * uses a public page so it needs no seeded data; a capture of a signed-in
   * screen imports `signInAndSettle` from './helpers/auth' and seeds its own
   * user with './helpers/db', exactly like a normal spec.
   */
  test('poster: the newest release-notes card', async ({ page }) => {
    await page.goto('/release-notes');
    // The newest card, which is also the surface this very change is about.
    await capturePoster(page.getByTestId('release-card').first(), 'example-release-card');
  });

  // #1399: the landing's product tour — one of its three figures, caption and
  // screenshot together, as a visitor scrolls to it.
  test('poster: a product-tour figure on the landing', async ({ page }) => {
    await page.goto('/');
    const figure = page.getByTestId('product-tour-company');
    await figure.scrollIntoViewIfNeeded();
    // The screenshot is lazy: wait for its pixels, not just its box.
    await expect
      .poll(() => figure.locator('img:visible').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await capturePoster(figure, 'landing-product-tour');
  });

  // #1918: the weekly-report compliance matrix with its legend and summary.
  test('poster: the weekly-report compliance matrix', async ({ page }) => {
    const DAY = 24 * 60 * 60 * 1000;
    const monday = (offset: number) => {
      const now = new Date();
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + offset * 7);
      return day;
    };
    const stamp = Date.now();
    const org = await prisma.organization.create({ data: { name: `Media WR ${stamp}`, slug: `media-wr-${stamp}` } });
    const adminEmail = uniqueEmail('media-wr-admin');
    const mentorEmail = uniqueEmail('media-wr-mentor');
    await seedUser(adminEmail, 'MediaWr123!', 'ADMIN', 'Media Admin', org.id);
    const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Selin Aydın', org.id);
    const emails = [adminEmail, mentorEmail];
    // Three interns, six owed weeks each, three different stories.
    const patterns = [
      ['Aylin Demir', ['APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'SUBMITTED']],
      ['Berk Yıldız', ['APPROVED', null, 'APPROVED', 'CHANGES_REQUESTED', 'APPROVED', 'SUBMITTED']],
      ['Cemre Kaya', ['APPROVED', 'APPROVED', null, null, 'DRAFT', 'APPROVED']],
    ] as const;
    try {
      for (const [index, [name, weeks]] of patterns.entries()) {
        const email = uniqueEmail('media-wr-intern');
        emails.push(email);
        const intern = await seedUser(email, 'x', 'MENTEE', name, org.id);
        const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: intern.id, orgId: org.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450', startDate: monday(-8) } });
        await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'INTERNSHIP_STARTING_300', toStatus: 'INTERNSHIP_IN_PROGRESS_450', createdAt: new Date(monday(-7).getTime() + DAY) } });
        for (const [k, status] of weeks.entries()) {
          if (!status) continue;
          const weekStart = monday(-6 + k);
          const late = index === 1 && k === 2;
          await prisma.weeklyReport.create({ data: { orgId: org.id, relationId: rel.id, weekStart, summary: 'Media', hoursSpent: 35, status, submittedAt: status === 'DRAFT' ? null : new Date(weekStart.getTime() + (late ? 9 : 4) * DAY) } });
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await signInAndSettle(page, adminEmail, 'MediaWr123!', '/admin');
      await page.goto('/admin/weekly-reports');
      await page.getByTestId('weekly-reports-matrix').waitFor();
      await capturePoster(page.locator('#weekly-reports-print'), 'weekly-report-oversight-screen');
    } finally {
      for (const e of emails) await cleanupByEmail(e);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    }
  });

  // #1905: the scheduled-reports screen with two subscriptions, one opened history.
  test('poster: scheduled reports', async ({ page }) => {
    const stamp = Date.now();
    const org = await prisma.organization.create({ data: { name: `Media RS ${stamp}`, slug: `media-rs-${stamp}` } });
    const adminEmail = uniqueEmail('media-rs-admin');
    try {
      const admin = await seedUser(adminEmail, 'MediaRs123!', 'ADMIN', 'Jana Köhler', org.id);
      for (const feature of ['ADVANCED_ANALYTICS', 'REPORT_EXPORT']) await prisma.orgEntitlement.create({ data: { orgId: org.id, feature, note: 'media' } });
      const dean = await prisma.reportSubscription.create({
        data: { orgId: org.id, reportKey: 'cohort-comparison', cadence: 'MONTHLY', dayOfMonth: 1, hour: 7, locale: 'de', format: 'EMAIL_SUMMARY', recipientEmail: 'dekanat@hochschule.example', recipientName: 'Prof. Dr. Weber', createdById: admin.id, lastSentAt: new Date(Date.now() - 5 * 86_400_000) },
      });
      await prisma.reportSubscriptionSend.createMany({
        data: [
          { orgId: org.id, subscriptionId: dean.id, periodKey: '2026-10', status: 'SENT', sentAt: new Date(Date.now() - 5 * 86_400_000) },
          { orgId: org.id, subscriptionId: dean.id, periodKey: '2026-09', status: 'SENT', sentAt: new Date(Date.now() - 35 * 86_400_000) },
        ],
      });
      await prisma.reportSubscription.create({
        data: { orgId: org.id, reportKey: 'weekly-report-compliance', cadence: 'WEEKLY', dayOfWeek: 1, hour: 6, locale: 'en', format: 'XLSX', recipientUserId: admin.id, createdById: admin.id },
      });
      await signInAndSettle(page, adminEmail, 'MediaRs123!', '/admin');
      await page.goto('/admin/reports/subscriptions');
      const list = page.getByTestId('report-subs-list');
      await list.locator('li').filter({ hasText: 'Prof. Dr. Weber' }).getByText('Delivery history').click();
      await capturePoster(list, 'report-subscriptions-ui');
    } finally {
      await prisma.reportSubscription.deleteMany({ where: { orgId: org.id } });
      await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
      await cleanupByEmail(adminEmail);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    }
  });

  // #1366: empty stages collapse to one strip per run, so three occupied stages
  // are on screen together.
  test('poster: the mentor board with its empty stages collapsed', async ({ page }) => {
    const mentorEmail = uniqueEmail('media-board-mentor');
    const mentor = await seedUser(mentorEmail, 'MediaBoard123!', 'MENTOR', 'Media Board Mentor');
    const emails: string[] = [];
    const ids: string[] = [];
    for (const [name, stage] of [
      ['Aylin Demir', 'APPLICATION_100'],
      ['Berk Yıldız', 'INTERNSHIP_IN_PROGRESS_450'],
      ['Cemre Kaya', 'HIRED_660'],
    ]) {
      const email = uniqueEmail('media-board-mentee');
      emails.push(email);
      const mentee = await seedUser(email, 'x', 'MENTEE', name);
      ids.push((await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: stage } })).id);
    }
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await signInAndSettle(page, mentorEmail, 'MediaBoard123!', '/mentor');
      await page.goto('/mentor/board');
      await capturePoster(page.getByTestId('board-columns'), 'board-empty-stages-collapsed');
    } finally {
      await prisma.mentorshipRelation.deleteMany({ where: { id: { in: ids } } });
      for (const e of [...emails, mentorEmail]) await cleanupByEmail(e);
    }
  });

  // #1902: the org-wide at-risk queue — worst first, reasons, one next action,
  // and a 30-day trend drawn from the nightly snapshots.
  test('poster: the relationship health queue', async ({ page }) => {
    const DAY = 24 * 60 * 60 * 1000;
    const stamp = Date.now();
    const org = await prisma.organization.create({ data: { name: `Media Health ${stamp}`, slug: `media-health-${stamp}` } });
    const adminEmail = uniqueEmail('media-health-admin');
    const emails = [adminEmail];
    try {
      await seedUser(adminEmail, 'MediaHealth123!', 'ADMIN', 'Media Health Admin', org.id);
      const mentorEmail = uniqueEmail('media-health-mentor');
      emails.push(mentorEmail);
      const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Dr. Lena Hoffmann', org.id);
      const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
      const pairs: [string, number, number | null][] = [
        // name, start (days ago), last contact (days ago; null = never)
        ['Aylin Demir', 200, null],
        ['Jonas Weber', 120, 24],
        ['Selin Arslan', 150, 3],
      ];
      for (const [i, [name, startAgo, contactAgo]] of pairs.entries()) {
        const email = uniqueEmail('media-health-mentee');
        emails.push(email);
        const mentee = await seedUser(email, 'x', 'MENTEE', name, org.id);
        const rel = await prisma.mentorshipRelation.create({
          data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERVIEW_PENDING_250', startDate: new Date(Date.now() - startAgo * DAY), stageDeadline: new Date(Date.now() - (5 + i) * DAY) },
        });
        if (contactAgo !== null) await prisma.interactionLog.create({ data: { relationId: rel.id, date: new Date(Date.now() - contactAgo * DAY), notes: 'Check-in', type: 'Call' } });
        if (i === 0) await prisma.mentorQuestion.create({ data: { relationId: rel.id, askedById: mentee.id, question: 'Could we review my CV this week?' } });
        // A month of measured days drifting down, so the trend has a shape.
        await prisma.relationHealthSnapshot.createMany({
          data: Array.from({ length: 30 }, (_, d) => {
            const score = Math.max(15, 85 - i * 10 - Math.round(d * (2.2 - i * 0.6)));
            return { orgId: org.id, relationId: rel.id, takenOn: new Date(today.getTime() - (29 - d) * DAY), score, band: score >= 70 ? 'HEALTHY' : score >= 40 ? 'WATCH' : 'AT_RISK', reasons: [], rulesVersion: 1 };
          }),
        });
      }
      await page.setViewportSize({ width: 1280, height: 720 });
      await signInAndSettle(page, adminEmail, 'MediaHealth123!', '/admin');
      await page.goto('/admin/health');
      const table = page.getByTestId('health-table');
      await expect(table.locator('tbody tr')).toHaveCount(3);
      await capturePoster(table, 'admin-health-monitor');
    } finally {
      await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
      for (const e of emails) await cleanupByEmail(e);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    }
  });

  // #1895: the ROI report — the number, then every step that produced it.
  test('poster: the programme ROI working', async ({ page }) => {
    const DAY = 24 * 60 * 60 * 1000;
    const stamp = Date.now();
    const org = await prisma.organization.create({ data: { name: `Media ROI ${stamp}`, slug: `media-roi-${stamp}` } });
    await prisma.orgEntitlement.create({ data: { orgId: org.id, feature: 'ADVANCED_ANALYTICS', note: 'release media' } });
    const adminEmail = uniqueEmail('media-roi-admin');
    const emails = [adminEmail];
    try {
      await seedUser(adminEmail, 'MediaRoi123!', 'ADMIN', 'Media ROI Admin', org.id);
      const mentorEmail = uniqueEmail('media-roi-mentor');
      emails.push(mentorEmail);
      const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Dr. Lena Hoffmann', org.id);
      const now = Date.now();
      await prisma.programCost.createMany({
        data: [
          { orgId: org.id, category: 'STAFF', label: 'Programme coordinator', amountMinor: 3_600_000, currency: 'EUR', periodStart: new Date(now - 300 * DAY), periodEnd: new Date(now - 10 * DAY) },
          { orgId: org.id, category: 'PLATFORM', label: 'Licence', amountMinor: 480_000, currency: 'EUR', periodStart: new Date(now - 300 * DAY), periodEnd: new Date(now + 60 * DAY) },
          { orgId: org.id, category: 'EVENT', label: 'Kick-off day', amountMinor: 250_000, currency: 'EUR', periodStart: new Date(now - 200 * DAY), periodEnd: new Date(now - 200 * DAY) },
        ],
      });
      for (const [i, name] of ['Aylin Demir', 'Jonas Weber', 'Selin Arslan', 'Mert Koç', 'Hanna Becker'].entries()) {
        const email = uniqueEmail('media-roi-mentee');
        emails.push(email);
        const mentee = await seedUser(email, 'x', 'MENTEE', name, org.id);
        const rel = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'HIRED_660' } });
        await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'INTERNSHIP_COMPLETED_490', toStatus: 'HIRED_660', createdAt: new Date(now - (30 + i * 40) * DAY) } });
        if (i < 3) {
          await prisma.placement.create({ data: { orgId: org.id, relationId: rel.id, menteeId: mentee.id, placedAt: new Date(now - (30 + i * 40) * DAY), valueMinor: 2_200_000 + i * 150_000, valueCurrency: 'EUR', valueSource: 'MANUAL' } });
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await signInAndSettle(page, adminEmail, 'MediaRoi123!', '/admin');
      await page.goto('/admin/analytics/roi');
      await expect(page.getByTestId('roi-steps')).toBeVisible();
      await capturePoster(page.getByTestId('roi-steps').locator('xpath=ancestor::section[1]/..'), 'roi-executive-dashboards');
    } finally {
      await prisma.programCost.deleteMany({ where: { orgId: org.id } });
      await prisma.placement.deleteMany({ where: { orgId: org.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
      for (const e of emails) await cleanupByEmail(e);
      await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
      await prisma.organization.deleteMany({ where: { id: org.id } });
    }
  });

  // #1895 part 2: the executive dashboard — four scores, each with its trend.
  test('poster: the executive dashboard', async ({ page }) => {
    const DAY = 24 * 60 * 60 * 1000;
    const stamp = Date.now();
    const org = await prisma.organization.create({ data: { name: `Media Exec ${stamp}`, slug: `media-exec-${stamp}` } });
    await prisma.orgEntitlement.create({ data: { orgId: org.id, feature: 'ADVANCED_ANALYTICS', note: 'release media' } });
    const adminEmail = uniqueEmail('media-exec-admin');
    const emails = [adminEmail];
    try {
      await seedUser(adminEmail, 'MediaExec123!', 'ADMIN', 'Media Exec Admin', org.id);
      const mentorEmail = uniqueEmail('media-exec-mentor');
      emails.push(mentorEmail);
      const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Dr. Lena Hoffmann', org.id);
      const ago = (d: number) => new Date(Date.now() - d * DAY);
      // Twelve pairs over a year: contact, moves and hires spread so every
      // 90-day period has a different, plausible shape.
      for (let i = 0; i < 12; i++) {
        const email = uniqueEmail('media-exec-mentee');
        emails.push(email);
        const mentee = await seedUser(email, 'x', 'MENTEE', `Participant ${i + 1}`, org.id);
        const hired = i % 4 === 0;
        const rel = await prisma.mentorshipRelation.create({
          data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, startDate: ago(560 - i * 20), pipelineStatus: hired ? 'HIRED_660' : 'INTERVIEW_PENDING_250' },
        });
        for (let k = 0; k < 6; k++) {
          if ((i + k) % 3 !== 0) await prisma.interactionLog.create({ data: { relationId: rel.id, date: ago(10 + k * 90 + i), notes: 'Check-in', type: 'Call' } });
        }
        await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', createdAt: ago(40 + (i % 6) * 90) } });
        if (hired) await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'INTERVIEW_PENDING_250', toStatus: 'HIRED_660', createdAt: ago(20 + i * 7) } });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await signInAndSettle(page, adminEmail, 'MediaExec123!', '/admin');
      await page.goto('/admin/analytics/executive');
      await expect(page.getByTestId('executive-capability')).toBeVisible();
      await capturePoster(page.getByTestId('executive-capability').locator('xpath=..'), 'executive-dashboard');
    } finally {
      await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
      for (const e of emails) await cleanupByEmail(e);
      await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
      await prisma.organization.deleteMany({ where: { id: org.id } });
    }
  });

  // #1908: the programme health scorecard — bands against published targets,
  // and a link on every row that slipped.
  test('poster: the programme health scorecard', async ({ page }) => {
    const DAY = 24 * 60 * 60 * 1000;
    const stamp = Date.now();
    const org = await prisma.organization.create({ data: { name: `Media Scorecard ${stamp}`, slug: `media-sc-${stamp}` } });
    const adminEmail = uniqueEmail('media-sc-admin');
    const emails = [adminEmail];
    try {
      const admin = await seedUser(adminEmail, 'MediaScore123!', 'ADMIN', 'Media Scorecard Admin', org.id);
      const mentorEmail = uniqueEmail('media-sc-mentor');
      emails.push(mentorEmail);
      const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Dr. Lena Hoffmann', org.id);
      const ago = (d: number) => new Date(Date.now() - d * DAY);
      for (let i = 0; i < 10; i++) {
        const email = uniqueEmail('media-sc-mentee');
        emails.push(email);
        const mentee = await seedUser(email, 'x', 'MENTEE', `Participant ${i + 1}`, org.id);
        if (i >= 8) continue; // two waiting for a match
        const rel = await prisma.mentorshipRelation.create({
          data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERVIEW_PENDING_250', startDate: ago(40 + i * 15) },
        });
        if (i % 3 !== 2) await prisma.interactionLog.create({ data: { relationId: rel.id, date: ago(3 + i), notes: 'Check-in', type: 'Call' } });
        await prisma.goal.create({ data: { relationId: rel.id, title: 'CV review' } });
        if (i % 2 === 0) await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', createdAt: ago(10 + i) } });
        await prisma.meeting.create({ data: { relationId: rel.id, title: 'Intro', scheduledAt: ago(30 + i * 15 - 8 - i), rsvpToken: `media-sc-${stamp}-${i}-a`, createdById: mentor.id } });
        if (i % 2 === 0) await prisma.meeting.create({ data: { relationId: rel.id, title: 'Monthly', scheduledAt: ago(5 + i), rsvpToken: `media-sc-${stamp}-${i}-b`, createdById: mentor.id } });
      }
      for (let i = 0; i < 8; i++) {
        await prisma.invitationToken.create({ data: { orgId: org.id, token: `media-sc-${stamp}-inv-${i}`, role: 'MENTEE', used: i < 6, createdAt: ago(40), expiresAt: ago(33), invitedById: admin.id } });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await signInAndSettle(page, adminEmail, 'MediaScore123!', '/admin');
      await page.goto('/admin/analytics');
      await expect(page.getByTestId('scorecard-row-matchRate')).toBeVisible();
      await capturePoster(page.getByTestId('program-scorecard'), 'program-scorecard');
    } finally {
      await prisma.invitationToken.deleteMany({ where: { orgId: org.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
      for (const e of emails) await cleanupByEmail(e);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    }
  });

  /**
   * TEMPLATE — a clip, for a change where motion is the point.
   *
   * THE RECORDING STARTS AT `newContext()`, NOT AT THE FIRST ACTION. Everything
   * between that call and `page.close()` is in the file: the navigation, and —
   * against `npm run dev` — the several seconds Next.js spends compiling the
   * route on its first hit. That alone can push a 1.2s interaction past the
   * five-second cap and get the fragment rejected by `check:release-fragments`
   * with a message about the test being too long. So the route is warmed in the
   * ordinary `page` fixture (a separate, unrecorded context) BEFORE the
   * recording context exists.
   *
   * `size` is the video's own resolution, kept well under the viewport: the
   * clip renders at 480px wide on the page, so recording a 1100px-wide desktop
   * would only cost bytes. Keep its aspect ratio equal to the viewport's, or
   * Playwright letterboxes the picture inside the file; and crop the fragment's
   * POSTER to roughly the same shape, since the poster is what a
   * reduced-motion reader sees in the clip's place.
   *
   * Everything the test does ends up in the file, so it does nothing but the
   * one interaction worth showing — and stays under the cap by staying short,
   * not by trimming (which Playwright cannot do).
   */
  test('clip: a short interaction on the release-notes page', async ({ browser, baseURL, page: warmup }) => {
    await warmup.goto('/release-notes');

    const context = await browser.newContext({
      // A hand-built context inherits NOTHING from the project's `use` — not
      // the baseURL a relative goto() needs, and not the consent state that
      // keeps the cookie banner out of the first frame of the recording.
      baseURL,
      storageState: path.join(__dirname, '.state', 'consent.json'),
      viewport: { width: 960, height: 600 },
      recordVideo: { dir: test.info().outputDir, size: { width: 640, height: 400 } },
    });
    const page = await context.newPage();
    try {
      await page.goto('/release-notes');
      await page.getByTestId('release-notes-feed-link').hover();
      await page.waitForTimeout(1_200);
      await captureClip(page, 'example-release-motion');
    } finally {
      await context.close();
    }
  });
});
