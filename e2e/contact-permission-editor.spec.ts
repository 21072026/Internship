import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';

// The admin's contact-permission editor on the account page (UWG § 7,
// docs/contact-permission.md), driven through the UI.
//
// Already pinned elsewhere, not repeated here:
//   - the double opt-in itself, the link, its replay and the API-level refusals
//     (DOI typed in by an admin, § 7(3) without a reason, owner_objected over a
//     LINK row) — e2e/marketing-demo-form.spec.ts;
//   - "Record advertising objection" from the page — e2e/marketing-postal-campaign.spec.ts.
//
// What this adds:
//   1. a § 7(3) record written from the editor: refused on screen without its
//      reason, saved with it, and the card then says advertising e-mail is permitted;
//      DOI_CONFIRMED is never offered;
//   2. a revocation from the editor, which an admin may write over again;
//   3. the LOCKED state: a channel the address owner withdrew themselves
//      (revokedVia LINK) is announced before anyone types, its save and revoke
//      are disabled, the API still refuses it — and the other channels stay open.

const PW = 'ContactPermEditor123';
const emails: string[] = [];
let orgId = '';
let adminEmail = '';

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({
    data: { name: `Perm MKT ${stamp}`, slug: `perm-mkt-${stamp}`, vertical: 'MARKETING' },
    select: { id: true },
  })).id;
  adminEmail = uniqueEmail('perm-admin');
  emails.push(adminEmail);
  await seedUser(adminEmail, PW, 'ADMIN', 'Perm Admin', orgId);
});

