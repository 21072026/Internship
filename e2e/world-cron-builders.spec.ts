import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import {
  __testable,
  checkCompanyNeedMatches,
  emailBrand,
  sendDailyActivityDigests,
  sendWeeklyAnalyticsReport,
  sendWeeklyMentorDigests,
} from '@/services/emailService';
import { getSystemMenteeActivity } from '@/lib/activityReport';
import { orgWhere } from '@/lib/tenantFilter';
import { setSetting } from '@/lib/settings';
import { prisma as appPrisma } from '@/lib/prisma';

// The scheduled mail builders and "whatever an action produces stays in its
// world" (docs/worlds.md): a cron sweeps every tenant with no session, so each
// digest, summary and alert must be scoped to — and branded for — the org it
// is about. Called in THIS process (as e2e/world-mail-sender.spec.ts does): the
// app server runs with SMTP blanked, and the EmailLog row a skipped send still
// writes is what says who was mailed and under which subject.

const { worldHeading, worldAccent, notifyOrgAdmins } = __testable;

const STAMP = `${Date.now()}-${Math.round(performance.now())}`;
const BRAND = `Cron Sales ${STAMP}`;
const PW = 'WorldCron123!';

const emails = {
  mktAdmin: uniqueEmail('wc-mkt-admin'),
  mktRep: uniqueEmail('wc-mkt-rep'),
  mktLead: uniqueEmail('wc-mkt-lead'),
  intAdmin: uniqueEmail('wc-int-admin'),
  intMentor: uniqueEmail('wc-int-mentor'),
  intMentee: uniqueEmail('wc-int-mentee'),
  mktCompanyUser: uniqueEmail('wc-mkt-company'),
};
let mktOrgId = '';
let intOrgId = '';
const ids: Record<keyof typeof emails, string> = {} as Record<keyof typeof emails, string>;
let mktCompanyId = '';
const position = `Cron Position ${STAMP}`;

const logsTo = (to: string, category: string) =>
  prisma.emailLog.findMany({ where: { to, category }, select: { subject: true } });

