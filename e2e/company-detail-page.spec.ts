import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { gotoSettled } from './helpers/auth';
import { seedTwoTenants, signInAsTenantActor, type TwoTenants } from './helpers/tenants';

/**
 * The account detail page /admin/companies/[id] (#2560).
 *
 *   - an ADMIN sees the account — fields, contact, the funnel record with its
 *     stage, owner and next action, the latest interaction — and types an
 *     external id; a second account of the same org cannot take the same id,
 *     and the refusal names the account that holds it;
 *   - a user outside the ADMIN role never reaches the page, and the company
 *     read they may make does not carry the contact fields;
 *   - another tenant's account is a 404 (#2542's hand-written tenant filter —
 *     the flag-off default project, like e2e/tenant-scope-users-companies.spec.ts);
 *   - a MARKETING tenant reads its own words ("Deals", "Rep") on the page.
 */

let tenants: TwoTenants;
let secondCompanyId: string;
const chainRelationIds: string[] = [];
const stamp = Date.now();
const CONTACT_NAME = `Detail Contact ${stamp}`;
const CONTACT_PHONE = '+49 30 1234 5678';
const EXTERNAL_ID = `sv-merchant-${stamp}`;
const NEXT_ACTION = `Call back about the renewal ${stamp}`;
const SUBJECT = `Detail check-in ${stamp}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'INTERNSHIP', verticalB: 'MARKETING' });
  const { orgA } = tenants;
  await prisma.company.update({
    where: { id: orgA.company.id },
    data: { contactName: CONTACT_NAME, contactPhone: CONTACT_PHONE, contactEmail: `buyer-${stamp}@example.com`, vatId: `DE${stamp}` },
  });
  await prisma.mentorshipRelation.update({
    where: { id: orgA.relation.id },
    data: { nextActionAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), nextActionNote: NEXT_ACTION },
  });
  await prisma.interactionLog.create({
    data: { relationId: orgA.relation.id, date: new Date(), subject: SUBJECT, notes: 'Seeded for the detail page.', type: 'Meeting' },
  });
  const second = await prisma.company.create({
    data: { orgId: orgA.org.id, name: `Iso A Second Company ${stamp}` },
  });
  secondCompanyId = second.id;
});

test.afterAll(async () => {
  if (tenants) await prisma.interactionLog.deleteMany({ where: { relationId: tenants.orgA.relation.id } });
  if (tenants) {
    await prisma.mentorshipRelation.update({ where: { id: tenants.orgA.relation.id }, data: { previousRelationId: null } });
  }
  if (chainRelationIds.length) await prisma.mentorshipRelation.deleteMany({ where: { id: { in: chainRelationIds } } });
  await tenants?.cleanup();
});

test('ADMIN opens the account from the list and sees its whole state', { tag: '@smoke' }, async ({ page }) => {
  const { orgA } = tenants;
  await signInAsTenantActor(page, orgA.admin);

  await gotoSettled(page, '/admin/companies');
  // The list links the account by its name. The tenant holds two accounts,
  // so both are on the first page — no search round-trip to race.
  const link = page.getByTestId(`company-detail-link-${orgA.company.id}`);
  await expect(link).toHaveAttribute('href', `/admin/companies/${orgA.company.id}`);
  await link.click();
  await page.waitForURL(`**/admin/companies/${orgA.company.id}`);

  await expect(page.getByTestId('company-detail-name')).toHaveText(orgA.company.name);
  await expect(page.getByTestId('company-detail-contact-name')).toContainText(CONTACT_NAME);
  await expect(page.getByTestId('company-detail-contact-phone')).toContainText(CONTACT_PHONE);
  await expect(page.getByTestId('company-detail-vat-id')).toContainText(`DE${stamp}`);

  const row = page.getByTestId(`company-detail-relation-${orgA.relation.id}`);
  await expect(row).toContainText(orgA.mentee.fullName);
  await expect(row).toContainText(orgA.mentor.fullName);
  // The tenant's own stage label (seeded per tenant), not the raw key.
  await expect(page.getByTestId(`company-detail-relation-stage-${orgA.relation.id}`)).toHaveText(orgA.stage.label);
  await expect(page.getByTestId(`company-detail-relation-next-${orgA.relation.id}`)).toContainText(NEXT_ACTION);
  await expect(page.getByTestId('company-detail-interactions')).toContainText(SUBJECT);
  // INTERNSHIP reads the base dictionary.
  await expect(page.getByRole('heading', { name: 'Mentorships' })).toBeVisible();

  // Opening the page is a read of the customer record (#2433).
  await expect
    .poll(() =>
      prisma.activityLog.count({ where: { action: 'company.view', actorId: orgA.admin.id, targetId: orgA.company.id } })
    )
    .toBeGreaterThan(0);
});

test('the funnel row walks the whole previousRelationId chain, and stops at the tenant boundary', async ({ page }) => {
  const { orgA, orgB } = tenants;
  // relation <- earlier (orgA) <- earliest (orgA) <- orgB's relation (a bad
  // import): two hops are shown, the foreign one is not.
  const earliest = await prisma.mentorshipRelation.create({
    data: {
      orgId: orgA.org.id,
      mentorId: orgA.mentor.id,
      menteeId: orgA.mentee.id,
      status: 'COMPLETED',
      previousRelationId: orgB.relation.id,
    },
  });
  const earlier = await prisma.mentorshipRelation.create({
    data: {
      orgId: orgA.org.id,
      mentorId: orgA.mentor.id,
      menteeId: orgA.mentee.id,
      status: 'COMPLETED',
      previousRelationId: earliest.id,
    },
  });
  chainRelationIds.push(earlier.id, earliest.id);
  await prisma.mentorshipRelation.update({ where: { id: orgA.relation.id }, data: { previousRelationId: earlier.id } });

  await signInAsTenantActor(page, orgA.admin);
  await gotoSettled(page, `/admin/companies/${orgA.company.id}`);
  const chain = page.getByTestId(`company-detail-relation-chain-${orgA.relation.id}`);
  await expect(chain).toHaveText(
    `Continues an earlier pairing with ${orgA.mentor.fullName}, ${orgA.mentor.fullName}`,
  );
  await expect(page.getByTestId('company-detail')).not.toContainText(orgB.mentor.fullName);
});

test('ADMIN sets an external id; a second account of the org cannot take it', async ({ page }) => {
  const { orgA } = tenants;
  await signInAsTenantActor(page, orgA.admin);

  // The other tenant already holds the same id: that is no conflict, the rule
  // is per org (the same merchant may be an account of two tenants).
  await prisma.company.update({ where: { id: tenants.orgB.company.id }, data: { externalId: EXTERNAL_ID } });

  await gotoSettled(page, `/admin/companies/${orgA.company.id}`);
  await page.getByTestId('company-external-id-input').fill(EXTERNAL_ID);
  await page.getByTestId('company-external-id-save').click();
  await expect(page.getByTestId('company-external-id-saved')).toBeVisible();

  const saved = await prisma.company.findUniqueOrThrow({
    where: { id: orgA.company.id },
    select: { externalId: true, contactEmail: true },
  });
  expect(saved.externalId).toBe(EXTERNAL_ID);
  // The partial PUT wrote the id and nothing else.
  expect(saved.contactEmail).toBe(`buyer-${stamp}@example.com`);

  // The header badge follows the save without a reload (router.refresh()).
  await expect(page.getByTestId('company-detail-external-id')).toHaveText(EXTERNAL_ID);
  await expect(page.getByTestId('company-external-id-input')).toHaveValue(EXTERNAL_ID);

  // Same id on the org's second account: refused, and the refusal names the holder.
  await gotoSettled(page, `/admin/companies/${secondCompanyId}`);
  await page.getByTestId('company-external-id-input').fill(EXTERNAL_ID);
  await page.getByTestId('company-external-id-save').click();
  const taken = page.getByTestId('company-external-id-taken');
  await expect(taken).toBeVisible();
  await expect(taken.getByRole('link', { name: orgA.company.name })).toHaveAttribute(
    'href',
    `/admin/companies/${orgA.company.id}`
  );
  const second = await prisma.company.findUniqueOrThrow({ where: { id: secondCompanyId }, select: { externalId: true } });
  expect(second.externalId).toBeNull();

  // A blank clears it — through the form, and the badge goes with it.
  await gotoSettled(page, `/admin/companies/${orgA.company.id}`);
  await expect(page.getByTestId('company-detail-external-id')).toHaveText(EXTERNAL_ID);
  await page.getByTestId('company-external-id-input').fill('');
  await page.getByTestId('company-external-id-save').click();
  await expect(page.getByTestId('company-external-id-saved')).toBeVisible();
  await expect(page.getByTestId('company-detail-external-id')).toHaveCount(0);
  expect((await prisma.company.findUniqueOrThrow({ where: { id: orgA.company.id } })).externalId).toBeNull();

  // And the API accepts a blank as "clear" too.
  const res = await page.request.put(`/api/companies/${orgA.company.id}`, { data: { externalId: '' } });
  expect(res.status()).toBe(200);
});

test('a non-admin never reaches the page, and its company read carries no contact fields', async ({ page }) => {
  const { orgA } = tenants;
  await signInAsTenantActor(page, orgA.mentor);

  await page.goto(`/admin/companies/${orgA.company.id}`);
  await expect(page).not.toHaveURL(/\/admin\/companies\//);
  await expect(page.getByText(CONTACT_NAME)).toHaveCount(0);

  // The mentor legitimately reads this company (it is on their relation) —
  // without the ADMIN-only columns.
  const res = await page.request.get(`/api/companies/${orgA.company.id}`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).not.toContain(CONTACT_NAME);
  expect(body).not.toContain(CONTACT_PHONE);
});

test('another tenant\'s account is a 404; the MARKETING tenant reads its own words', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await signInAsTenantActor(page, orgB.admin);

  // A real 404 at the HTTP level, not a not-found screen under a 200: the page
  // sits outside /admin's loading.tsx (the (unstreamed) route group), so its
  // lookup runs before the first byte. Neither the page nor the record API
  // behind it discloses the row.
  const foreign = await page.request.get(`/admin/companies/${orgA.company.id}`);
  expect(foreign.status()).toBe(404);
  const html = await foreign.text();
  expect(html).not.toContain(orgA.company.name);
  expect(html).not.toContain(CONTACT_NAME);
  expect(html).toContain('Page not found');
  expect((await page.request.get(`/api/companies/${orgA.company.id}`)).status()).toBe(404);

  await page.goto(`/admin/companies/${orgA.company.id}`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByTestId('company-detail')).toHaveCount(0);

  await gotoSettled(page, `/admin/companies/${orgB.company.id}`);
  await expect(page.getByTestId('company-detail-name')).toHaveText(orgB.company.name);
  await expect(page.getByRole('heading', { name: 'Deals' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Rep' })).toBeVisible();
});
