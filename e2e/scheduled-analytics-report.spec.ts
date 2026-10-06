import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { LEGACY_SEED_KEY, runReportSubscriptions } from '@/lib/jobs/reportSubscriptions';
import { prisma as appPrisma } from '@/lib/prisma';

// The weekly analytics report (Faz 2, #541) became a report subscription in
// #1905: `sendWeeklyAnalyticsReport()` is gone, and every admin who received
// the Monday mail is seeded a `pipeline-summary` subscription of their own.
// What this pins — what the old job promised and the migration must keep:
//   • only an org with ADVANCED_ANALYTICS is mailed (#1740, per org since #2680);
//   • each admin reads it in their own language (#2715);
//   • the per-user analytics-report opt-out still holds;
//   • nobody is mailed twice — not in the week of the swap, not on a re-run;
//   • an org is seeded once: a deleted subscription stays deleted, and an org
//     that gains the tier later is seeded then.
// Run in THIS process against its own orgs (SMTP is unset; the EmailLog row a
// skipped send still writes is what says who was mailed, under which subject).

test.afterAll(async () => {
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

const PW = 'WeeklyTenant123!';

/** Monday `weeks` from this one, 09:00 UTC — after the seeded subscriptions' 08:00. */
function mondayAt9(weeks: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + weeks * 7);
  return d;
}

const reportsTo = (email: string) => prisma.emailLog.findMany({ where: { to: email, category: 'analytics-report' }, select: { subject: true, status: true } });

test('the weekly report is a seeded subscription per admin of an entitled org (#1905)', async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const on = await prisma.organization.create({ data: { name: `Weekly On ${stamp}`, slug: `weekly-on-${stamp}`, brandName: `Weekly On ${stamp}` } });
  const off = await prisma.organization.create({ data: { name: `Weekly Off ${stamp}`, slug: `weekly-off-${stamp}` } });
  const trAdmin = uniqueEmail('wa-tr-admin');
  const quietAdmin = uniqueEmail('wa-quiet-admin');
  const offAdmin = uniqueEmail('wa-off-admin');
  const orgIds = [on.id, off.id];
  try {
    const tr = await seedUser(trAdmin, PW, 'ADMIN', 'Weekly TR Admin', on.id);
    await prisma.user.update({ where: { id: tr.id }, data: { preferredLanguage: 'tr' } });
    const quiet = await seedUser(quietAdmin, PW, 'ADMIN', 'Weekly Quiet Admin', on.id);
    await prisma.user.update({ where: { id: quiet.id }, data: { emailNotifications: false } });
    await seedUser(offAdmin, PW, 'ADMIN', 'Weekly Off Admin', off.id);
    await setOrgFeature(on.id, 'ADVANCED_ANALYTICS', true);

    // 1. The week of the swap: both admins of the entitled org are seeded, in
    //    their own language, and nothing goes out this week.
    const first = await runReportSubscriptions({ orgIds, now: mondayAt9(0) });
    expect(first.sent).toBe(0);
    const seeded = await prisma.reportSubscription.findMany({ where: { orgId: { in: orgIds } }, select: { recipientUserId: true, reportKey: true, locale: true, cadence: true } });
    expect(seeded).toHaveLength(2);
    expect(seeded.every((s) => s.reportKey === 'pipeline-summary' && s.cadence === 'WEEKLY')).toBe(true);
    expect(seeded.find((s) => s.recipientUserId === tr.id)?.locale).toBe('tr');
    expect(await prisma.setting.count({ where: { orgId: on.id, key: LEGACY_SEED_KEY } })).toBe(1);
    expect(await prisma.setting.count({ where: { orgId: off.id, key: LEGACY_SEED_KEY } })).toBe(0);

    // A re-run in the same week seeds nothing more and sends nothing.
    const again = await runReportSubscriptions({ orgIds, now: mondayAt9(0) });
    expect(again.sent).toBe(0);
    expect(await prisma.reportSubscription.count({ where: { orgId: { in: orgIds } } })).toBe(2);

    // 2. Next Monday: the Turkish admin gets it in Turkish, the opted-out one
    //    does not, the org without the tier gets nothing.
    const next = await runReportSubscriptions({ orgIds, now: mondayAt9(1) });
    expect(next).toMatchObject({ sent: 1, skipped: 1 });
    const trMail = await reportsTo(trAdmin);
    expect(trMail.map((m) => m.subject)).toEqual([`Pipeline özeti — Weekly On ${stamp}`]);
    expect(await reportsTo(quietAdmin)).toHaveLength(0);
    expect(await reportsTo(offAdmin)).toHaveLength(0);
    const quietSend = await prisma.reportSubscriptionSend.findFirst({ where: { subscription: { recipientUserId: quiet.id }, status: 'SKIPPED', error: 'opted_out' } });
    expect(quietSend).not.toBeNull();

    // 3. A subscription deleted by its admin stays deleted.
    await prisma.reportSubscription.deleteMany({ where: { recipientUserId: quiet.id } });
    await runReportSubscriptions({ orgIds, now: mondayAt9(2) });
    expect(await prisma.reportSubscription.count({ where: { recipientUserId: quiet.id } })).toBe(0);

    // 4. The org that gains the tier later is seeded then.
    await setOrgFeature(off.id, 'ADVANCED_ANALYTICS', true);
    await runReportSubscriptions({ orgIds, now: mondayAt9(2) });
    expect(await prisma.reportSubscription.count({ where: { orgId: off.id } })).toBe(1);
  } finally {
    await prisma.emailLog.deleteMany({ where: { to: { in: [trAdmin, quietAdmin, offAdmin] } } });
    for (const e of [trAdmin, quietAdmin, offAdmin]) await cleanupByEmail(e);
    await prisma.reportSubscription.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
});
