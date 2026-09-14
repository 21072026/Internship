import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Vertical nav gate (#2351, epic #2348). The vertical a tenant belongs to
// decides which modules its shell shows: INTERNSHIP carries everything (so the
// sidebar is unchanged for today's product), a MARKETING org has no mentorship,
// placement or sourcing modules and their nav links must fall away. The links
// are the visible half of the gate; the write-path gate is #2352.

test.afterAll(async () => {
  await prisma.$disconnect();
});

// The mentorship/placement/sourcing links a MARKETING org must NOT see, by the
// exact-name they render under in the admin sidebar.
const HIDDEN_FOR_MARKETING = ['Mentors', 'Mentorships', 'Mentor Applications', 'Offers', 'Sources'];
// Core CRM links every vertical keeps.
const KEPT = ['Companies', 'Organizations', 'Settings'];

async function makeUser(
  vertical: 'INTERNSHIP' | 'MARKETING',
  role: 'ADMIN' | 'MENTOR' | 'MENTEE' = 'ADMIN',
) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${vertical.toLowerCase()}`;
  const org = await prisma.organization.create({
    data: { name: `Nav ${vertical} ${stamp}`, slug: `nav-${stamp}`, vertical },
  });
  const email = uniqueEmail(`nav-${role.toLowerCase()}`);
  const user = await seedUser(email, 'NavPass123', role, `${vertical} ${role}`);
  await prisma.user.update({ where: { id: user.id }, data: { orgId: org.id } });
  return { org, email };
}
const makeAdmin = (v: 'INTERNSHIP' | 'MARKETING') => makeUser(v, 'ADMIN');

test('an INTERNSHIP admin sees the full sidebar — the gate is a no-op', async ({ page }) => {
  const { org, email } = await makeAdmin('INTERNSHIP');
  try {
    await signInAndSettle(page, email, 'NavPass123', '/admin');
    const nav = page.locator('aside nav').first();
    for (const name of [...HIDDEN_FOR_MARKETING, ...KEPT]) {
      await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('a MARKETING admin loses the mentorship/placement/sourcing links, keeps the CRM core', async ({ page }) => {
  const { org, email } = await makeAdmin('MARKETING');
  try {
    await signInAndSettle(page, email, 'NavPass123', '/admin');
    const nav = page.locator('aside nav').first();
    // Core stays.
    for (const name of KEPT) {
      await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
    }
    // Mentorship/placement/sourcing gone.
    for (const name of HIDDEN_FOR_MARKETING) {
      await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('a MARKETING org has no mentor shell — /mentor redirects home', async ({ page }) => {
  const { org, email } = await makeAdmin('MARKETING');
  try {
    await signInAndSettle(page, email, 'NavPass123', '/admin');
    // An admin can normally open the mentor shell via mode switching; a MARKETING
    // org has no mentorship module, so the layout sends them out of it.
    await page.goto('/mentor');
    await expect(page).toHaveURL((u) => !u.pathname.startsWith('/mentor'), { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('a MENTOR in a MARKETING org lands on /account, not an infinite redirect', async ({ page }) => {
  // The loop this guards against: '/mentor' -> gate -> '/' -> roleHome(MENTOR)
  // -> '/mentor' -> ... A terminal redirect target breaks it. Reaching this
  // state is a supported deploy-time act — an INTERNSHIP org with mentors
  // reclassified to MARKETING.
  const { org, email } = await makeUser('MARKETING', 'MENTOR');
  try {
    // Inline sign-in, not signInAndSettle: /account is a bare settings page with
    // no account-menu for the helper to wait on. The post-login redirect chain
    // itself proves no loop — roleHome for this role is the mentorship shell, so
    // a bouncy target would 30x-loop instead of settling on /account.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'NavPass123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/account/, { timeout: 20_000 });
    await page.goto('/mentor');
    await expect(page).toHaveURL(/\/account/, { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('a MENTEE in a MARKETING org lands on /account, not an infinite redirect', async ({ page }) => {
  const { org, email } = await makeUser('MARKETING', 'MENTEE');
  try {
    // Inline sign-in, not signInAndSettle: /account is a bare settings page with
    // no account-menu for the helper to wait on. The post-login redirect chain
    // itself proves no loop — roleHome for this role is the mentorship shell, so
    // a bouncy target would 30x-loop instead of settling on /account.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'NavPass123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/account/, { timeout: 20_000 });
    await page.goto('/portal');
    await expect(page).toHaveURL(/\/account/, { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

