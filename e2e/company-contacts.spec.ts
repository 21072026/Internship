import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma } from './helpers/db';
import { gotoSettled } from './helpers/auth';
import { seedTwoTenants, signInAsTenantActor, type TwoTenants } from './helpers/tenants';

/**
 * An account's address book (#2442, docs/company-contacts.md).
 *
 *   - the primary contact IS the Company.contact* columns; adding, editing and
 *     removing rows never creates a User;
 *   - "make primary" is a swap under the company row's lock: two concurrent
 *     requests leave exactly one primary and every person exactly once;
 *   - a contact moves to another account of the same tenant, the move is on
 *     record, and it never crosses a tenant;
 *   - a non-ADMIN reader sees which addresses an account has, not the names or
 *     lines; writes are ADMIN-only;
 *   - forgetting an address (DSGVO Art. 17, #2559) deletes the row.
 */

let tenants: TwoTenants;
let secondCompanyId: string;
const stamp = Date.now();
const mail = (who: string) => `${who}-${stamp}@contacts.example`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'MARKETING', verticalB: 'INTERNSHIP' });
  await prisma.company.update({
    where: { id: tenants.orgA.company.id },
    data: { contactName: 'Ada Primary', contactEmail: mail('ada'), contactPhone: '+49 30 1', contactPosition: 'CEO' },
  });
  const second = await prisma.company.create({ data: { orgId: tenants.orgA.org.id, name: `Contacts Second ${stamp}` } });
  secondCompanyId = second.id;
});

test.afterAll(async () => {
  await tenants?.cleanup();
});

async function people(companyId: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const rows = await prisma.companyContact.findMany({ where: { companyId } });
  return { primary: company.contactEmail, rows: rows.map((r) => r.email).sort() };
}

const add = (request: APIRequestContext, companyId: string, name: string, email: string | null) =>
  request.post(`/api/companies/${companyId}/contacts`, { data: { name, email, position: 'Buyer' } });

test('ADMIN adds contacts, the duplicate test sees the primary, and no User is created', async ({ page }) => {
  const { orgA } = tenants;
  await signInAsTenantActor(page, orgA.admin);
  const usersBefore = await prisma.user.count({ where: { orgId: orgA.org.id } });

  const bob = await add(page.request, orgA.company.id, 'Bob Buyer', mail('bob'));
  expect(bob.status()).toBe(201);
  expect((await add(page.request, orgA.company.id, 'Carla', mail('carla'))).status()).toBe(201);
  // The primary's address, in another case: the same address.
  const dup = await add(page.request, orgA.company.id, 'Ada Again', mail('ada').toUpperCase());
  expect(dup.status()).toBe(409);
  expect((await dup.json()).code).toBe('duplicate_email');

  const list = await (await page.request.get(`/api/companies/${orgA.company.id}/contacts`)).json();
  expect(list.contacts[0]).toMatchObject({ id: 'primary', isPrimary: true, name: 'Ada Primary', position: 'CEO' });
  expect(list.contacts.map((c: { email: string }) => c.email)).toEqual([mail('ada'), mail('bob'), mail('carla')]);
  expect(await prisma.user.count({ where: { orgId: orgA.org.id } })).toBe(usersBefore);
});

test('two concurrent "make primary" requests leave one primary and every person exactly once', async ({ page }) => {
  const { orgA } = tenants;
  await signInAsTenantActor(page, orgA.admin);
  const rows = await prisma.companyContact.findMany({ where: { companyId: orgA.company.id } });
  const [b, c] = rows;
  const before = await people(orgA.company.id);
  const everyone = [before.primary, ...before.rows].sort();

  const [r1, r2] = await Promise.all([
    page.request.post(`/api/companies/${orgA.company.id}/contacts/${b.id}/primary`),
    page.request.post(`/api/companies/${orgA.company.id}/contacts/${c.id}/primary`),
  ]);
  expect([r1.status(), r2.status()]).toEqual([200, 200]);
  const after = await people(orgA.company.id);
  expect([b.email, c.email]).toContain(after.primary);
  expect([after.primary, ...after.rows].sort()).toEqual(everyone);

  // The SAME row twice: the first consumes it, the second finds nothing to
  // swap — a repeat never swaps the two people back.
  const row = await prisma.companyContact.findFirstOrThrow({ where: { companyId: orgA.company.id } });
  const statuses = (
    await Promise.all([
      page.request.post(`/api/companies/${orgA.company.id}/contacts/${row.id}/primary`),
      page.request.post(`/api/companies/${orgA.company.id}/contacts/${row.id}/primary`),
    ])
  )
    .map((r) => r.status())
    .sort();
  expect(statuses).toEqual([200, 404]);
  const final = await people(orgA.company.id);
  expect(final.primary).toBe(row.email);
  expect([final.primary, ...final.rows].sort()).toEqual(everyone);
});

