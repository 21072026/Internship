import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can anonymize a candidate (wrong-name confirm is rejected)', async ({ page }) => {
  const adminEmail = uniqueEmail('erase-admin');
  const menteeEmail = uniqueEmail('erase-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Erase Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Anonymize Me');
  await prisma.user.update({ where: { id: mentee.id }, data: { university: 'TU Munich', city: 'Munich' } });
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: 3, data: Buffer.from('abc') },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByText(/Danger zone/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^Anonymize$/i }).click();

    // Wrong name → the confirm button stays disabled; nothing happens.
    const nameInput = page.getByTestId('erasure-confirm-name');
    await nameInput.fill('Wrong Name');
    // The admin's own password is the second gate (#1036 follow-up): fill it so
    // the disabled state below is about the name, not the missing password.
    await page.getByTestId('erasure-admin-password').fill('AdminPass123');
    await expect(page.getByRole('button', { name: /^Yes, anonymize$/i })).toBeDisabled();

    // Correct name → succeeds.
    await nameInput.fill('Anonymize Me');
    await page.getByRole('button', { name: /^Yes, anonymize$/i }).click();

    await expect(async () => {
      const after = await prisma.user.findUnique({ where: { id: mentee.id } });
      expect(after?.fullName).toBe('Erased candidate');
      expect(after?.university).toBeNull();
      expect(after?.isActive).toBe(false);
      const cv = await prisma.cvFile.findUnique({ where: { userId: mentee.id } });
      expect(cv).toBeNull();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await prisma.user.deleteMany({ where: { id: mentee.id } });
    await cleanupByEmail(adminEmail);
  }
});

/**
 * Erase the person, keep the company (#2434).
 *
 * The enquiry a merchant arrived through and the account's primary contact both
 * hold a named human's e-mail, name and telephone number, and `accountErasure`
 * did not mention either table — so an "erased" account's row said "Erased
 * candidate" while the same person's details sat untouched on the company next
 * to it. The commercial record itself (the Company row, its name, its needs)
 * must survive, which is the other half of what is asserted here.
 *
 * Deliberately the SAME endpoint and the SAME step-up as the two tests above —
 * this task added no screen and no second erasure path — so the wrong-password
 * probe below is also the assertion that the gate still stands.
 */
test('erasing a person clears the enquiry and the company contact, and keeps the company', async ({ page }) => {
  const adminEmail = uniqueEmail('erase-admin3');
  const contactEmail = uniqueEmail('erase-contact');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Erase Admin 3');
  const person = await seedUser(contactEmail, 'x', 'MENTEE', 'Company Contact Person');
  const company = await prisma.company.create({
    data: {
      name: `Erasure Co ${Date.now()}`,
      contactEmail,
      contactName: 'Company Contact Person',
      contactPhone: '+49 30 123456',
    },
  });
  const inquiry = await prisma.companyInquiry.create({
    data: {
      companyName: company.name,
      contactName: 'Company Contact Person',
      email: contactEmail,
      phone: '+49 30 123456',
      message: 'We would like to host two interns.',
      note: 'Called back on Tuesday.',
      convertedCompanyId: company.id,
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Step-up still guards the path: a wrong admin password changes nothing.
    const refused = await page.request.post(`/api/admin/users/${person.id}/erase`, {
      data: { mode: 'delete', confirmName: 'Company Contact Person', adminPassword: 'WrongPass123' },
    });
    expect(refused.status()).toBe(400);
    expect((await prisma.companyInquiry.findUnique({ where: { id: inquiry.id } }))?.email).toBe(contactEmail);

    const ok = await page.request.post(`/api/admin/users/${person.id}/erase`, {
      data: { mode: 'delete', confirmName: 'Company Contact Person', adminPassword: 'AdminPass123' },
    });
    expect(ok.status()).toBe(200);

    const after = await prisma.companyInquiry.findUnique({ where: { id: inquiry.id } });
    expect(after, 'the enquiry row itself survives — it is where the account came from').not.toBeNull();
    expect(after?.email).not.toBe(contactEmail);
    expect(after?.email).toMatch(/^erased-.*@erased\.local$/);
    expect(after?.contactName).toBe('Erased contact');
    expect(after?.phone).toBeNull();
    expect(after?.note, 'free text written ABOUT them is scrubbed').toBeNull();
    expect(after?.message, 'what they wrote is tombstoned').toBeNull();
    expect(after?.companyName, 'the account is not personal data').toBe(company.name);

    const companyAfter = await prisma.company.findUnique({ where: { id: company.id } });
    expect(companyAfter, 'the company and its commercial history stay').not.toBeNull();
    expect(companyAfter?.name).toBe(company.name);
    expect(companyAfter?.contactEmail).toBeNull();
    expect(companyAfter?.contactName, 'the named person goes with the address').toBeNull();
    expect(companyAfter?.contactPhone).toBeNull();

    expect(await prisma.user.findUnique({ where: { id: person.id } })).toBeNull();
  } finally {
    await prisma.companyInquiry.deleteMany({ where: { id: inquiry.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    await prisma.user.deleteMany({ where: { id: person.id } });
    await cleanupByEmail(adminEmail);
  }
});

test('admin can permanently delete a candidate; the erase endpoint refuses self-targeting and a missing password', async ({ page }) => {
  const adminEmail = uniqueEmail('erase-admin2');
  const menteeEmail = uniqueEmail('erase-mentee2');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Erase Admin 2');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Delete Me Fully');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByText(/Danger zone/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^Delete permanently$/i }).click();
    await page.getByTestId('erasure-confirm-name').fill('Delete Me Fully');
    await page.getByTestId('erasure-admin-password').fill('AdminPass123');
    await page.getByRole('button', { name: /^Yes, delete permanently$/i }).click();

    await page.waitForURL('**/admin/candidates', { timeout: 10_000 });
    await expect.poll(async () => prisma.user.findUnique({ where: { id: mentee.id } })).toBeNull();

    // Guard: an admin cannot erase their own account through the admin path.
    const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
    const guardRes = await page.request.post(`/api/admin/users/${admin!.id}/erase`, {
      data: { mode: 'delete', confirmName: admin!.fullName, adminPassword: 'AdminPass123' },
    });
    expect(guardRes.status()).toBe(400);
    const adminAfter = await prisma.user.findUnique({ where: { id: admin!.id } });
    expect(adminAfter).not.toBeNull();

    // Guard: the admin's own password is required, and a wrong one is refused.
    const noPwRes = await page.request.post(`/api/admin/users/${admin!.id}/erase`, {
      data: { mode: 'delete', confirmName: admin!.fullName },
    });
    expect(noPwRes.status()).toBe(400);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
