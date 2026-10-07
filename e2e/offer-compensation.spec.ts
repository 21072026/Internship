import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Structured compensation on offers (#1851): the write rules, the admin panel
// summary, and the benchmark read model with its <5 suppression. Visibility
// (COMPANY never receives a figure) is pinned in e2e/offers.spec.ts next to
// the compensationNote rule it extends.
test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'CompTestPass123!';

async function seedOrg(prefix: string) {
  const adminEmail = uniqueEmail(`${prefix}admin`);
  const mentorEmail = uniqueEmail(`${prefix}mentor`);
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Comp Admin');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Comp Mentor');
  const org = await prisma.organization.create({
    data: { name: `Comp Org ${Date.now()}`, slug: `comp-${Date.now()}-${Math.round(Math.random() * 10000)}` },
  });
  await prisma.user.updateMany({ where: { id: { in: [admin.id, mentor.id] } }, data: { orgId: org.id } });
  const company = await prisma.company.create({ data: { name: `Comp Co ${Date.now()}`, orgId: org.id } });
  const menteeEmails: string[] = [];
  const relations: { id: string; menteeId: string }[] = [];
  // One mentee per relation: an offer hangs off a relation, and the benchmark
  // wants several accepted offers for one title.
  const mentee = async (n: number) => {
    const email = uniqueEmail(`${prefix}mentee${n}`);
    menteeEmails.push(email);
    const user = await seedUser(email, PW, 'MENTEE', `Comp Mentee ${n}`);
    await prisma.user.update({ where: { id: user.id }, data: { orgId: org.id }, select: { id: true } });
    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: user.id, companyId: company.id, orgId: org.id },
      select: { id: true, menteeId: true },
    });
    relations.push(relation);
    return { email, user, relation };
  };
  return {
    adminEmail,
    admin,
    org,
    company,
    mentee,
    relations,
    cleanup: async () => {
      const offers = await prisma.offer.findMany({ where: { orgId: org.id }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: offers.map((o) => o.id) } } });
      await prisma.offer.deleteMany({ where: { orgId: org.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
      await prisma.company.deleteMany({ where: { orgId: org.id } });
      for (const email of menteeEmails) await cleanupByEmail(email);
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(adminEmail);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    },
  };
}

test('an offer carries structured pay in minor units; an amount without a currency or period is refused', async ({ page }) => {
  const s = await seedOrg('cw');
  try {
    const { relation, user: mentee } = await s.mentee(1);
    await signInAndSettle(page, s.adminEmail, PW, '/admin');

    // The rule from src/lib/compensation.ts, enforced at the route.
    const noCurrency = await page.request.post('/api/offers', {
      data: { relationId: relation.id, position: 'Backend Engineer', baseAmountMinor: 300_000, basePeriod: 'MONTHLY' },
    });
    expect(noCurrency.status()).toBe(400);
    expect((await noCurrency.json()).code).toBe('currency_required');
    const noPeriod = await page.request.post('/api/offers', {
      data: { relationId: relation.id, position: 'Backend Engineer', baseAmountMinor: 300_000, currency: 'EUR' },
    });
    expect(noPeriod.status()).toBe(400);
    expect((await noPeriod.json()).code).toBe('period_required');
    const badCurrency = await page.request.post('/api/offers', {
      data: { relationId: relation.id, position: 'Backend Engineer', baseAmountMinor: 300_000, currency: 'JPY', basePeriod: 'MONTHLY' },
    });
    expect(badCurrency.status()).toBe(400);

    const created = await page.request.post('/api/offers', {
      data: {
        relationId: relation.id,
        position: 'Backend Engineer',
        currency: 'eur',
        baseAmountMinor: 320_000,
        basePeriod: 'MONTHLY',
        hoursPerWeek: 38,
        contractType: 'FIXED_TERM',
        signingBonusMinor: 50_000,
        equityNote: 'none',
        compensationNote: 'Plus a laptop.',
      },
    });
    expect(created.status()).toBe(201);
    const offer = (await created.json()).offer;
    expect(offer.currency).toBe('EUR');
    expect(offer.baseAmountMinor).toBe(320_000);
    expect(offer.contractType).toBe('FIXED_TERM');

    // A PATCH is validated as the MERGED set: clearing the period while the
    // amount stays would leave the amount meaningless.
    const clearPeriod = await page.request.patch(`/api/offers/${offer.id}`, { data: { basePeriod: null } });
    expect(clearPeriod.status()).toBe(400);
    expect((await clearPeriod.json()).code).toBe('period_required');
    const edit = await page.request.patch(`/api/offers/${offer.id}`, { data: { baseAmountMinor: 330_000, otherBonusMinor: 10_000 } });
    expect(edit.status()).toBe(200);
    expect((await edit.json()).offer.baseAmountMinor).toBe(330_000);
    const stored = await prisma.offer.findUnique({ where: { id: offer.id }, select: { baseAmountMinor: true, otherBonusMinor: true, basePeriod: true } });
    expect(stored).toEqual({ baseAmountMinor: 330_000, otherBonusMinor: 10_000, basePeriod: 'MONTHLY' });

    // The admin panel on the candidate page renders the figures.
    await page.goto(`/admin/candidates/${mentee.id}`);
    const summary = page.getByTestId(`offer-compensation-${offer.id}`);
    await expect(summary).toBeVisible({ timeout: 20_000 });
    await expect(summary).toContainText('€3,300.00');
    await expect(summary).toContainText('per month');
    await expect(summary).toContainText('Fixed term');
    await expect(summary).toContainText('Signing bonus €500.00');
  } finally {
    await s.cleanup();
  }
});