test('a contact moves to another account of the tenant, on record, and never to another tenant', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await signInAsTenantActor(page, orgA.admin);
  const row = await prisma.companyContact.findFirstOrThrow({ where: { companyId: orgA.company.id } });

  // Another tenant's account is the same 404 as one that does not exist.
  const foreign = await page.request.post(`/api/companies/${orgA.company.id}/contacts/${row.id}/move`, {
    data: { companyId: orgB.company.id },
  });
  expect(foreign.status()).toBe(404);

  // The target has no primary: the person becomes it.
  const moved = await page.request.post(`/api/companies/${orgA.company.id}/contacts/${row.id}/move`, {
    data: { companyId: secondCompanyId },
  });
  expect(moved.status()).toBe(200);
  expect((await moved.json()).id).toBe('primary');
  expect((await prisma.company.findUniqueOrThrow({ where: { id: secondCompanyId } })).contactEmail).toBe(row.email);
  expect(await prisma.companyContact.count({ where: { id: row.id } })).toBe(0);
  const log = await prisma.activityLog.findFirst({
    where: { action: 'company_contact.moved', detail: `from company ${orgA.company.id} to company ${secondCompanyId}` },
  });
  expect(log).not.toBeNull();

  // A row joining an account that HAS a primary keeps its id.
  const newcomer = await add(page.request, orgA.company.id, 'Dora Newcomer', mail('dora'));
  const doraId = (await newcomer.json()).id as string;
  const kept = await page.request.post(`/api/companies/${orgA.company.id}/contacts/${doraId}/move`, {
    data: { companyId: secondCompanyId },
  });
  expect((await kept.json()).id).toBe(doraId);
  expect((await prisma.companyContact.findUniqueOrThrow({ where: { id: doraId } })).companyId).toBe(secondCompanyId);
});

test('a non-ADMIN reader sees the addresses, not the people; writes are ADMIN-only', async ({ page }) => {
  const { orgA } = tenants;
  // The relation ties this company to the mentor, so it is inside their scope.
  await prisma.mentorshipRelation.update({ where: { id: orgA.relation.id }, data: { companyId: orgA.company.id } });
  await signInAsTenantActor(page, orgA.mentor);

  const res = await page.request.get(`/api/companies/${orgA.company.id}/contacts`);
  expect(res.status()).toBe(200);
  const { contacts } = await res.json();
  expect(contacts.length).toBeGreaterThan(0);
  for (const c of contacts) {
    expect(c).not.toHaveProperty('name');
    expect(c).not.toHaveProperty('phone');
    expect(c).not.toHaveProperty('position');
    expect(c).toHaveProperty('email');
  }
  expect((await add(page.request, orgA.company.id, 'Sneaky', mail('sneaky'))).status()).toBe(403);
});

test('the account page lists the contacts and the ADMIN adds one and makes it primary', async ({ page }) => {
  const { orgA } = tenants;
  await signInAsTenantActor(page, orgA.admin);
  await gotoSettled(page, `/admin/companies/${orgA.company.id}`);
  const card = page.getByTestId('company-detail-contacts');
  await expect(card.getByTestId('company-contact-primary-badge')).toHaveCount(1);

  await card.getByTestId('contact-add').click();
  await card.getByTestId('contact-add-name').fill('Emil Editor');
  await card.getByTestId('contact-add-email').fill(mail('emil'));
  await card.getByTestId('contact-add-save').click();
  await expect(card).toContainText('Emil Editor');

  const emil = await prisma.companyContact.findFirstOrThrow({ where: { companyId: orgA.company.id, email: mail('emil') } });
  await card.getByTestId(`contact-make-primary-${emil.id}`).click();
  await expect(card.getByTestId('company-contact-primary')).toContainText('Emil Editor');
  await expect(card.getByTestId('company-contact-primary-badge')).toHaveCount(1);
});

test('forgetting an address deletes its address-book row (#2559)', async ({ page }) => {
  const { orgA } = tenants;
  await signInAsTenantActor(page, orgA.admin);
  await add(page.request, orgA.company.id, 'Fiona Forget', mail('fiona'));
  const res = await page.request.post('/api/admin/company-contacts/forget', {
    data: { email: mail('fiona'), confirmEmail: mail('fiona'), adminPassword: orgA.admin.password },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).contacts).toBe(1);
  expect(await prisma.companyContact.count({ where: { email: mail('fiona') } })).toBe(0);
});
