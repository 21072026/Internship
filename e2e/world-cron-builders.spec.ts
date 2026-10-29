import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import {
  __testable,
  checkRequisitionMatches,
  emailBrand,
  sendDailyActivityDigests,
  sendWeeklyMentorDigests,
} from '@/services/emailService';
import { getSystemMenteeActivity } from '@/lib/activityReport';
import { orgWhere } from '@/lib/tenantFilter';
import { tenantAdminIds } from '@/lib/tenantAdmins';
import { prisma as appPrisma } from '@/lib/prisma';
import { getDictionary } from '../src/i18n/dictionaries';
import { runReportSubscriptions } from '@/lib/jobs/reportSubscriptions';
import { loadReport } from '@/lib/reports/registry';
import { getReportDefinition } from '@/lib/reports/definitions';

/** Monday `weeks` from this one, 09:00 UTC — after the seeded subscriptions' 08:00. */
function mondayAt9(weeks: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + weeks * 7);
  return d;
}

/** Seed the weekly report for these orgs, then let the next Monday send it (#1905). */
async function weeklyReportFor(orgIds: string[]) {
  await runReportSubscriptions({ orgIds, now: mondayAt9(0) });
  return runReportSubscriptions({ orgIds, now: mondayAt9(1) });
}

// The scheduled mail builders and "whatever an action produces stays in its
// world" (docs/worlds.md): a cron sweeps every tenant with no session, so each
// digest, summary and alert must be scoped to — and branded for — the org it
// is about. Called in THIS process (as e2e/world-mail-sender.spec.ts does): the
// app server runs with SMTP blanked, and the EmailLog row a skipped send still
// writes is what says who was mailed and under which subject.

const { worldHeading, worldAccent } = __testable;

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
  intCompanyUser: uniqueEmail('wc-int-company'),
};
let mktOrgId = '';
let intOrgId = '';
const ids: Record<keyof typeof emails, string> = {} as Record<keyof typeof emails, string>;
let mktCompanyId = '';
let intCompanyId = '';
let overdueTodoId = '';
const todoTitle = `Cron overdue to-do ${STAMP}`;
const position = `Cron Position ${STAMP}`;

const logsTo = (to: string, category: string) =>
  prisma.emailLog.findMany({ where: { to, category }, select: { subject: true } });

// A synthetic brand colour for the MARKETING org: its mail wears its own accent.
const MKT_COLOR = '#0e7490';