test('the wizard saves typed amounts as minor units', async ({ page }) => {
  const s = await seedOrg('wz');
  try {
    const { user: mentee } = await s.mentee(1);
    await signInAndSettle(page, s.adminEmail, PW, '/admin');
    await page.goto(`/admin/candidates/${mentee.id}`);
    await page.getByTestId('offer-create-button').click();
    const modal = page.getByTestId('offer-wizard-modal');
    await modal.getByLabel('Position').fill('Wizard Engineer');
    await modal.getByRole('button', { name: 'Next' }).click();
    await modal.getByTestId('offer-currency').selectOption('EUR');
    await modal.getByTestId('offer-base-amount').fill('2.500,50');
    await modal.getByTestId('offer-base-period').selectOption('MONTHLY');
    await modal.getByTestId('offer-hours-per-week').fill('40');
    await modal.getByTestId('offer-contract-type').selectOption('INTERNSHIP');
    await modal.getByTestId('offer-signing-bonus').fill('1,000.00');
    await modal.getByRole('button', { name: 'Next' }).click();
    const preview = modal.getByTestId('offer-wizard-compensation-preview');
    await expect(preview).toContainText('€2,500.50');
    await expect(preview).toContainText('Internship');
    await modal.getByRole('button', { name: 'Save as draft' }).click();
    await expect(modal).toBeHidden({ timeout: 15_000 });

    const offer = await prisma.offer.findFirst({ where: { orgId: s.org.id, position: 'Wizard Engineer' } });
    expect(offer).not.toBeNull();
    expect(offer!.currency).toBe('EUR');
    expect(offer!.baseAmountMinor).toBe(250_050);
    expect(offer!.signingBonusMinor).toBe(100_000);
    expect(offer!.hoursPerWeek).toBe(40);
    expect(offer!.contractType).toBe('INTERNSHIP');
  } finally {
    await s.cleanup();
  }
});

