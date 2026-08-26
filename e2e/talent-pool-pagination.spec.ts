import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * #1392 — the talent-pool search returned silently incomplete results.
 *
 * The endpoint read `take: 60` from the database and only THEN applied the
 * skill filter in JS, so a skill held by nobody in the 60 most recently updated
 * mentees simply did not exist as far as the search was concerned. Worse, the
 * response carried no total, so nothing on screen could hint the answer was
 * partial: an empty grid and "there is nobody" look identical.
 *
 * Seeding is done directly rather than through `seedUser` per row: 65 users via
 * createMany plus one consent createMany is two statements instead of ~130, and
 * teardown is by id rather than 65 sequential lookups.
 */

const PW = 'TalentPage123';
const OLD_LIMIT = 60;

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a skill held only outside the old 60-row window is still found', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const companyEmail = uniqueEmail('tp-page-co');
  const rareSkill = `Fortran${stamp}`;
  const marker = `TPPager${stamp}`;

  const company = await prisma.company.create({
    data: {
      name: `Talent Pager Co ${stamp}`,
      entitlements: { create: { feature: 'TALENT_POOL_SEARCH' } },
    },
  });
  await prisma.user.create({
    data: {
      email: companyEmail, password: await bcrypt.hash(PW, 10), role: 'COMPANY',
      fullName: 'Talent Pager Observer', companyId: company.id, skills: [],
    },
  });

  // 65 consenting public mentees. The FIRST one created is the least recently
  // updated, so it sits outside the old `take: 60` window — it is the one
  // holding the rare skill.
  const hash = await bcrypt.hash(PW, 10);
  const emails = Array.from({ length: OLD_LIMIT + 5 }, (_, i) => `tp-page-${stamp}-${i}@e2e.local`);
  for (const [i, email] of emails.entries()) {
    await prisma.user.create({
      data: {
        email, password: hash, role: 'MENTEE', fullName: `${marker} ${i}`,
        publicProfile: true,
        skills: i === 0 ? [rareSkill] : ['CommonSkill'],
        consents: { create: { type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } },
      },
    });
  }

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', companyEmail);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });

    // THE regression: on the old code this returns 0 candidates, because the
    // only holder of the skill was cut off by `take: 60` before the filter ran.
    const rare = await page.request.get(
      `/api/company/talent-pool?q=${encodeURIComponent(marker)}&skill=${encodeURIComponent(rareSkill)}`
    );
    expect(rare.status()).toBe(200);
    const rareBody = await rare.json();
    expect(rareBody.total).toBe(1);
    expect(rareBody.candidates).toHaveLength(1);
    expect(rareBody.candidates[0].fullName).toBe(`${marker} 0`);

    // The count is of the whole matching set, not of the page — the number that
    // used to be missing entirely.
    const firstPage = await page.request.get(
      `/api/company/talent-pool?q=${encodeURIComponent(marker)}&pageSize=10&page=1`
    );
    const first = await firstPage.json();
    expect(first.total).toBe(OLD_LIMIT + 5);
    expect(first.candidates).toHaveLength(10);
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(10);

    // Pages do not overlap.
    const secondPage = await page.request.get(
      `/api/company/talent-pool?q=${encodeURIComponent(marker)}&pageSize=10&page=2`
    );
    const second = await secondPage.json();
    expect(second.candidates).toHaveLength(10);
    const firstIds = new Set(first.candidates.map((c: { id: string }) => c.id));
    expect(second.candidates.some((c: { id: string }) => firstIds.has(c.id))).toBe(false);

    // A page past the end is empty rather than an error, and still reports the
    // real total.
    const beyond = await page.request.get(
      `/api/company/talent-pool?q=${encodeURIComponent(marker)}&pageSize=10&page=99`
    );
    const beyondBody = await beyond.json();
    expect(beyondBody.candidates).toHaveLength(0);
    expect(beyondBody.total).toBe(OLD_LIMIT + 5);

    // …and the screen actually says the count, which is the half of the bug a
    // user could see.
    await page.goto('/company/talent-pool');
    await page.getByTestId('talent-pool-search').fill(marker);
    await expect(page.getByTestId('talent-pool-total')).toContainText(String(OLD_LIMIT + 5), { timeout: 15_000 });
    await expect(page.getByTestId('talent-pool-next')).toBeVisible();
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await cleanupByEmail(companyEmail);
    await prisma.companyEntitlement.deleteMany({ where: { companyId: company.id } });
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
  }
});