test.afterAll(async () => {
  const companies = await prisma.company.findMany({ where: { orgId }, select: { id: true } });
  await prisma.activityLog.deleteMany({ where: { targetId: { in: companies.map((c) => c.id) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

async function account(name: string) {
  return prisma.company.create({
    data: { orgId, name: `${name} ${Date.now()}`, contactName: 'Clara Kontakt', contactEmail: uniqueEmail('perm-contact'), country: 'DE' },
  });
}

async function openAccount(page: Page, companyId: string) {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, adminEmail, PW, '/admin');
  await gotoSettled(page, `/admin/companies/${companyId}`);
  await expect(page.getByTestId('contact-permission-editor')).toBeVisible({ timeout: 20_000 });
}

const emailRow = (companyId: string) =>
  prisma.contactPermission.findUnique({ where: { companyId_channel: { companyId, channel: 'EMAIL' } } });

test('§ 7(3) from the editor: refused without its reason, saved with it, then revoked and written again', async ({ page }) => {
  test.setTimeout(120_000);
  const company = await account('Bestandskunde');
  await openAccount(page, company.id);

  // Only what an admin may write is offered — never a double opt-in.
  const offered = await page.getByTestId('contact-permission-basis').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  expect(offered).toEqual(['EXISTING_CUSTOMER_7_3', 'INQUIRY_REPLY', 'NONE']);
  await expect(page.getByTestId('contact-permission-locked')).toHaveCount(0);

  // No reason: refused on screen, nothing written.
  await page.getByTestId('contact-permission-channel').selectOption('EMAIL');
  await page.getByTestId('contact-permission-basis').selectOption('EXISTING_CUSTOMER_7_3');
  await page.getByTestId('contact-permission-save').click();
  await expect(page.getByTestId('contact-permission-reason-required')).toBeVisible({ timeout: 15_000 });
  expect(await emailRow(company.id)).toBeNull();

  // With the sale behind it: saved, and the card shows the basis and the permission.
  const reason = 'Paid invoice 2026-0117, contract signed in October';
  await page.getByTestId('contact-permission-reason').fill(reason);
  await page.getByTestId('contact-permission-save').click();
  await expect(page.getByTestId('contact-permission-saved')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('company-detail-permission-basis-EMAIL')).toHaveAttribute('data-basis', 'EXISTING_CUSTOMER_7_3', { timeout: 15_000 });
  await expect(page.getByTestId('company-detail-email-permission')).toHaveAttribute('data-permitted', 'true');
  const granted = await emailRow(company.id);
  expect(granted).toMatchObject({ basis: 'EXISTING_CUSTOMER_7_3', source: 'ADMIN', reason, revokedAt: null });
  expect(granted?.address).toBe(company.contactEmail!.toLowerCase());

  // Revoked by the admin (our own decision): the card says so, and nothing is locked.
  await page.getByTestId('contact-permission-revoke').click();
  await expect(page.getByTestId('company-detail-permission-basis-EMAIL')).toHaveAttribute('data-revoked', 'true', { timeout: 15_000 });
  await expect(page.getByTestId('company-detail-email-permission')).toHaveAttribute('data-permitted', 'false');
  expect(await emailRow(company.id)).toMatchObject({ revokedVia: 'ADMIN', basis: 'EXISTING_CUSTOMER_7_3' });
  await expect(page.getByTestId('contact-permission-locked')).toHaveCount(0);

  // An admin's own revocation is not the person's objection: it may be written over.
  await page.getByTestId('contact-permission-basis').selectOption('INQUIRY_REPLY');
  await page.getByTestId('contact-permission-save').click();
  await expect(page.getByTestId('company-detail-permission-basis-EMAIL')).toHaveAttribute('data-basis', 'INQUIRY_REPLY', { timeout: 15_000 });
  expect(await emailRow(company.id)).toMatchObject({ basis: 'INQUIRY_REPLY', revokedAt: null });
});

test("the owner's own withdrawal locks the channel in the editor — visibly, before anyone types", { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(120_000);
  const company = await account('Widerruf');
  // The address owner pressed the opt-out link (what /api/contact-permission/opt-out writes).
  await prisma.contactPermission.create({
    data: {
      orgId,
      companyId: company.id,
      channel: 'EMAIL',
      basis: 'DOI_CONFIRMED',
      source: 'DOI_LINK',
      address: company.contactEmail!.toLowerCase(),
      confirmedAt: new Date(Date.now() - 86_400_000),
      revokedAt: new Date(),
      revokedVia: 'LINK',
    },
  });
  await openAccount(page, company.id);

  await expect(page.getByTestId('company-detail-permission-objection-EMAIL')).toBeVisible();
  await page.getByTestId('contact-permission-channel').selectOption('EMAIL');
  const locked = page.getByTestId('contact-permission-locked');
  await expect(locked).toBeVisible();
  await expect(locked).toHaveAttribute('data-channel', 'EMAIL');
  await expect(page.getByTestId('contact-permission-save')).toBeDisabled();
  await expect(page.getByTestId('contact-permission-revoke')).toBeDisabled();

  // The lock is the rule's, not the button's: the API refuses every basis too.
  for (const body of [
    { action: 'set', channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3', reason: 'Paid invoice 2026-0118 in November' },
    { action: 'set', channel: 'EMAIL', basis: 'NONE' },
  ]) {
    const res = await page.request.put(`/api/admin/companies/${company.id}/contact-permission`, { data: body });
    expect(res.status(), body.basis).toBe(400);
    expect((await res.json()).code).toBe('owner_objected');
  }
  expect(await emailRow(company.id)).toMatchObject({ revokedVia: 'LINK', basis: 'DOI_CONFIRMED' });

  // Only that channel: the post channel of the same account is still the admin's to write.
  await page.getByTestId('contact-permission-channel').selectOption('POST');
  await expect(locked).toHaveCount(0);
  await expect(page.getByTestId('contact-permission-save')).toBeEnabled();
  await page.getByTestId('contact-permission-basis').selectOption('NONE');
  await page.getByTestId('contact-permission-save').click();
  await expect(page.getByTestId('contact-permission-saved')).toBeVisible({ timeout: 15_000 });
  expect(await prisma.contactPermission.findUnique({ where: { companyId_channel: { companyId: company.id, channel: 'POST' } } })).toMatchObject({
    basis: 'NONE',
    source: 'ADMIN',
  });
});
