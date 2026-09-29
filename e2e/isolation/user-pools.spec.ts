import { test, expect } from '@playwright/test';
import { seedTwoTenants, signInAsTenantActor, type TwoTenants } from '../helpers/tenants';

// Two separate USER pools under enforcement (#2356). The regression this guards
// is the one reported after the marketing-host cutover: with
// MT_ENFORCE_ISOLATION off, one tenant's admin saw EVERY tenant's users on the
// candidates screen. flag-on.spec proves the mechanism on companies; this pins
// it on the user pool specifically, in both directions, because "two products,
// two user pools" is the promise a tenant relies on.
//
// Runs only in the `isolation` Playwright project (its server has the flag on).

let tenants: TwoTenants;
test.beforeAll(async () => { tenants = await seedTwoTenants(); });
test.afterAll(async () => { await tenants.cleanup(); });

async function candidateIds(page: import('@playwright/test').Page): Promise<string[]> {
  // `all=1` returns every candidate, not one clamped page (pageSize maxes at
  // 100) — so a `.not.toContain` below can never pass merely because the other
  // tenant's row sat on page 2.
  const res = await page.request.get('/api/candidates?all=1');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { candidates: Array<{ id: string }> };
  return body.candidates.map((c) => c.id);
}

test("a tenant admin's candidate pool contains its own mentee and not the other tenant's", async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgA.admin);
  const ids = await candidateIds(page);
  expect(ids).toContain(tenants.orgA.mentee.id);
  expect(
    ids,
    "tenant B's mentee is visible to tenant A — the user pools are not separated (MT_ENFORCE_ISOLATION off, or User out of TENANT_MODELS)",
  ).not.toContain(tenants.orgB.mentee.id);
});

test('the user-pool separation holds in the other direction too', async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgB.admin);
  const ids = await candidateIds(page);
  expect(ids).toContain(tenants.orgB.mentee.id);
  expect(ids).not.toContain(tenants.orgA.mentee.id);
});

test('the internship product still works under enforcement — an admin sees its own full pool', async ({ page }) => {
  // The user's other requirement: interncrm must keep working while isolation is
  // on. A tenant that has its own data sees ALL of it (nothing over-filtered) —
  // every actor this tenant seeded shows up for its admin.
  await signInAsTenantActor(page, tenants.orgA.admin);
  const res = await page.request.get('/api/users');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { users: Array<{ id: string; email: string }> };
  const emails = body.users.map((u) => u.email);
  expect(emails).toContain(tenants.orgA.admin.email);
  expect(emails).toContain(tenants.orgA.mentor.email);
  expect(emails).toContain(tenants.orgA.mentee.email);
  // …and none of tenant B's.
  expect(emails).not.toContain(tenants.orgB.mentee.email);
});
