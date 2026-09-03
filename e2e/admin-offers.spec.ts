import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

// The /admin/offers index (#1873): the three saved views, a correct server-side
// total, and the fact that the screen is admin-only while the two offer
// confidentiality rules (no DRAFT and no compensationNote outside ADMIN /
// the owning mentee) are untouched by it.
//
// Offer is not a tenant-anchored model, so an admin session sees every offer in
// the database — including whatever other specs seeded. Every assertion here is
// therefore narrowed with the search box (or ?q=) to this run's own stamp, and
// scoped to the table, never to bare page text.
test.afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;

async function signIn(page: Page, email: string, password: string, redirectPrefix: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(redirectPrefix), { timeout: 20_000 });
}

async function seedScenario() {
  const pw = 'OfferIndexPass123!';
  const stamp = `oi${Date.now()}${Math.round(Math.random() * 1000)}`;
  const adminEmail = uniqueEmail(`${stamp}admin`);
  const mentorEmail = uniqueEmail(`${stamp}mentor`);
  const menteeEmail = uniqueEmail(`${stamp}mentee`);
  const companyEmail = uniqueEmail(`${stamp}company`);

  const admin = await seedUser(adminEmail, pw, 'ADMIN', `Index Admin ${stamp}`);
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', `Index Mentor ${stamp}`);
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', `Index Mentee ${stamp}`);
  const org = await prisma.organization.create({ data: { name: `Index Org ${stamp}`, slug: `index-${stamp}` } });
  await prisma.user.updateMany({ where: { id: { in: [admin.id, mentor.id, mentee.id] } }, data: { orgId: org.id } });
  const company = await prisma.company.create({ data: { name: `Index Co ${stamp}`, orgId: org.id } });
  const companyUser = await prisma.user.create({
    data: { email: companyEmail, password: await bcrypt.hash(pw, 10), role: 'COMPANY', fullName: `Index Observer ${stamp}`, companyId: company.id, orgId: org.id, skills: [] },
  });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, orgId: org.id },
  });

  const base = { orgId: org.id, relationId: relation.id, companyId: company.id, createdById: admin.id };
  // createdAt is set explicitly and distinctly: the paging assertion below
  // orders by it, and rows sharing a timestamp make LIMIT/OFFSET unstable.
  const soon = await prisma.offer.create({
    data: { ...base, status: 'SENT', position: `Soon Role ${stamp}`, sentAt: new Date(), expiresAt: new Date(Date.now() + 3 * DAY), createdAt: new Date(Date.now() - 4000) },
  });
  const later = await prisma.offer.create({
    data: { ...base, status: 'SENT', position: `Later Role ${stamp}`, sentAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY), createdAt: new Date(Date.now() - 3000) },
  });
  const declined = await prisma.offer.create({
    data: {
      ...base,
      status: 'DECLINED',
      position: `Turned Down ${stamp}`,
      sentAt: new Date(Date.now() - 10 * DAY),
      decidedAt: new Date(Date.now() - DAY),
      declineReasonCode: 'COMPENSATION',
      declineNote: `too low ${stamp}`,
      decidedById: mentee.id,
      createdAt: new Date(Date.now() - 2000),
    },
  });
  const draft = await prisma.offer.create({
    data: { ...base, status: 'DRAFT', position: `Unsent Role ${stamp}`, compensationNote: `draft-only-compensation-${stamp}`, createdAt: new Date(Date.now() - 1000) },
  });

  return {
    pw, stamp, adminEmail, menteeEmail, companyEmail,
    soon, later, declined, draft, relation, company, org, mentee, companyUser,
    cleanup: async () => {
      await prisma.offer.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      await prisma.user.deleteMany({ where: { id: companyUser.id } });
      await prisma.company.deleteMany({ where: { id: company.id } });
      await cleanupByEmail(menteeEmail);
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(adminEmail);
      await prisma.organization.deleteMany({ where: { id: org.id } });
    },
  };
}

// Narrow the current view to this run's offers by typing into the page's own
// search box — data-testid because AdminNav renders its own
// input[type="search"] sidebar filter on every admin page.
async function searchForStamp(page: Page, stamp: string) {
  const box = page.getByTestId('admin-offers-search');
  await box.fill(stamp);
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`q=${stamp}`));
}

