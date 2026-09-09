import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PASSWORD = 'AdminPass123';

/** A public enquiry, exactly as /for-companies leaves it: NEW and org-less. */
async function seedInquiry(email: string, companyName: string) {
  return prisma.companyInquiry.create({
    data: {
      companyName,
      contactName: 'Ada Lovelace',
      email,
      openRoles: 'Two junior developers',
      status: 'NEW',
      consentAt: new Date(),
    },
    select: { id: true },
  });
}

async function dropInquiry(inquiryId: string) {
  const inquiry = await prisma.companyInquiry
    .findUnique({ where: { id: inquiryId }, select: { convertedCompanyId: true } })
    .catch(() => null);
  await prisma.companyInquiry.delete({ where: { id: inquiryId } }).catch(() => {});
  if (inquiry?.convertedCompanyId) {
    await prisma.company.delete({ where: { id: inquiry.convertedCompanyId } }).catch(() => {});
  }
}

// #1863: an inbound enquiry used to be re-keyed by hand into a Company and a
// login across three screens. One action now does it — and the properties that
// make it safe to click are the ones worth pinning: the login is an INVITATION
// (nobody sets a password for somebody else, and no credential is ever in the
// response), both new rows carry a tenant, and a second conversion is refused.
test('an admin converts an enquiry into a company plus an invited login', async ({ page }) => {
  const adminEmail = uniqueEmail('convert-admin');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Convert Admin');
  const contactEmail = uniqueEmail('convert-contact');
  const companyName = `Convert Talent ${Date.now()}`;
  const inquiry = await seedInquiry(contactEmail, companyName);

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
    await page.goto('/admin/company-inquiries');

    // Scoped to the row's own testid: AdminNav renders its own search box and
    // several buttons on every admin page, so nothing here is looked up by role
    // name alone.
    await page.getByTestId(`convert-inquiry-${inquiry.id}`).click();
    const dialog = page.getByTestId('convert-inquiry-dialog');
    await expect(dialog).toBeVisible();

    // Prefilled from the enquiry, and editable before submit.
    await expect(dialog.getByTestId('convert-company-name')).toHaveValue(companyName);
    await expect(dialog.getByTestId('convert-email')).toHaveValue(contactEmail);
    await dialog.getByTestId('convert-industry').fill('Software');

    await dialog.getByTestId('convert-inquiry-submit').click();
    await expect(page.getByTestId('convert-inquiry-success')).toBeVisible({ timeout: 20_000 });

    // The Company exists, with the acting admin's tenant on it — a row with a
    // NULL orgId would simply vanish once isolation is enforced (#1557).
    const company = await prisma.company.findFirst({ where: { name: companyName } });
    expect(company).not.toBeNull();
    expect(company!.orgId).not.toBeNull();
    expect(company!.contactEmail).toBe(contactEmail);
    expect(company!.industry).toBe('Software');
    if (admin.orgId) expect(company!.orgId).toBe(admin.orgId);

    // The login is an INVITATION, not an account: no User row yet, and the
    // invitee will register themselves and choose their own password.
    expect(await prisma.user.count({ where: { email: contactEmail } })).toBe(0);
    const invitation = await prisma.invitationToken.findFirst({ where: { email: contactEmail } });
    expect(invitation).not.toBeNull();
    expect(invitation!.role).toBe('COMPANY');
    // Without companyId the COMPANY account would sign in to nothing.
    expect(invitation!.companyId).toBe(company!.id);
    expect(invitation!.orgId).toBe(company!.orgId);
    expect(invitation!.used).toBe(false);

    // The enquiry is stamped, not deleted — it is the record of where the
    // relationship came from.
    const stamped = await prisma.companyInquiry.findUnique({ where: { id: inquiry.id } });
    expect(stamped!.convertedCompanyId).toBe(company!.id);
    expect(stamped!.convertedAt).not.toBeNull();
    expect(stamped!.status).toBe('CLOSED');
    expect(stamped!.handledById).toBe(admin.id);

    // And the row now links to what it became instead of offering the action
    // a second time.
    await page.getByTestId('convert-inquiry-done').click();
    await page.goto('/admin/company-inquiries');
    await page.getByRole('button', { name: 'All' }).click();
    await expect(page.getByTestId(`inquiry-converted-${inquiry.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`convert-inquiry-${inquiry.id}`)).toHaveCount(0);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: contactEmail } });
    await dropInquiry(inquiry.id);
    await prisma.company.deleteMany({ where: { name: companyName } });
    await cleanupByEmail(adminEmail);
  }
});

test('a second conversion of the same enquiry is refused, and the set-password link is never returned', async ({ page }) => {
  const adminEmail = uniqueEmail('convert-twice-admin');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Convert Twice Admin');
  const contactEmail = uniqueEmail('convert-twice-contact');
  const companyName = `Convert Twice ${Date.now()}`;
  const inquiry = await seedInquiry(contactEmail, companyName);

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

    const first = await page.request.post(`/api/admin/company-inquiries/${inquiry.id}/convert`, {
      data: { companyName, contactFullName: 'Ada Lovelace', email: contactEmail },
    });
    expect(first.status()).toBe(201);
    const created = await first.json();
    expect(created.companyId).toBeTruthy();
    expect(typeof created.emailSent).toBe('boolean');
    // A live credential must never be in an HTTP response body (#987): it would
    // be in reverse-proxy logs, devtools and every screen share.
    expect(created.token).toBeUndefined();
    expect(created.registerUrl).toBeUndefined();
    expect(JSON.stringify(created)).not.toMatch(/[0-9a-f]{40}/);

    // Second click on the same row: refused, and it names what the enquiry
    // already became so the admin can go and look at it.
    const second = await page.request.post(`/api/admin/company-inquiries/${inquiry.id}/convert`, {
      data: { companyName, contactFullName: 'Ada Lovelace', email: contactEmail },
    });
    expect(second.status()).toBe(409);
    const refusal = await second.json();
    expect(refusal.error).toBe('already_converted');
    expect(refusal.companyId).toBe(created.companyId);
    expect(refusal.companyName).toBe(companyName);

    // Exactly one of each, which is the whole point.
    expect(await prisma.company.count({ where: { name: companyName } })).toBe(1);
    expect(await prisma.invitationToken.count({ where: { email: contactEmail } })).toBe(1);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: contactEmail } });
    await dropInquiry(inquiry.id);
    await prisma.company.deleteMany({ where: { name: companyName } });
    await cleanupByEmail(adminEmail);
  }
});

test('converting an enquiry whose address already has an account is refused and names that company', async ({ page }) => {
  const adminEmail = uniqueEmail('convert-taken-admin');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Convert Taken Admin');
  const takenEmail = uniqueEmail('convert-taken-contact');
  const existingCompanyName = `Existing Holder ${Date.now()}`;
  const existing = await prisma.company.create({ data: { name: existingCompanyName } });
  const holder = await seedUser(takenEmail, PASSWORD, 'COMPANY', 'Existing Holder Login');
  await prisma.user.update({ where: { id: holder.id }, data: { companyId: existing.id } });
  const inquiry = await seedInquiry(takenEmail, `Duplicate Enquiry ${Date.now()}`);

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

    const res = await page.request.post(`/api/admin/company-inquiries/${inquiry.id}/convert`, {
      data: { companyName: 'Duplicate Enquiry', contactFullName: 'Ada Lovelace', email: takenEmail },
    });
    expect(res.status()).toBe(409);
    const refusal = await res.json();
    expect(refusal.error).toBe('email_taken');
    // Naming the company is the point: the admin should link the enquiry to the
    // account that exists, not invent a second one.
    expect(refusal.companyName).toBe(existingCompanyName);

    // Nothing was created, and the enquiry was left alone.
    expect(await prisma.company.count({ where: { name: 'Duplicate Enquiry' } })).toBe(0);
    expect(await prisma.invitationToken.count({ where: { email: takenEmail } })).toBe(0);
    const untouched = await prisma.companyInquiry.findUnique({ where: { id: inquiry.id } });
    expect(untouched!.convertedCompanyId).toBeNull();
    expect(untouched!.status).toBe('NEW');
  } finally {
    await dropInquiry(inquiry.id);
    await cleanupByEmail(takenEmail);
    await prisma.company.delete({ where: { id: existing.id } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
