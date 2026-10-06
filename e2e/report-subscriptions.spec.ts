import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { makeReportUnsubscribeToken } from '../src/lib/reportSubscriptionTokens';

// Scheduled report delivery (#1905): subscribe → test-send → the scheduled run
// (once per period, however often it fires) → unsubscribe from the mail with no
// account → nothing more. SMTP is unset in CI, so sendEmail writes the EmailLog
// row (SKIPPED/FAILED) without delivering — the ledger is what "was it sent,
// and with which subject" is read from. Its own organization, so the gates it
// toggles cannot race the analytics specs on the default org.

const PW = 'Subscribe123!';

test.describe('report subscriptions', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('rs-admin');
  const mentor = uniqueEmail('rs-mentor');
  const mentee = uniqueEmail('rs-mentee');
  const dean = `rs-dean-${stamp}@example.com`;
  let orgId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `RS Org ${stamp}`, slug: `rs-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `RS Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `RS Mentor ${stamp}`, orgId);
    const e = await seedUser(mentee, PW, 'MENTEE', `RS Mentee ${stamp}`, orgId);
    await prisma.mentorshipRelation.create({ data: { orgId, mentorId: m.id, menteeId: e.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' } });
  });

  test.afterAll(async () => {
    await prisma.emailLog.deleteMany({ where: { to: { in: [admin, dean] } } });
    await prisma.reportSubscription.deleteMany({ where: { orgId } });
    await prisma.orgEntitlement.deleteMany({ where: { orgId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, mentee]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('subscribe, test-send, one send per period, unsubscribe without an account', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const now = new Date();
    const weekday = ((now.getUTCDay() + 6) % 7) + 1;
    const body = { reportKey: 'pipeline-funnel', cadence: 'WEEKLY', dayOfWeek: weekday, hour: 0, locale: 'de', format: 'EMAIL_SUMMARY', recipientEmail: dean, recipientName: 'Dekanin Test' };

    // Premium: no ADVANCED_ANALYTICS, no subscriptions.
    const locked = await page.request.post('/api/admin/report-subscriptions', { data: body });
    expect(locked.status()).toBe(403);
    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);

    // An unknown report is refused when written, not when sent.
    const unknown = await page.request.post('/api/admin/report-subscriptions', { data: { ...body, reportKey: 'everything' } });
    expect(unknown.status()).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: 'unknown_report' });
    // A file needs REPORT_EXPORT on top.
    const file = await page.request.post('/api/admin/report-subscriptions', { data: { ...body, format: 'XLSX' } });
    expect(file.status()).toBe(403);

    const created = await page.request.post('/api/admin/report-subscriptions', { data: body });
    expect(created.status()).toBe(201);
    const sub = (await created.json()).subscription as { id: string };

    // Send me a test: the recipient's language, mailed to the admin.
    const testSend = await page.request.post(`/api/admin/report-subscriptions/${sub.id}/test`);
    expect(await testSend.json()).toMatchObject({ outcome: 'SENT' });
    const testLog = await prisma.emailLog.findFirst({ where: { to: admin, category: 'analytics-report' }, orderBy: { createdAt: 'desc' } });
    expect(testLog?.subject).toMatch(/^\[Test\] Pipeline-Trichter — /);
    expect(testLog?.subject).not.toMatch(/_\d{3}\b/); // no raw stage key anywhere

    // The scheduled run: due today, sent once; a second firing in the same
    // period sends nothing.
    const run = async () => (await (await page.request.get('/api/cron?job=report-subscriptions')).json()).reportSubscriptions;
    expect(await run()).toMatchObject({ due: 1, sent: 1, duplicate: 0 });
    expect(await run()).toMatchObject({ due: 1, sent: 0, duplicate: 1 });
    expect(await prisma.emailLog.count({ where: { to: dean, category: 'analytics-report' } })).toBe(1);

    const listed = await (await page.request.get('/api/admin/report-subscriptions')).json();
    const history = listed.subscriptions.find((s: { id: string }) => s.id === sub.id).sends as { periodKey: string; status: string }[];
    expect(history.map((h) => h.status)).toEqual(['SENT', 'SENT']);
    expect(history.some((h) => h.periodKey.startsWith('test-'))).toBe(true);

    // The dean leaves from the mail: a public page, no session, one POST.
    const anon = await page.context().browser()!.newContext();
    const dpage = await anon.newPage();
    await dpage.goto(`/reports/unsubscribe?token=${encodeURIComponent(makeReportUnsubscribeToken(sub.id))}`);
    await dpage.getByTestId('report-unsub').click();
    await expect(dpage.getByTestId('report-unsub-done')).toBeVisible();
    await anon.close();
    expect((await prisma.reportSubscription.findUnique({ where: { id: sub.id } }))?.isActive).toBe(false);

    // A forged token does nothing.
    const forged = await page.request.post('/api/report-subscriptions/unsubscribe', { data: { token: `${sub.id}.deadbeef` } });
    expect(forged.status()).toBe(400);

    // Next period: an inactive subscription is not due at all.
    const next = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    const later = (await (await page.request.get(`/api/cron?job=report-subscriptions&at=${next}`)).json()).reportSubscriptions;
    expect(later.due).toBe(0);
    expect(await prisma.emailLog.count({ where: { to: dean, category: 'analytics-report' } })).toBe(1);
  });

  test('a user recipient from another tenant is refused; a mentor cannot manage subscriptions', async ({ page }) => {
    const outsider = await prisma.user.findFirst({ where: { NOT: { orgId } }, select: { id: true } });
    await signInAndSettle(page, admin, PW, '/admin');
    if (outsider) {
      const res = await page.request.post('/api/admin/report-subscriptions', {
        data: { reportKey: 'pipeline-funnel', cadence: 'MONTHLY', dayOfMonth: 1, hour: 6, locale: 'en', format: 'EMAIL_SUMMARY', recipientUserId: outsider.id },
      });
      expect(res.status()).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'unknown_recipient' });
    }
    await page.context().clearCookies();
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/report-subscriptions')).status()).toBe(401);
  });
});
