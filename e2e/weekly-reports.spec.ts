import { test, expect, type BrowserContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { addUtcWeeks, firstFullUtcWeek, utcWeekStart } from '../src/lib/week';
import { sendWeeklyReportReminders } from '../src/services/emailService';
import { getAttentionItems } from '../src/lib/mentorAttention';

test.afterAll(async () => prisma.$disconnect());

test('UTC week helpers keep Monday boundaries and exclude a partial first week', () => {
  expect(utcWeekStart(new Date('2026-08-09T23:59:59Z')).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  expect(utcWeekStart(new Date('2026-08-10T00:00:00Z')).toISOString()).toBe('2026-08-10T00:00:00.000Z');
  // Turkey Saturday 02:00 (+03), Germany Sunday 23:30 (+02), and a local
  // Monday that is still Sunday UTC all resolve by the UTC calendar only.
  expect(utcWeekStart(new Date('2026-08-08T02:00:00+03:00')).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  expect(utcWeekStart(new Date('2026-08-09T23:30:00+02:00')).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  expect(utcWeekStart(new Date('2026-08-10T00:30:00+03:00')).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  expect(firstFullUtcWeek(new Date('2026-08-10T12:00:00Z')).toISOString()).toBe('2026-08-17T00:00:00.000Z');
  expect(firstFullUtcWeek(new Date('2026-08-10T00:00:00Z')).toISOString()).toBe('2026-08-10T00:00:00.000Z');
});

test('mentee submission, mentor review, authorization, print and reminder dedupe', async ({ browser }) => {
  // Triples the timeout (#2343). This is not a normal test and the default 60s
  // is not a budget it was ever going to fit: it opens FIVE browser contexts —
  // mentee, mentor, an unrelated mentor, an outsider and an admin — walks a
  // submit/review round trip, a 53-row paginated history, the print view and
  // four reminder sweeps. It timed out mid-run in CI, and the first thing that
  // happened to be pending was blamed for it. `test.slow()` rather than a
  // hand-written number so the reason is legible and the value tracks the
  // project default.
  test.slow();
  const password = 'WeeklyReport123';
  const mentorEmail = uniqueEmail('weekly-mentor');
  const menteeEmail = uniqueEmail('weekly-mentee');
  const outsiderEmail = uniqueEmail('weekly-outsider');
  const unrelatedMentorEmail = uniqueEmail('weekly-unrelated-mentor');
  const adminEmail = uniqueEmail('weekly-admin');
  const contexts: BrowserContext[] = [];
  let orgId: string | null = null;
  let relationId: string | null = null;
  try {
    const org = await prisma.organization.create({ data: { name: `Weekly reports ${Date.now()}`, slug: `weekly-${Date.now()}` } });
    orgId = org.id;
    const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Weekly Mentor');
    const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Weekly Mentee');
    await seedUser(outsiderEmail, password, 'MENTEE', 'Other Mentee');
    await seedUser(unrelatedMentorEmail, password, 'MENTOR', 'Unrelated Mentor');
    const admin = await seedUser(adminEmail, password, 'ADMIN', 'Weekly Admin');
    await prisma.user.update({ where: { id: mentor.id }, data: { orgId: org.id } });
    await prisma.user.update({ where: { id: mentee.id }, data: { orgId: org.id, preferredLanguage: 'tr', emailNotifications: true, notificationPrefs: { weeklyReports: true } } });
    await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
    const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450', startDate: addUtcWeeks(utcWeekStart(new Date()), -4) } });
    relationId = relation.id;
    const attention = await getAttentionItems(mentor.id);
    expect(attention.items.find((item) => item.relationId === relation.id)?.reasons).toContain('missing_weekly_reports');
    await prisma.weeklyReport.create({ data: { orgId: org.id, relationId: relation.id, weekStart: utcWeekStart(new Date()), summary: 'Current week does not affect attention', status: 'SUBMITTED' } });
    expect((await getAttentionItems(mentor.id)).items.find((item) => item.relationId === relation.id)?.reasons).toContain('missing_weekly_reports');
    const lastWeek = addUtcWeeks(utcWeekStart(new Date()), -1);
    const attentionReport = await prisma.weeklyReport.create({ data: { orgId: org.id, relationId: relation.id, weekStart: lastWeek, summary: 'Draft last week', status: 'DRAFT' } });
    expect((await getAttentionItems(mentor.id)).items.find((item) => item.relationId === relation.id)?.reasons).toContain('missing_weekly_reports');
    await prisma.weeklyReport.update({ where: { id: attentionReport.id }, data: { status: 'CHANGES_REQUESTED' } });
    expect((await getAttentionItems(mentor.id)).items.find((item) => item.relationId === relation.id)?.reasons).not.toContain('missing_weekly_reports');
    await prisma.weeklyReport.deleteMany({ where: { relationId: relation.id } });
    const partialRelation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450', startDate: new Date(addUtcWeeks(utcWeekStart(new Date()), -1).getTime() + 12 * 60 * 60 * 1000) } });
    expect((await getAttentionItems(mentor.id)).items.find((item) => item.relationId === partialRelation.id)?.reasons).not.toContain('missing_weekly_reports');
    await prisma.mentorshipRelation.delete({ where: { id: partialRelation.id } });

    const menteeContext = await browser.newContext(); contexts.push(menteeContext);
    const menteePage = await menteeContext.newPage();
    await signInAndSettle(menteePage, menteeEmail, password, '/portal');
    // The weekly-reports panel moved off the dashboard to /portal/goals (#916).
    await menteePage.goto('/portal/goals');
    await expect(menteePage.getByTestId('weekly-reports-panel')).toBeVisible();
    await menteePage.getByTestId('weekly-report-summary').fill('Built the onboarding flow');
    await menteePage.getByTestId('weekly-report-hours').fill('35');
    await menteePage.getByTestId('weekly-report-blockers').fill('Waiting for review');
    await menteePage.getByTestId('weekly-report-save-draft').click();
    await expect.poll(async () => (await prisma.weeklyReport.findFirst({ where: { relationId: relation.id, weekStart: utcWeekStart(new Date()) } }))?.id).toBeTruthy();
    const report = await prisma.weeklyReport.findFirstOrThrow({ where: { relationId: relation.id, weekStart: utcWeekStart(new Date()) } });
    const duplicate = await menteePage.request.post('/api/weekly-reports', { data: { relationId: relation.id, summary: 'Duplicate', status: 'DRAFT' } });
    expect(duplicate.status()).toBe(409);
    expect((await duplicate.json()).code).toBe('weekly_report_exists');
    expect((await menteePage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'APPROVED' } })).status()).toBe(400);
    expect((await menteePage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'SUBMITTED' } })).status()).toBe(200);

    const outsiderContext = await browser.newContext(); contexts.push(outsiderContext);
    const outsiderPage = await outsiderContext.newPage();
    await signInAndSettle(outsiderPage, outsiderEmail, password, '/portal');
    expect((await outsiderPage.request.get(`/api/weekly-reports?relationId=${relation.id}`)).status()).toBe(403);
    expect((await outsiderPage.request.get(`/api/weekly-reports/${report.id}`)).status()).toBe(403);
    expect((await outsiderPage.request.patch(`/api/weekly-reports/${report.id}`, { data: { summary: 'Cross-user edit' } })).status()).toBe(403);

    const unrelatedMentorContext = await browser.newContext(); contexts.push(unrelatedMentorContext);
    const unrelatedMentorPage = await unrelatedMentorContext.newPage();
    await signInAndSettle(unrelatedMentorPage, unrelatedMentorEmail, password, '/mentor');
    expect((await unrelatedMentorPage.request.get(`/api/weekly-reports/${report.id}`)).status()).toBe(403);
    expect((await unrelatedMentorPage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'APPROVED' } })).status()).toBe(403);

    const adminContext = await browser.newContext(); contexts.push(adminContext);
    const adminPage = await adminContext.newPage();
    await signInAndSettle(adminPage, adminEmail, password, '/admin');
    expect((await adminPage.request.get(`/api/weekly-reports/${report.id}`)).status()).toBe(200);
    expect((await adminPage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'APPROVED' } })).status()).toBe(403);

    const mentorContext = await browser.newContext(); contexts.push(mentorContext);
    const mentorPage = await mentorContext.newPage();
    await signInAndSettle(mentorPage, mentorEmail, password, '/mentor');
    await mentorPage.goto(`/mentor/mentees/${relation.id}`);
    await expect(mentorPage.getByRole('tab', { name: /Overview/i })).toBeVisible();
    await mentorPage.getByRole('tab', { name: /Weekly reports/i }).click();
    await expect(mentorPage.getByTestId('weekly-reports-panel')).toBeVisible();
    expect((await mentorPage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'CHANGES_REQUESTED' } })).status()).toBe(400);
    expect((await mentorPage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'CHANGES_REQUESTED', mentorComment: 'Add the test result.' } })).status()).toBe(200);
    await expect.poll(async () => (await prisma.notification.findFirst({ where: { userId: mentee.id, type: 'weekly_report_review.changes' }, orderBy: { createdAt: 'desc' } }))?.id).toBeTruthy();
    expect((await menteePage.request.patch(`/api/weekly-reports/${report.id}`, { data: { summary: 'Built and tested the onboarding flow', status: 'SUBMITTED' } })).status()).toBe(200);
    await expect.poll(async () => prisma.weeklyReport.findUnique({ where: { id: report.id }, select: { mentorComment: true, reviewedById: true, reviewedAt: true } })).toEqual({ mentorComment: null, reviewedById: null, reviewedAt: null });
    const notificationCount = await prisma.notification.count({ where: { userId: mentee.id, type: { startsWith: 'weekly_report_review.' } } });
    const concurrent = await Promise.all([
      mentorPage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'APPROVED', mentorComment: 'Looks good.' } }),
      mentorPage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'APPROVED', mentorComment: 'Also looks good.' } }),
    ]);
    expect(concurrent.map((response) => response.status()).sort()).toEqual([200, 409]);
    await expect.poll(() => prisma.notification.count({ where: { userId: mentee.id, type: { startsWith: 'weekly_report_review.' } } })).toBe(notificationCount + 1);
    expect((await mentorPage.request.patch(`/api/weekly-reports/${report.id}`, { data: { status: 'CHANGES_REQUESTED', mentorComment: 'Too late' } })).status()).toBe(409);
    expect((await menteePage.request.patch(`/api/weekly-reports/${report.id}`, { data: { summary: 'Approved is immutable' } })).status()).toBe(409);
    const olderReport = await prisma.weeklyReport.create({ data: { orgId: org.id, relationId: relation.id, weekStart: addUtcWeeks(utcWeekStart(new Date()), -1), summary: 'Older diary entry', status: 'SUBMITTED' } });
    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    expect((await mentorPage.request.patch(`/api/weekly-reports/${olderReport.id}`, { data: { status: 'APPROVED' } })).status()).toBe(409);
    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { status: 'ACTIVE', completedAt: null } });
    await prisma.user.update({ where: { id: mentee.id }, data: { notificationPrefs: { weeklyReports: false } } });
    const reviewNotificationsBeforeOptOut = await prisma.notification.count({ where: { userId: mentee.id, type: { startsWith: 'weekly_report_review.' } } });
    expect((await mentorPage.request.patch(`/api/weekly-reports/${olderReport.id}`, { data: { status: 'APPROVED' } })).status()).toBe(200);
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: { startsWith: 'weekly_report_review.' } } })).toBe(reviewNotificationsBeforeOptOut);
    await prisma.user.update({ where: { id: mentee.id }, data: { notificationPrefs: { weeklyReports: true } } });
    const print = await mentorPage.request.get(`/weekly-reports/print?relationId=${relation.id}`);
    expect(print.status()).toBe(200);
    expect((await menteePage.request.get(`/weekly-reports/print?relationId=${relation.id}`)).status()).toBe(200);
    expect((await adminPage.request.get(`/weekly-reports/print?relationId=${relation.id}`)).status()).toBe(200);
    // React SSR separates adjacent JSX text expressions with the literal
    // `<!-- -->` marker (`Status<!-- -->: <!-- -->Approved`). Drop exactly that
    // marker before matching — this is assertion normalization on trusted
    // fixture output, not HTML sanitization (a comment-matching regex here
    // trips CodeQL's sanitization rules).
    const printHtml = (await print.text()).replaceAll('<!-- -->', '').replaceAll('<!---->', '');
    expect(printHtml).toContain('Built and tested the onboarding flow');
    expect(printHtml).toContain('Status: Approved');
    expect(printHtml.indexOf('Older diary entry')).toBeLessThan(printHtml.indexOf('Built and tested the onboarding flow'));
    expect(printHtml).not.toContain(outsiderEmail);
    expect((await outsiderPage.request.get(`/weekly-reports/print?relationId=${relation.id}`)).status()).toBe(404);
    const otherOrg = await prisma.organization.create({ data: { name: `Other weekly ${Date.now()}`, slug: `other-weekly-${Date.now()}` } });
    const otherOrgRelation = await prisma.mentorshipRelation.create({ data: { orgId: otherOrg.id, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
    await prisma.weeklyReport.create({ data: { orgId: otherOrg.id, relationId: otherOrgRelation.id, weekStart: utcWeekStart(new Date()), summary: 'Cross-org secret' } });
    expect((await adminPage.request.get(`/weekly-reports/print?relationId=${otherOrgRelation.id}`)).status()).toBe(404);
    await prisma.mentorshipRelation.delete({ where: { id: otherOrgRelation.id } });
    await prisma.organization.delete({ where: { id: otherOrg.id } });

    const olderRows = Array.from({ length: 51 }, (_, index) => ({
      orgId: org.id,
      relationId: relation.id,
      weekStart: addUtcWeeks(utcWeekStart(new Date()), -(index + 2)),
      summary: `Paginated report ${index + 1}`,
      status: 'APPROVED' as const,
    }));
    await prisma.weeklyReport.createMany({ data: olderRows });
    const firstHistoryPage = await (await menteePage.request.get(`/api/weekly-reports?relationId=${relation.id}&page=1&pageSize=20`)).json();
    const finalHistoryPage = await (await menteePage.request.get(`/api/weekly-reports?relationId=${relation.id}&page=3&pageSize=20`)).json();
    expect(firstHistoryPage).toMatchObject({ page: 1, pageSize: 20, total: 53, totalPages: 3, hasMore: true });
    expect(finalHistoryPage).toMatchObject({ page: 3, pageSize: 20, total: 53, totalPages: 3, hasMore: false });
    expect(finalHistoryPage.reports).toHaveLength(13);
    await menteePage.goto('/portal/goals');
    // Wait on the RESULT, never on the button's own state (#2343). "Load more"
    // is `{hasMore && <Button loading={loadingMore} …>}`, so it is disabled
    // while a page is in flight and unmounted the instant the last page lands.
    // A `while (isVisible) click()` loop races its own final iteration: the
    // locator resolves mid-load, the click waits for `loadingMore` to clear,
    // and the element detaches instead of becoming enabled — 15 seconds of
    // waiting with nothing actually wrong.
    //
    // Two clicks, because the API assertions above pin `totalPages: 3`. Each is
    // waited on by the arrival of the first row of the next page, and the
    // button has to be GONE at the end — which is the pagination behaviour the
    // old loop never actually asserted.
    const loadMore = menteePage.getByTestId('weekly-reports-load-more');
    const historyRows = menteePage.getByTestId('weekly-report-row');
    await expect(loadMore).toBeVisible();
    for (let page = 2; page <= 3; page += 1) {
      const seen = await historyRows.count();
      await loadMore.click();
      await expect(historyRows.nth(seen)).toBeVisible();
    }
    await expect(loadMore).toHaveCount(0);
    await expect(menteePage.getByText('Paginated report 51')).toBeVisible();

    const friday = new Date('2026-08-14T15:00:00Z');
    await prisma.weeklyReport.deleteMany({ where: { relationId: relation.id } });
    await prisma.user.update({ where: { id: mentee.id }, data: { notificationPrefs: { weeklyReports: false }, emailNotifications: true } });
    const remindersBeforeOptOut = await prisma.notification.count({ where: { userId: mentee.id, type: 'weekly_report_reminder.due' } });
    const first = await sendWeeklyReportReminders(friday);
    const rerun = await sendWeeklyReportReminders(friday);
    // `reminded` and `emailed` are INSTALLATION-wide counters: every other
    // relation at INTERNSHIP_IN_PROGRESS_450 is counted too — another spec's on
    // the shared CI database, or the demo seed on a developer's. Asserting
    // `toBe(1)` on them makes this test depend on being the only pair in the
    // database, which it is not promised to be. So the exact assertions are
    // scoped to THIS pair, and the counters are used only for the property that
    // really is global: a re-run in the same week reminds nobody new.
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    expect(await prisma.weeklyReportReminder.count({ where: { relationId: relation.id } })).toBe(1);
    // The opt-out is what is under test: this mentee has the weeklyReports
    // category off, so the sweep claims the week for them and sends neither the
    // bell item nor the mail.
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'weekly_report_reminder.due' } })).toBe(remindersBeforeOptOut);
    expect(rerun.reminded).toBe(0);

    const nextFriday = addUtcWeeks(friday, 1);
    await prisma.user.update({ where: { id: mentee.id }, data: { notificationPrefs: { weeklyReports: true }, emailNotifications: false } });
    const emailOff = await sendWeeklyReportReminders(nextFriday);
    // Scoped for the same reason as above: `emailed` counts the whole
    // installation. What this step is about is one mentee with the category on
    // and e-mail off — the bell item is written and no mail is attempted for
    // THEM, which EmailLog answers exactly (it records SKIPPED sends too, so
    // the absence of a row is the absence of an attempt).
    expect(emailOff.reminded).toBeGreaterThanOrEqual(1);
    expect((await prisma.notification.findFirst({ where: { userId: mentee.id, type: 'weekly_report_reminder.due' }, orderBy: { createdAt: 'desc' } }))?.id).toBeTruthy();
    expect(await prisma.emailLog.count({ where: { to: menteeEmail, category: 'weekly-report' } })).toBe(0);

    const emailOnFriday = addUtcWeeks(friday, 2);
    await prisma.user.update({ where: { id: mentee.id }, data: { emailNotifications: true } });
    const emailOn = await sendWeeklyReportReminders(emailOnFriday);
    expect(emailOn.reminded).toBeGreaterThanOrEqual(1);
    // …and with e-mail back on, exactly one goes to this mentee.
    expect(await prisma.emailLog.count({ where: { to: menteeEmail, category: 'weekly-report' } })).toBe(1);

    const submittedFriday = addUtcWeeks(friday, 3);
    await prisma.weeklyReport.create({ data: { orgId: org.id, relationId: relation.id, weekStart: utcWeekStart(submittedFriday), summary: 'Done', status: 'SUBMITTED' } });
    await sendWeeklyReportReminders(submittedFriday);
    // A submitted report suppresses the reminder — for THIS pair and THIS week,
    // which is the claim. The sweep's own counter cannot say that: it is the
    // whole installation, and any other in-progress relation is in it.
    expect(
      await prisma.weeklyReportReminder.count({
        where: { relationId: relation.id, weekStart: utcWeekStart(submittedFriday) },
      })
    ).toBe(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    if (relationId) await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
    await Promise.all([mentorEmail, menteeEmail, outsiderEmail, unrelatedMentorEmail, adminEmail].map((email) => cleanupByEmail(email).catch(() => {})));
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
});