test('the benchmark reports median/p25/p75 per position and currency, suppresses buckets under five, and is admin-only', async ({ page }) => {
  const s = await seedOrg('bm');
  try {
    // Five accepted "Frontend Developer" offers in EUR with mixed periods —
    // all normalise to a month: 4000, 4200, 4400, 4600, 4800 €.
    const monthly = [400_000, 420_000, 440_000, 460_000, 480_000];
    const shapes = [
      { basePeriod: 'MONTHLY', baseAmountMinor: monthly[0], hoursPerWeek: null },
      { basePeriod: 'YEARLY', baseAmountMinor: monthly[1] * 12, hoursPerWeek: null },
      // 4400 €/month = 25.3846…/h × 40 × 52 ÷ 12 → stored as 2538 minor → 440 253; use a round one
      { basePeriod: 'HOURLY', baseAmountMinor: 3_000, hoursPerWeek: 40 }, // 3000×40×52/12 = 520 000
      { basePeriod: 'MONTHLY', baseAmountMinor: monthly[3], hoursPerWeek: null },
      { basePeriod: 'MONTHLY', baseAmountMinor: monthly[4], hoursPerWeek: null },
    ];
    for (let i = 0; i < shapes.length; i++) {
      const { relation } = await s.mentee(i + 1);
      await prisma.offer.create({
        data: {
          orgId: s.org.id,
          relationId: relation.id,
          companyId: s.company.id,
          status: 'ACCEPTED',
          position: i % 2 ? 'frontend developer' : 'Frontend Developer ',
          currency: 'EUR',
          contractType: i < 3 ? 'PERMANENT' : 'FIXED_TERM',
          ...shapes[i],
          sentAt: new Date(),
          decidedAt: new Date(),
          createdById: s.admin.id,
        },
      });
    }
    // Two accepted "Data Analyst" offers: a real bucket, but suppressed.
    for (let i = 0; i < 2; i++) {
      const { relation } = await s.mentee(10 + i);
      await prisma.offer.create({
        data: {
          orgId: s.org.id, relationId: relation.id, companyId: s.company.id, status: 'ACCEPTED', position: 'Data Analyst',
          currency: 'EUR', baseAmountMinor: 380_000, basePeriod: 'MONTHLY', sentAt: new Date(), decidedAt: new Date(), createdById: s.admin.id,
        },
      });
    }
    // Noise that must not count: a DECLINED offer, an hourly rate without hours.
    const { relation: declinedRel } = await s.mentee(20);
    await prisma.offer.create({
      data: {
        orgId: s.org.id, relationId: declinedRel.id, companyId: s.company.id, status: 'DECLINED', position: 'Frontend Developer',
        currency: 'EUR', baseAmountMinor: 9_900_000, basePeriod: 'MONTHLY', sentAt: new Date(), decidedAt: new Date(), declineReasonCode: 'OTHER', createdById: s.admin.id,
      },
    });
    const { relation: noHoursRel } = await s.mentee(21);
    await prisma.offer.create({
      data: {
        orgId: s.org.id, relationId: noHoursRel.id, companyId: s.company.id, status: 'ACCEPTED', position: 'Frontend Developer',
        currency: 'EUR', baseAmountMinor: 9_900, basePeriod: 'HOURLY', hoursPerWeek: null, sentAt: new Date(), decidedAt: new Date(), createdById: s.admin.id,
      },
    });

    await signInAndSettle(page, s.adminEmail, PW, '/admin');
    const res = await page.request.get('/api/admin/offers/benchmark');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.minBucket).toBe(5);
    expect(body.measured).toBe(7);
    const fe = body.buckets.find((b: { position: string; currency: string }) => b.position === 'frontend developer' && b.currency === 'EUR');
    expect(fe).toBeTruthy();
    expect(fe.count).toBe(5);
    expect(fe.suppressed).toBe(false);
    // sorted: 400000, 420000, 460000, 480000, 520000
    expect(fe.medianMonthlyMinor).toBe(460_000);
    expect(fe.p25MonthlyMinor).toBe(420_000);
    expect(fe.p75MonthlyMinor).toBe(480_000);
    const da = body.buckets.find((b: { position: string }) => b.position === 'data analyst');
    expect(da).toBeTruthy();
    expect(da.count).toBe(2);
    expect(da.suppressed).toBe(true);
    expect(da.medianMonthlyMinor).toBeNull();
    expect(da.p25MonthlyMinor).toBeNull();
    expect(da.p75MonthlyMinor).toBeNull();
    // The declined 99 000 € figure appears nowhere.
    expect(JSON.stringify(body)).not.toContain('9900000');

    // Split by contract type: 3 PERMANENT + 2 FIXED_TERM — both under five now.
    const split = await page.request.get('/api/admin/offers/benchmark?by=contractType');
    const splitBody = await split.json();
    const permanent = splitBody.buckets.find((b: { position: string; contractType: string | null }) => b.position === 'frontend developer' && b.contractType === 'PERMANENT');
    expect(permanent.count).toBe(3);
    expect(permanent.suppressed).toBe(true);

    // The card on /admin/offers shows both rows, one of them as "fewer than 5".
    await page.goto('/admin/offers');
    await page.getByTestId('offer-benchmark-toggle').click();
    const table = page.getByTestId('offer-benchmark-table');
    await expect(table).toBeVisible({ timeout: 20_000 });
    await expect(table.getByTestId('offer-benchmark-row-frontend-developer-EUR')).toContainText('€4,600.00');
    await expect(table.getByTestId('offer-benchmark-row-data-analyst-EUR').getByTestId('offer-benchmark-suppressed')).toContainText('Fewer than 5 offers');

    // Not for anyone but ADMIN.
    const { email: menteeEmail } = await s.mentee(30);
    await signInAndSettle(page, menteeEmail, PW, '/portal');
    const forbidden = await page.request.get('/api/admin/offers/benchmark');
    expect(forbidden.status()).toBe(403);
  } finally {
    await s.cleanup();
  }
});
