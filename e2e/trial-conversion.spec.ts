import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '@/lib/programTemplates';

/**
 * Trial → paid on /admin/analytics, and the transfer chain counted as ONE
 * journey (#2556).
 *
 * The fixture is the case the issue is about: a lead whose trial started, whose
 * account was handed to a new owner mid-trial (the predecessor closed as
 * ENDED_REASSIGNED, the successor opened on the SAME stage with the trial
 * window carried over — exactly what src/lib/mentorTransfer.ts writes), and
 * whose SUCCESSOR recorded the win. Read per relation, that trial month gains
 * two trials; folded, it gains one trial and one paid customer.
 *
 * Assertions on the month table are DELTAS: tenant isolation is off outside the
 * `isolation` project, so the funnel route reads every relation in the
 * database, and other specs' rows may sit in the same month. The source split
 * is exact, because the Source row is this spec's own.
 */

const PASSWORD = 'TrialKpi123!';
const DAY = 24 * 60 * 60 * 1000;

type TrialPayload = {
  trialKey: string;
  paidKey: string;
  months: { month: string; started: number; paid: number; rate: number | null; mature: boolean }[];
  bySource: { sourceId: string | null; trials: number; paid: number; rate: number | null }[] | null;
} | null;

test('a handover mid-trial is one trial and one paid customer, and the source split reads it', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Trial KPI ${stamp}`, slug: `trial-kpi-${stamp}`, vertical: 'MARKETING' },
  });
  const template = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(template).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  const source = await prisma.source.create({ data: { name: `Trial KPI source ${stamp}`, orgId: org.id } });

  const adminEmail = uniqueEmail('trialkpi-admin');
  const ownerAEmail = uniqueEmail('trialkpi-owner-a');
  const ownerBEmail = uniqueEmail('trialkpi-owner-b');
  const leadPaidEmail = uniqueEmail('trialkpi-lead-paid');
  const leadLostEmail = uniqueEmail('trialkpi-lead-lost');
  const emails = [adminEmail, ownerAEmail, ownerBEmail, leadPaidEmail, leadLostEmail];
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Trial Admin');
  const ownerA = await seedUser(ownerAEmail, PASSWORD, 'MENTOR', 'Owner A');
  const ownerB = await seedUser(ownerBEmail, PASSWORD, 'MENTOR', 'Owner B');
  const leadPaid = await seedUser(leadPaidEmail, PASSWORD, 'MENTEE', 'Lead Paid');
  const leadLost = await seedUser(leadLostEmail, PASSWORD, 'MENTEE', 'Lead Lost');
  await prisma.user.updateMany({
    where: { id: { in: [admin.id, ownerA.id, ownerB.id, leadPaid.id, leadLost.id] } },
    data: { orgId: org.id },
  });
  await prisma.user.updateMany({ where: { id: { in: [leadPaid.id, leadLost.id] } }, data: { sourceId: source.id } });

  // Three months back, so the month has closed and a 30-day trial started in
  // it has long run out: the cohort is mature and prints a rate.
  const now = new Date();
  const trialStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 3, 10));
  const month = trialStart.toISOString().slice(0, 7);
  const trialEnd = new Date(trialStart.getTime() + 30 * DAY);
  const trialWindow = { trialStartedAt: trialStart, trialEndsAt: trialEnd };
  const ids: string[] = [];
  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
    const read = async (): Promise<TrialPayload> =>
      (await (await page.request.get('/api/admin/analytics/funnel')).json()).trialConversion;

    const before = await read();
    expect(before, 'a MARKETING tenant with a trial stage gets the block').not.toBeNull();
    expect(before!.trialKey).toBe('TRIAL_ACTIVE');
    expect(before!.paidKey).toBe('DEAL_WON');
    const row = (p: TrialPayload) => p!.months.find((m) => m.month === month)!;
    const base = row(before);
    expect(base).toBeTruthy();

    // Lead 1 — the chain. The predecessor closed as ENDED_REASSIGNED ten days
    // into the trial; the successor opened on the same stage with the window
    // carried over, and recorded the win.
    const predecessor = await prisma.mentorshipRelation.create({
      data: {
        orgId: org.id,
        mentorId: ownerA.id,
        menteeId: leadPaid.id,
        pipelineStatus: 'TRIAL_ACTIVE',
        startDate: new Date(trialStart.getTime() - 5 * DAY),
        status: 'COMPLETED',
        lifecycleState: 'ENDED_REASSIGNED',
        completedAt: new Date(trialStart.getTime() + 10 * DAY),
        ...trialWindow,
      },
    });
    ids.push(predecessor.id);
    await prisma.statusChange.create({
      data: { relationId: predecessor.id, fromStatus: 'LEAD_NEW', toStatus: 'TRIAL_ACTIVE', changedById: ownerA.id, createdAt: trialStart },
    });
    const successor = await prisma.mentorshipRelation.create({
      data: {
        orgId: org.id,
        mentorId: ownerB.id,
        menteeId: leadPaid.id,
        pipelineStatus: 'DEAL_WON',
        startDate: new Date(trialStart.getTime() + 10 * DAY),
        previousRelationId: predecessor.id,
        ...trialWindow,
      },
    });
    ids.push(successor.id);
    await prisma.statusChange.create({
      data: {
        relationId: successor.id,
        fromStatus: 'TRIAL_ACTIVE',
        toStatus: 'DEAL_WON',
        changedById: ownerB.id,
        createdAt: new Date(trialStart.getTime() + 15 * DAY),
      },
    });

    // Lead 2 — a trial in the same month that expired unpaid.
    const lost = await prisma.mentorshipRelation.create({
      data: {
        orgId: org.id,
        mentorId: ownerA.id,
        menteeId: leadLost.id,
        pipelineStatus: 'TRIAL_EXPIRED',
        startDate: new Date(trialStart.getTime() - 3 * DAY),
        ...trialWindow,
      },
    });
    ids.push(lost.id);
    await prisma.statusChange.createMany({
      data: [
        { relationId: lost.id, fromStatus: 'LEAD_NEW', toStatus: 'TRIAL_ACTIVE', changedById: ownerA.id, createdAt: trialStart },
        // The expiry sweep's move, written with the system as actor (#2527).
        { relationId: lost.id, fromStatus: 'TRIAL_ACTIVE', toStatus: 'TRIAL_EXPIRED', changedById: null, createdAt: trialEnd },
      ],
    });

    const after = await read();
    const mine = row(after);
    // Two customers, two trials, one paid. Per relation it would read THREE
    // trials: the successor carries the trial start and was created in it.
    expect(mine.started - base.started).toBe(2);
    expect(mine.paid - base.paid).toBe(1);
    expect(mine.mature).toBe(true);
    expect(mine.rate).not.toBeNull();

    // Premium off → the attribution half is locked, not empty.
    expect(after!.bySource).toBeNull();
    expect((await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } })).ok()).toBeTruthy();
    const premium = await read();
    // Exact: the Source row is this spec's own.
    const bySource = premium!.bySource!.find((s) => s.sourceId === source.id);
    expect(bySource).toEqual({ sourceId: source.id, name: source.name, trials: 2, paid: 1, rate: 50 });

    await gotoSettled(page, '/admin/analytics');
    const card = page.getByTestId('trial-kpi-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId(`trial-kpi-${month}`)).toHaveAttribute('data-mature', 'true');
    await expect(card.getByTestId(`trial-source-${source.id}`)).toHaveText('50%');
    await expect(card.getByTestId('trial-kpi-history-note')).toBeVisible();
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await prisma.statusChange.deleteMany({ where: { relationId: { in: ids } } });
    // Successor first: it points at the predecessor.
    for (const id of [...ids].reverse()) await prisma.mentorshipRelation.deleteMany({ where: { id } });
    for (const email of emails) await cleanupByEmail(email);
    await prisma.source.delete({ where: { id: source.id } }).catch(() => {});
    await prisma.setting.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('a tenant without a trial stage gets no trial block and no card', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  // INTERNSHIP resolves to the canonical catalogue: no rows, no trial stage.
  const org = await prisma.organization.create({
    data: { name: `Trial KPI none ${stamp}`, slug: `trial-kpi-none-${stamp}`, vertical: 'INTERNSHIP' },
  });
  const adminEmail = uniqueEmail('trialkpi-none-admin');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'No Trial Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
    const body = await (await page.request.get('/api/admin/analytics/funnel')).json();
    expect(body.trialConversion).toBeNull();
    await gotoSettled(page, '/admin/analytics');
    await expect(page.getByTestId('cohort-kpi-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('trial-kpi-card')).toHaveCount(0);
  } finally {
    await cleanupByEmail(adminEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