test('the outstanding preset lists sent offers and hides decided and unsent ones', async ({ page }) => {
  const s = await seedScenario();
  try {
    await signIn(page, s.adminEmail, s.pw, '/admin');
    await page.goto('/admin/offers');
    await page.getByTestId('admin-offers-preset-outstanding').click();
    await searchForStamp(page, s.stamp);

    const table = page.getByTestId('admin-offers-table');
    await expect(table.getByTestId(`offer-row-${s.soon.id}`)).toBeVisible();
    await expect(table.getByTestId(`offer-row-${s.later.id}`)).toBeVisible();
    await expect(table.getByTestId(`offer-row-${s.declined.id}`)).toHaveCount(0);
    // A DRAFT is a legitimate admin row, but it is not outstanding.
    await expect(table.getByTestId(`offer-row-${s.draft.id}`)).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test('the "expiring this week" preset returns only the offer whose deadline is within 7 days', async ({ page }) => {
  const s = await seedScenario();
  try {
    await signIn(page, s.adminEmail, s.pw, '/admin');
    await page.goto('/admin/offers');
    await page.getByTestId('admin-offers-preset-expiringThisWeek').click();
    await searchForStamp(page, s.stamp);

    const table = page.getByTestId('admin-offers-table');
    await expect(table.getByTestId(`offer-row-${s.soon.id}`)).toBeVisible();
    await expect(table.getByTestId(`offer-row-${s.later.id}`)).toHaveCount(0);
    // The row says how close the deadline is, not just when it is.
    await expect(table.getByTestId(`offer-row-${s.soon.id}`)).toContainText('3 days');
  } finally {
    await s.cleanup();
  }
});

test('the declined view shows the localised decline reason', async ({ page }) => {
  const s = await seedScenario();
  try {
    await signIn(page, s.adminEmail, s.pw, '/admin');
    await page.goto('/admin/offers');
    await page.getByTestId('admin-offers-preset-declined').click();
    await searchForStamp(page, s.stamp);

    const row = page.getByTestId('admin-offers-table').getByTestId(`offer-row-${s.declined.id}`);
    await expect(row).toBeVisible();
    // The reason is stored as a code; the screen must render its label.
    await expect(row).toContainText('Compensation');
    await expect(row).toContainText(`too low ${s.stamp}`);
    await expect(page.getByTestId('admin-offers-table').getByTestId(`offer-row-${s.soon.id}`)).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test('the admin list pages server-side: the total counts every match and page 2 is different rows', async ({ page }) => {
  const s = await seedScenario();
  try {
    await signIn(page, s.adminEmail, s.pw, '/admin');

    const first = await page.request.get(`/api/offers?q=${s.stamp}&pageSize=2&sort=createdAt&dir=asc`);
    expect(first.status()).toBe(200);
    const one = await first.json();
    // Four offers were seeded; the total comes from a count() on the same
    // where, so it is 4 even though only 2 rows came back.
    expect(one.total).toBe(4);
    expect(one.page).toBe(1);
    expect(one.pageSize).toBe(2);
    expect(one.offers).toHaveLength(2);

    const second = await page.request.get(`/api/offers?q=${s.stamp}&pageSize=2&page=2&sort=createdAt&dir=asc`);
    const two = await second.json();
    expect(two.total).toBe(4);
    expect(two.offers).toHaveLength(2);
    const firstIds = (one.offers as { id: string }[]).map((o) => o.id);
    const secondIds = (two.offers as { id: string }[]).map((o) => o.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

    // pageSize is honoured, not ignored (#1438), and is capped.
    const capped = await page.request.get(`/api/offers?q=${s.stamp}&pageSize=1000`);
    expect((await capped.json()).pageSize).toBe(100);
  } finally {
    await s.cleanup();
  }
});

test('the offer index is admin-only, and the new filters never widen what a company may see', async ({ page }) => {
  const s = await seedScenario();
  try {
    // A mentee is bounced out of /admin entirely by the admin layout.
    await signIn(page, s.menteeEmail, s.pw, '/portal');
    await page.goto('/admin/offers');
    await page.waitForURL((u) => !u.pathname.startsWith('/admin'), { timeout: 20_000 });
    await expect(page.getByTestId('admin-offers-table')).toHaveCount(0);

    // The company observer keeps the pre-existing contract: no DRAFT, no
    // compensationNote, and none of the admin filters buy a way in.
    // signInAsFreshUser (not the local signIn) because this switches user
    // mid-test: a stale NextAuth session cookie races the sign-in form and
    // detaches it under the fill (see e2e/helpers/auth.ts).
    await signInAsFreshUser(page, s.companyEmail, s.pw, '/company');
    const res = await page.request.get(`/api/offers?status=DRAFT&q=${s.stamp}&pageSize=100`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect((JSON.parse(body).offers as { id: string }[]).some((o) => o.id === s.draft.id)).toBe(false);
    expect(body).not.toContain(`draft-only-compensation-${s.stamp}`);
  } finally {
    await s.cleanup();
  }
});