test.beforeAll(async () => {
  mktOrgId = (
    await prisma.organization.create({
      data: { name: `World Cron MKT ${STAMP}`, slug: `world-cron-mkt-${STAMP}`, vertical: 'MARKETING', brandName: BRAND },
    })
  ).id;
  intOrgId = (
    await prisma.organization.create({
      data: { name: `World Cron INT ${STAMP}`, slug: `world-cron-int-${STAMP}`, vertical: 'INTERNSHIP' },
    })
  ).id;
  ids.mktAdmin = (await seedUser(emails.mktAdmin, PW, 'ADMIN', 'Cron Mkt Admin', mktOrgId)).id;
  ids.mktRep = (await seedUser(emails.mktRep, PW, 'MENTOR', 'Cron Mkt Rep', mktOrgId)).id;
  ids.mktLead = (await seedUser(emails.mktLead, PW, 'MENTEE', 'Cron Mkt Lead', mktOrgId)).id;
  ids.intAdmin = (await seedUser(emails.intAdmin, PW, 'ADMIN', 'Cron Int Admin', intOrgId)).id;
  ids.intMentor = (await seedUser(emails.intMentor, PW, 'MENTOR', 'Cron Int Mentor', intOrgId)).id;
  ids.intMentee = (await seedUser(emails.intMentee, PW, 'MENTEE', 'Cron Int Mentee', intOrgId)).id;
  await prisma.mentorshipRelation.create({ data: { orgId: mktOrgId, mentorId: ids.mktRep, menteeId: ids.mktLead } });
  await prisma.mentorshipRelation.create({ data: { orgId: intOrgId, mentorId: ids.intMentor, menteeId: ids.intMentee } });

  // Both mentees are in the consenting talent pool and match the SaleVali
  // company's open position — only its own tenant's lead may be alerted.
  for (const id of [ids.mktLead, ids.intMentee]) {
    await prisma.user.update({
      where: { id },
      data: {
        targetPosition: position,
        publicProfile: true,
        consents: { create: { type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } },
      },
    });
  }
  mktCompanyId = (
    await prisma.company.create({
      data: {
        name: `Cron Mkt Co ${STAMP}`,
        orgId: mktOrgId,
        entitlements: { create: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
        needs: { create: { position, count: 1, period: '2026' } },
      },
    })
  ).id;
  ids.mktCompanyUser = (await seedUser(emails.mktCompanyUser, PW, 'COMPANY', 'Cron Mkt Company User', mktOrgId)).id;
  await prisma.user.update({ where: { id: ids.mktCompanyUser }, data: { companyId: mktCompanyId } });
});

test.afterAll(async () => {
  await prisma.companyNeedAlert.deleteMany({ where: { companyId: mktCompanyId } });
  for (const email of Object.values(emails)) {
    await cleanupByEmail(email);
    await prisma.emailLog.deleteMany({ where: { to: email } });
  }
  await prisma.company.deleteMany({ where: { id: mktCompanyId } });
  await prisma.setting.deleteMany({ where: { orgId: { in: [mktOrgId, intOrgId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [mktOrgId, intOrgId] } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test.describe('the header a pre-branding builder renders', () => {
  test('the default world keeps its markup; another world gets its org header, never the internship blue', async () => {
    const legacy = '<h2 style="color:#2563eb;">Heading</h2>';
    const internship = await emailBrand(intOrgId);
    expect(worldHeading(internship, 'Heading', legacy)).toBe(legacy);
    expect(worldAccent(internship)).toBe('#2563eb');

    const marketing = await emailBrand(mktOrgId);
    const header = worldHeading(marketing, 'Heading', legacy);
    expect(header).toContain('Heading');
    expect(header).not.toContain('#2563eb');
    expect(worldAccent(marketing)).not.toBe('#2563eb');
  });
});

test.describe('admin digests and summaries describe one org', () => {
  test("the admin activity table lists only that org's mentees", async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const intItems = await getSystemMenteeActivity(since, await orgWhere(intOrgId));
    expect(intItems.map((i) => i.menteeId)).toEqual([ids.intMentee]);
    const mktItems = await getSystemMenteeActivity(since, await orgWhere(mktOrgId));
    expect(mktItems.map((i) => i.menteeId)).toEqual([ids.mktLead]);
  });

  test("a cron summary reaches only the admins of the org it counted", async () => {
    const reached: string[] = [];
    await notifyOrgAdmins(new Map([[mktOrgId, 1]]), async (a) => {
      reached.push(a.id);
    });
    expect(reached).toEqual([ids.mktAdmin]);
  });

  test('the daily mentee-activity digest skips an org without mentorship, and a rep gets none either', async () => {
    await sendDailyActivityDigests();
    // At least one: a parallel spec's full /api/cron run may send another.
    expect((await logsTo(emails.intAdmin, 'activity-digest')).length).toBeGreaterThanOrEqual(1);
    expect((await logsTo(emails.intMentor, 'activity-digest')).length).toBeGreaterThanOrEqual(1);
    expect(await logsTo(emails.mktAdmin, 'activity-digest')).toHaveLength(0);
    expect(await logsTo(emails.mktRep, 'activity-digest')).toHaveLength(0);
  });

  test('the weekly mentoring summary is not sent to a sales rep', async () => {
    await sendWeeklyMentorDigests();
    expect((await logsTo(emails.intMentor, 'mentor-digest')).length).toBeGreaterThanOrEqual(1);
    expect(await logsTo(emails.mktRep, 'mentor-digest')).toHaveLength(0);
  });

  test("the weekly analytics report follows each org's own opt-in and names its own product", async () => {
    await setSetting('premiumAnalytics', 'true', mktOrgId);
    await setSetting('premiumAnalytics', 'false', intOrgId);
    await sendWeeklyAnalyticsReport();
    const mkt = await logsTo(emails.mktAdmin, 'analytics-report');
    expect(mkt.length).toBeGreaterThanOrEqual(1);
    for (const row of mkt) expect(row.subject).toBe(`Weekly analytics report — ${BRAND}`);
    expect(await logsTo(emails.intAdmin, 'analytics-report')).toHaveLength(0);
  });
});

test('an open-position alert names only a candidate of the company’s own tenant', async () => {
  await checkCompanyNeedMatches();
  const alerted = await prisma.companyNeedAlert.findMany({ where: { companyId: mktCompanyId }, select: { menteeId: true } });
  expect(alerted.map((a) => a.menteeId)).toEqual([ids.mktLead]);
  const bell = await prisma.notification.findMany({
    where: { userId: ids.mktCompanyUser, type: 'need_match.newCandidate' },
    select: { link: true },
  });
  expect(bell.map((n) => n.link)).toEqual([`/p/${ids.mktLead}`]);
});
