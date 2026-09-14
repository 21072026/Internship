import { test, expect } from '@playwright/test';
import { seedTwoTenants, signInAsTenantActor, type TwoTenants } from '../helpers/tenants';

// The admin dashboard is a SERVER COMPONENT (#2356). Its Prisma reads do not go
// through an API route's withTenantScope, so before the fix it counted and listed
// EVERY tenant's mentees/mentors/mentorships — the exact leak reported on the
// preview marketing org, whose dashboard showed the internship tenant's 54
// mentees while its own user list correctly showed one. This pins the server
// component to the caller's org: A's admin sees A's people and never B's.
//
// Runs only in the `isolation` Playwright project (its server has the flag on).

let tenants: TwoTenants;
test.beforeAll(async () => { tenants = await seedTwoTenants(); });
test.afterAll(async () => { await tenants.cleanup(); });

test("the admin dashboard shows the caller's own tenant, not every tenant", async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgA.admin);
  await page.goto('/admin');

  // Own tenant's mentee is on the dashboard (recent candidates / mentorships).
  await expect(page.getByText(tenants.orgA.mentee.fullName).first()).toBeVisible();

  // The other tenant's people must appear NOWHERE on it — the leak the report
  // was about. A server component that skipped tenant scoping would list them.
  await expect(
    page.getByText(tenants.orgB.mentee.fullName),
    "tenant B's mentee is on tenant A's dashboard — the server component is not org-scoped",
  ).toHaveCount(0);
  await expect(page.getByText(tenants.orgB.mentor.fullName)).toHaveCount(0);
});

test('the dashboard holds in the other direction too', async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgB.admin);
  await page.goto('/admin');

  await expect(page.getByText(tenants.orgB.mentee.fullName).first()).toBeVisible();
  await expect(page.getByText(tenants.orgA.mentee.fullName)).toHaveCount(0);
});
