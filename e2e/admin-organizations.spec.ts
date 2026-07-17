import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Multi-tenancy (#544): super-admin Organizations screen — create a tenant and
// see it listed with per-tenant counts. Phase 1 is additive (orgId nullable,
// no query isolation yet), so this only exercises listing + creation + authz.

const createdSlugs: string[] = [];

test.afterAll(async () => {
  for (const slug of createdSlugs) {
    await prisma.organization.deleteMany({ where: { slug } }).catch(() => {});
  }
  await prisma.$disconnect();
});

test('admin creates an organization and it appears in the list', async ({ page }) => {
  const adminEmail = uniqueEmail('org-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Org Admin');
  const tag = Date.now();
  const orgName = `E2E Org ${tag}`;
  const orgSlug = `e2e-org-${tag}`;
  createdSlugs.push(orgSlug);

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/organizations');
    await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();

    // Create via the form.
    await page.getByLabel('Name', { exact: true }).fill(orgName);
    await page.getByLabel('Slug', { exact: true }).fill(orgSlug);
    await page.getByRole('button', { name: 'Create' }).click();

    // New org row shows up with its slug.
    await expect(page.locator('table').getByText(orgName, { exact: true })).toBeVisible({ timeout: 10_000 });

    // Persisted in the DB, defaults to the FREE plan.
    const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
    expect(org?.name).toBe(orgName);
    expect(org?.plan).toBe('FREE');

    // Change the plan to PRO via the row selector; it persists.
    await page.getByTestId(`org-plan-${org!.id}`).selectOption('PRO');
    await expect.poll(async () =>
      (await prisma.organization.findUnique({ where: { id: org!.id } }))?.plan,
      { timeout: 10_000 },
    ).toBe('PRO');

    // White-label branding (#546): set fields via the API and confirm persistence.
    const brand = await page.request.patch('/api/admin/organizations', {
      data: { id: org!.id, brandName: 'Acme Talent', brandColor: '#2563eb', supportEmail: 'help@acme.test' },
    });
    expect(brand.ok()).toBeTruthy();
    const branded = await prisma.organization.findUnique({ where: { id: org!.id } });
    expect(branded?.brandName).toBe('Acme Talent');
    expect(branded?.brandColor).toBe('#2563eb');

    // A bad hex color is rejected.
    const badColor = await page.request.patch('/api/admin/organizations', {
      data: { id: org!.id, brandColor: 'notacolor' },
    });
    expect(badColor.status()).toBe(400);

    // A blank field clears the override.
    const clear = await page.request.patch('/api/admin/organizations', {
      data: { id: org!.id, brandName: '' },
    });
    expect(clear.ok()).toBeTruthy();
    const cleared = await prisma.organization.findUnique({ where: { id: org!.id } });
    expect(cleared?.brandName).toBeNull();
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('non-admin cannot list or create organizations', async ({ page }) => {
  const mentorEmail = uniqueEmail('org-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Org Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const list = await page.request.get('/api/admin/organizations');
    expect(list.status()).toBe(401);

    const create = await page.request.post('/api/admin/organizations', {
      data: { name: 'Should Fail', slug: `should-fail-${Date.now()}` },
    });
    expect(create.status()).toBe(401);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
