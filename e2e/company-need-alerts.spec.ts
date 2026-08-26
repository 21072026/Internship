import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import bcrypt from 'bcryptjs';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Premium Faz 1 (#530): the daily cron alerts a premium company (holding the
// COMPANY_NEED_MATCH_ALERTS entitlement) when a consenting candidate matches
// one of its open positions — once per candidate (deduped), and never for a
// company without the entitlement. Driven through the admin /api/cron endpoint.
test('need-match alerts fire once for premium companies only, on consenting candidates', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const adminEmail = uniqueEmail('need-admin');
  const premiumUserEmail = uniqueEmail('need-premium-user');
  const freeUserEmail = uniqueEmail('need-free-user');
  const reqUserEmail = uniqueEmail('need-req-user');
  const menteeEmail = uniqueEmail('need-mentee');
  const pw = 'NeedAlertPass123';
  const position = `Backend Developer ${stamp}`;

  // Scope the notification count to THIS candidate via the link (`/p/<id>`,
  // unique per candidate). Counting by (user, type) alone passes only on an
  // empty database: any other consenting mentee whose targetPosition
  // substring-matches the seeded position — the demo data set has one — also
  // alerts this company, and the count silently becomes 2.
  const alertsAbout = (userId: string, menteeId: string) =>
    prisma.notification.count({ where: { userId, type: 'need_match.newCandidate', link: `/p/${menteeId}` } });

  await seedUser(adminEmail, pw, 'ADMIN', 'Need Admin');
  const hash = await bcrypt.hash(pw, 10);

  const premiumCo = await prisma.company.create({
    data: {
      name: `Premium Need Co ${stamp}`,
      entitlements: { create: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
      needs: { create: { position, count: 1, period: '2026' } },
    },
  });
  const freeCo = await prisma.company.create({
    data: {
      name: `Free Need Co ${stamp}`,
      needs: { create: { position, count: 1, period: '2026' } },
    },
  });

  // #1387: a premium company whose only open role lives in Requisition, with no
  // CompanyNeed row at all. Before the fix the job never queried Requisition, so
  // this company matched nobody. Requisition.orgId is non-null while
  // Company.orgId is nullable, so the org has to exist first.
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  const reqCo = await prisma.company.create({
    data: {
      name: `Requisition Need Co ${stamp}`,
      orgId: org.id,
      entitlements: { create: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
      requisitions: {
        create: { orgId: org.id, title: position, status: 'OPEN', openings: 1, filled: 0, requiredSkills: [] },
      },
    },
  });
  // Negative cases, both premium and both with no CompanyNeed: an unpublished
  // role must not alert, and neither must a role that is open on paper but
  // already fully staffed.
  const draftCo = await prisma.company.create({
    data: {
      name: `Draft Need Co ${stamp}`,
      orgId: org.id,
      entitlements: { create: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
      requisitions: {
        create: { orgId: org.id, title: position, status: 'DRAFT', openings: 1, filled: 0, requiredSkills: [] },
      },
    },
  });
  const filledCo = await prisma.company.create({
    data: {
      name: `Filled Need Co ${stamp}`,
      orgId: org.id,
      entitlements: { create: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
      requisitions: {
        create: { orgId: org.id, title: position, status: 'OPEN', openings: 2, filled: 2, requiredSkills: [] },
      },
    },
  });
  const premiumUser = await prisma.user.create({
    data: { email: premiumUserEmail, password: hash, role: 'COMPANY', fullName: 'Premium Co User', skills: [], companyId: premiumCo.id },
  });
  await prisma.user.create({
    data: { email: freeUserEmail, password: hash, role: 'COMPANY', fullName: 'Free Co User', skills: [], companyId: freeCo.id },
  });
  const reqUser = await prisma.user.create({
    data: { email: reqUserEmail, password: hash, role: 'COMPANY', fullName: 'Requisition Co User', skills: [], companyId: reqCo.id },
  });

  // A consenting mentee (publicProfile + TALENT_POOL_VISIBILITY, #527) whose
  // target position matches the need.
  const mentee = await prisma.user.create({
    data: {
      email: menteeEmail, password: hash, role: 'MENTEE', fullName: 'Matching Mentee', skills: [],
      targetPosition: position, publicProfile: true,
      consents: { create: { type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } },
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const run1 = await page.request.get('/api/cron');
    expect(run1.ok()).toBeTruthy();

    // Premium company: alert row + in-app notification created exactly once.
    await expect
      .poll(async () => prisma.companyNeedAlert.count({ where: { companyId: premiumCo.id, menteeId: mentee.id } }), { timeout: 10_000 })
      .toBe(1);
    expect(await alertsAbout(premiumUser.id, mentee.id)).toBe(1);

    // Free company: no entitlement → no alert.
    expect(await prisma.companyNeedAlert.count({ where: { companyId: freeCo.id } })).toBe(0);

    // #1387: the requisition-only premium company is alerted too. This is the
    // assertion that fails on the old job, which queried CompanyNeed only.
    await expect
      .poll(async () => prisma.companyNeedAlert.count({ where: { companyId: reqCo.id, menteeId: mentee.id } }), { timeout: 10_000 })
      .toBe(1);
    expect(await alertsAbout(reqUser.id, mentee.id)).toBe(1);

    // …but only for a role that is actually hiring: DRAFT is unpublished, and
    // an OPEN requisition with filled === openings has nobody to hire.
    expect(await prisma.companyNeedAlert.count({ where: { companyId: draftCo.id } })).toBe(0);
    expect(await prisma.companyNeedAlert.count({ where: { companyId: filledCo.id } })).toBe(0);

    // Running again does not re-alert (deduped).
    const run2 = await page.request.get('/api/cron');
    expect(run2.ok()).toBeTruthy();
    expect(await prisma.companyNeedAlert.count({ where: { companyId: premiumCo.id, menteeId: mentee.id } })).toBe(1);
    expect(await alertsAbout(premiumUser.id, mentee.id)).toBe(1);
    // The dedupe key is [companyId, menteeId], so it holds across the new
    // source too — a second source must not mean a second alert.
    expect(await prisma.companyNeedAlert.count({ where: { companyId: reqCo.id, menteeId: mentee.id } })).toBe(1);
  } finally {
    const companyIds = [premiumCo.id, freeCo.id, reqCo.id, draftCo.id, filledCo.id];
    await prisma.notification.deleteMany({ where: { userId: { in: [premiumUser.id, reqUser.id] } } });
    await prisma.companyNeedAlert.deleteMany({ where: { menteeId: mentee.id } });
    await prisma.companyNeed.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.requisition.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.companyEntitlement.deleteMany({ where: { companyId: { in: companyIds } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(premiumUserEmail);
    await cleanupByEmail(freeUserEmail);
    await cleanupByEmail(reqUserEmail);
    await cleanupByEmail(adminEmail);
    for (const id of companyIds) await prisma.company.delete({ where: { id } }).catch(() => {});
  }
});