test.beforeAll(async () => {
  mktOrgId = (
    await prisma.organization.create({
      data: { name: `World Cron MKT ${STAMP}`, slug: `world-cron-mkt-${STAMP}`, vertical: 'MARKETING', brandName: BRAND, brandColor: MKT_COLOR },
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

  // Both mentees are in the consenting talent pool and match both companies'
  // open position: the INTERNSHIP company may be alerted about its own tenant's
  // candidate only, the MARKETING company (no placements) about nobody.
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
        // An open requisition: the match job's one source since #1875.
        requisitions: { create: { orgId: mktOrgId, title: position, status: 'OPEN', openings: 1, filled: 0, requiredSkills: [] } },
      },
    })
  ).id;
  ids.mktCompanyUser = (await seedUser(emails.mktCompanyUser, PW, 'COMPANY', 'Cron Mkt Company User', mktOrgId)).id;
  await prisma.user.update({ where: { id: ids.mktCompanyUser }, data: { companyId: mktCompanyId } });
  intCompanyId = (
    await prisma.company.create({
      data: {
        name: `Cron Int Co ${STAMP}`,
        orgId: intOrgId,
        entitlements: { create: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
        // An open requisition: the match job's one source since #1875.
        requisitions: { create: { orgId: intOrgId, title: position, status: 'OPEN', openings: 1, filled: 0, requiredSkills: [] } },
      },
    })
  ).id;
  ids.intCompanyUser = (await seedUser(emails.intCompanyUser, PW, 'COMPANY', 'Cron Int Company User', intOrgId)).id;
  await prisma.user.update({ where: { id: ids.intCompanyUser }, data: { companyId: intCompanyId } });

  // A late to-do the rep gave their lead: the one thing a sales org still
  // hears about from the daily digest cron.
  overdueTodoId = (
    await prisma.projectTask.create({
      data: {
        title: todoTitle,
        assigneeId: ids.mktLead,
        createdById: ids.mktRep,
        dueDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.projectTask.deleteMany({ where: { id: overdueTodoId } });
  await prisma.companyNeedAlert.deleteMany({ where: { companyId: { in: [mktCompanyId, intCompanyId] } } });
  for (const email of Object.values(emails)) {
    await cleanupByEmail(email);
    await prisma.emailLog.deleteMany({ where: { to: email } });
  }
  await prisma.company.deleteMany({ where: { id: { in: [mktCompanyId, intCompanyId] } } });
  await prisma.setting.deleteMany({ where: { orgId: { in: [mktOrgId, intOrgId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [mktOrgId, intOrgId] } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test.describe('the header a pre-branding builder renders', () => {
  test('the default world keeps its markup; another world gets its own org header and accent', async () => {
    const legacy = '<h2 style="color:#2563eb;">Heading</h2>';
    const internship = await emailBrand(intOrgId);
    expect(worldHeading(internship, 'Heading', legacy)).toBe(legacy);
    expect(worldAccent(internship)).toBe('#2563eb');

    const marketing = await emailBrand(mktOrgId);
    const header = worldHeading(marketing, 'Heading', legacy);
    expect(header).toContain('Heading');
    expect(header).not.toBe(legacy);
    expect(header).toContain(MKT_COLOR);
    expect(worldAccent(marketing)).toBe(MKT_COLOR);
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
    // notifyAdminsPerOrg's recipients: that org's active admins, nobody else.
    expect(await tenantAdminIds(mktOrgId)).toEqual([ids.mktAdmin]);
  });

  test('an org without mentorship gets no mentee-activity digest, only its overdue to-dos', async () => {
    await sendDailyActivityDigests();
    // At least one: a parallel spec's full /api/cron run may send another.
    expect((await logsTo(emails.intAdmin, 'activity-digest')).length).toBeGreaterThanOrEqual(1);
    expect((await logsTo(emails.intMentor, 'activity-digest')).length).toBeGreaterThanOrEqual(1);
    const todoSubjects = (['en', 'tr', 'de'] as const).map(
      (l) => getDictionary(l).notifications.activityDigestEmail.todoSubject,
    );
    for (const who of [emails.mktAdmin, emails.mktRep]) {
      const rows = await logsTo(who, 'activity-digest');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) expect(todoSubjects).toContain(row.subject);
    }
  });

  test('the weekly mentoring summary is not sent to a sales rep', async () => {
    await sendWeeklyMentorDigests();
    expect((await logsTo(emails.intMentor, 'mentor-digest')).length).toBeGreaterThanOrEqual(1);
    expect(await logsTo(emails.mktRep, 'mentor-digest')).toHaveLength(0);
  });

  test("the weekly analytics report follows each org's own opt-in and names its own product", async () => {
    await setOrgFeature(mktOrgId, 'ADVANCED_ANALYTICS', true);
    await setOrgFeature(intOrgId, 'ADVANCED_ANALYTICS', false);
    await weeklyReportFor([mktOrgId, intOrgId]);
    const mkt = await logsTo(emails.mktAdmin, 'analytics-report');
    expect(mkt.length).toBeGreaterThanOrEqual(1);
    for (const row of mkt) expect(row.subject).toBe(`Pipeline summary — ${BRAND}`);
    expect(await logsTo(emails.intAdmin, 'analytics-report')).toHaveLength(0);
  });
});

test('an open-position alert names only its own tenant’s candidate, and an org without placements gets none', async () => {
  await checkRequisitionMatches();
  const alertedOf = async (companyId: string) =>
    (await prisma.companyNeedAlert.findMany({ where: { companyId }, select: { menteeId: true } })).map((a) => a.menteeId);
  const bellOf = async (userId: string) =>
    (
      await prisma.notification.findMany({ where: { userId, type: 'need_match.newCandidate' }, select: { link: true } })
    ).map((n) => n.link);

  expect(await alertedOf(intCompanyId)).toEqual([ids.intMentee]);
  expect(await bellOf(ids.intCompanyUser)).toEqual([`/p/${ids.intMentee}`]);

  expect(await alertedOf(mktCompanyId)).toEqual([]);
  expect(await bellOf(ids.mktCompanyUser)).toEqual([]);
  expect(await logsTo(emails.mktCompanyUser, 'company-need-alert')).toHaveLength(0);
});

// #2715: the report used to be English for every reader. The words now follow
// the recipient's own language, the stage table included — and a marketing
// funnel provisioned in English reads back in Turkish (#2710).
test('the weekly analytics report speaks its reader’s language, stage table included', async () => {
  const stamp = `${STAMP}-tr`;
  const org = await prisma.organization.create({
    data: { name: `World Cron TR ${stamp}`, slug: `world-cron-tr-${stamp}`, vertical: 'MARKETING', brandName: `TR Sales ${stamp}` },
  });
  const adminEmail = uniqueEmail('wc-tr-admin');
  const repEmail = uniqueEmail('wc-tr-rep');
  const leadEmail = uniqueEmail('wc-tr-lead');
  try {
    await prisma.pipelineStage.createMany({
      data: [
        { orgId: org.id, key: 'LEAD_NEW', label: 'New lead', order: 0 },
        { orgId: org.id, key: 'DEAL_PROPOSAL', label: 'Proposal sent', order: 1 },
      ],
    });
    const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Cron TR Admin', org.id);
    await prisma.user.update({ where: { id: admin.id }, data: { preferredLanguage: 'tr' } });
    const rep = await seedUser(repEmail, PW, 'MENTOR', 'Cron TR Rep', org.id);
    const lead = await seedUser(leadEmail, PW, 'MENTEE', 'Cron TR Lead', org.id);
    await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: rep.id, menteeId: lead.id, pipelineStatus: 'LEAD_NEW' } });
    await setOrgFeature(org.id, 'ADVANCED_ANALYTICS', true);

    const summary = getReportDefinition('pipeline-summary')!;
    const tr = (await loadReport(summary, { orgId: org.id, locale: 'tr' })).rows.map((r) => String(r.metric)).join(' | ');
    expect(tr).toContain('Yeni aday');
    expect(tr).not.toContain('New lead');
    expect((await loadReport(summary, { orgId: org.id, locale: 'de' })).rows.map((r) => String(r.metric)).join(' | ')).toContain('Neuer Lead');

    // The admin reads Turkish, so the seeded subscription does too.
    await weeklyReportFor([org.id]);
    const rows = await logsTo(adminEmail, 'analytics-report');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect(row.subject).toBe(`Pipeline özeti — TR Sales ${stamp}`);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const email of [adminEmail, repEmail, leadEmail]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.reportSubscription.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.setting.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
