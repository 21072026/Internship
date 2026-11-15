import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';

// The grouped admin sidebar (#3752, iOS-Settings style): daily items on top,
// collapsible groups below (button + aria-expanded, remembered per browser),
// the active page's group always open, and a "More" row per group leading to a
// hub page that lists the group's rarely used pages from the same nav list.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'NavGroups123';

async function makeAdmin(vertical: 'INTERNSHIP' | 'MARKETING') {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${vertical.toLowerCase()}`;
  const org = await prisma.organization.create({
    data: { name: `Nav groups ${vertical} ${stamp}`, slug: `navgroups-${stamp}`, vertical },
  });
  const email = uniqueEmail(`navgroups-${vertical.toLowerCase()}`);
  const user = await seedUser(email, PW, 'ADMIN', `Nav groups ${vertical}`);
  await prisma.user.update({ where: { id: user.id }, data: { orgId: org.id } });
  return { org, email };
}

async function cleanup(org: { id: string }, email: string) {
  await cleanupByEmail(email);
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
}

test('a group collapses and opens again, and the choice survives a reload', async ({ page }) => {
  const { org, email } = await makeAdmin('INTERNSHIP');
  try {
    await signInAndSettle(page, email, PW, '/admin');
    const nav = page.locator('aside nav').first();
    const toggle = nav.getByTestId('nav-group-toggle-settings');
    // Groups start open, like iOS Settings.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);

    await page.reload();
    await expect(nav.getByTestId('nav-group-toggle-settings')).toHaveAttribute('aria-expanded', 'false');

    // Keyboard: the header is a real button.
    await nav.getByTestId('nav-group-toggle-settings').focus();
    await page.keyboard.press('Enter');
    await expect(nav.getByTestId('nav-group-toggle-settings')).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  } finally {
    await cleanup(org, email);
  }
});

test('the group of the current page is always open, even after it was closed', async ({ page }) => {
  const { org, email } = await makeAdmin('INTERNSHIP');
  try {
    await signInAndSettle(page, email, PW, '/admin');
    const nav = page.locator('aside nav').first();
    await nav.getByTestId('nav-group-toggle-reports').click();
    await expect(nav.getByTestId('nav-group-toggle-reports')).toHaveAttribute('aria-expanded', 'false');

    await gotoSettled(page, '/admin/analytics');
    const toggle = nav.getByTestId('nav-group-toggle-reports');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'Analytics', exact: true })).toHaveAttribute('aria-current', 'page');
  } finally {
    await cleanup(org, email);
  }
});

test('the "More" row opens the group hub, and its rows lead to their pages', async ({ page }) => {
  const { org, email } = await makeAdmin('INTERNSHIP');
  try {
    await signInAndSettle(page, email, PW, '/admin');
    const nav = page.locator('aside nav').first();
    // A hub-only page is not a sidebar link…
    await expect(nav.getByRole('link', { name: 'Tags', exact: true })).toHaveCount(0);
    await nav.getByTestId('nav-hub-settings').click();
    await page.waitForURL('**/admin/hub/settings');
    const hub = page.getByTestId('nav-hub-page-settings');
    await expect(hub).toBeVisible();
    // …and the hub lists it (and the internship-only rows, for INTERNSHIP).
    await expect(hub.getByTestId('nav-hub-row-billing')).toBeVisible();
    await expect(nav.getByTestId('nav-group-toggle-settings')).toHaveAttribute('aria-expanded', 'true');
    await hub.getByTestId('nav-hub-row-tags').click();
    await page.waitForURL('**/admin/tags');

    // The sidebar search still finds a hub-only page.
    await page.getByPlaceholder(/Filter menu/i).fill('tags');
    await expect(nav.getByRole('link', { name: 'Tags', exact: true })).toBeVisible();
  } finally {
    await cleanup(org, email);
  }
});

test('MARKETING: no Mentoring group, no empty group, no internship row on a hub', async ({ page }) => {
  const { org, email } = await makeAdmin('MARKETING');
  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST)); // MARKETING account => marketing host (#2590)
    await signInAndSettle(page, email, PW, '/admin');
    const nav = page.locator('aside nav').first();
    await expect(nav.getByTestId('nav-group-mentoring')).toHaveCount(0);
    const groups = nav.locator('[data-testid^="nav-group-toggle-"]');
    const count = await groups.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const id = (await groups.nth(i).getAttribute('data-testid'))!.replace('nav-group-toggle-', '');
      // Every group shown carries at least one link (a page or its "More" row).
      await expect(nav.locator(`#nav-group-items-${id} a`).first()).toBeVisible();
    }
    await gotoSettled(page, '/admin/hub/settings');
    const hub = page.getByTestId('nav-hub-page-settings');
    await expect(hub.getByTestId('nav-hub-row-tags')).toBeVisible();
    await expect(hub.getByTestId('nav-hub-row-billing')).toHaveCount(0);
  } finally {
    await cleanup(org, email);
  }
});
