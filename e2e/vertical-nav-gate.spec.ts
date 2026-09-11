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

async function makeAdmin(vertical: 'INTERNSHIP' | 'MARKETING') {
  const stamp = `${Date.now()}-${vertical.toLowerCase()}`;
  const org = await prisma.organization.create({
    data: { name: `Nav ${vertical} ${stamp}`, slug: `nav-${stamp}`, vertical },
  });
  const email = uniqueEmail(`nav-${vertical.toLowerCase()}`);
  const admin = await seedUser(email, 'NavPass123', 'ADMIN', `${vertical} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  return { org, email };
}

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
