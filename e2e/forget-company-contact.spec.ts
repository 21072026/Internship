import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * Forget a company contact who never had an account (#2559, DSGVO Art. 17).
 *
 * A web enquiry's sender, or the named person on an imported account, exists
 * only as an ADDRESS on CompanyInquiry and Company.contact* — the account
 * erasure starts from a User row and could never reach them. This pins the
 * admin action that can: the #2434 rule (scrub the person, keep the company,
 * the admin's own tenant only), behind the same step-up as the account erasure.
 */

const PW = 'ForgetAdmin123!';
const CONTACT_NAME = 'Forgettable Person';
const PHONE = '+49 30 999999';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seed() {
  const tag = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { slug: `forget-a-${tag}`, name: `Forget A ${tag}` } });
  const orgB = await prisma.organization.create({ data: { slug: `forget-b-${tag}`, name: `Forget B ${tag}` } });
  const adminEmail = uniqueEmail('forget-admin');
  const repEmail = uniqueEmail('forget-rep');
  const accountEmail = uniqueEmail('forget-has-account');
  const contact = uniqueEmail('forget-contact').toLowerCase();
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Forget Admin');
  const rep = await seedUser(repEmail, PW, 'MENTOR', 'Forget Rep');
  const withAccount = await seedUser(accountEmail, PW, 'MENTEE', 'Has Account');
  await prisma.user.updateMany({ where: { id: { in: [admin.id, rep.id, withAccount.id] } }, data: { orgId: orgA.id } });

  const account = async (orgId: string, label: string) => {
    const company = await prisma.company.create({
      data: { orgId, name: `Forget Co ${label} ${tag}`, contactEmail: contact, contactName: CONTACT_NAME, contactPhone: PHONE },
    });
    const inquiry = await prisma.companyInquiry.create({
      data: {
        orgId, companyName: company.name, contactName: CONTACT_NAME, email: contact, phone: PHONE,
        openRoles: 'Two seats', message: `Please call me (${label})`, note: `Called back (${label})`,
        status: 'CONTACTED', convertedCompanyId: company.id,
      },
    });
    return { company, inquiry };
  };
  const own = await account(orgA.id, 'own');
  const other = await account(orgB.id, 'other');

  return {
    adminEmail, repEmail, accountEmail, contact, own, other, admin,
    cleanup: async () => {
      await prisma.companyInquiry.deleteMany({ where: { id: { in: [own.inquiry.id, other.inquiry.id] } } });
      await prisma.company.deleteMany({ where: { id: { in: [own.company.id, other.company.id] } } });
      await prisma.activityLog.deleteMany({ where: { actorId: admin.id } });
      for (const e of [adminEmail, repEmail, accountEmail]) await cleanupByEmail(e);
      await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    },
  };
}

test('an admin forgets an account-less contact in their own tenant only (#2559)', async ({ page }) => {
  const s = await seed();
  try {
    await signInAndSettle(page, s.adminEmail, PW, '/admin');
    const post = (data: Record<string, string>) => page.request.post('/api/admin/company-contacts/forget', { data });

    // The misclick guard and the step-up both refuse, and neither writes.
    expect((await post({ email: s.contact, confirmEmail: 'someone@else.example', adminPassword: PW })).status()).toBe(400);
    expect((await post({ email: s.contact, confirmEmail: s.contact, adminPassword: 'WrongPass123!' })).status()).toBe(400);
    expect((await prisma.companyInquiry.findUniqueOrThrow({ where: { id: s.own.inquiry.id } })).email).toBe(s.contact);

    // A differently-cased retype is the same address.
    const ok = await post({ email: s.contact.toUpperCase(), confirmEmail: s.contact, adminPassword: PW });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, inquiries: 1, companies: 1 });

    const inquiry = await prisma.companyInquiry.findUniqueOrThrow({ where: { id: s.own.inquiry.id } });
    expect(inquiry.contactName).toBe('Erased contact');
    expect(inquiry.email).toMatch(/^erased-contact-[0-9a-f-]+@erased\.local$/);
    expect([inquiry.phone, inquiry.note, inquiry.message]).toEqual([null, null, null]);
    // The account's facts stay.
    expect([inquiry.openRoles, inquiry.status, inquiry.convertedCompanyId]).toEqual(['Two seats', 'CONTACTED', s.own.company.id]);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: s.own.company.id } });
    expect([company.contactEmail, company.contactName, company.contactPhone]).toEqual([null, null, null]);
    expect(company.name).toBe(s.own.company.name);

    // Another tenant's lead with the same address is not ours to erase.
    const otherInquiry = await prisma.companyInquiry.findUniqueOrThrow({ where: { id: s.other.inquiry.id } });
    expect([otherInquiry.email, otherInquiry.contactName, otherInquiry.phone]).toEqual([s.contact, CONTACT_NAME, PHONE]);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: s.other.company.id } })).contactEmail).toBe(s.contact);

    // One audit row, and it does not keep the address it was asked to forget.
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'company_contact.forget', actorId: s.admin.id } });
    expect(log.detail).toBe('1 enquiries, 1 companies');
    expect(JSON.stringify(log)).not.toContain(s.contact);

    // Nothing left to forget here now.
    expect((await post({ email: s.contact, confirmEmail: s.contact, adminPassword: PW })).status()).toBe(404);
  } finally {
    await s.cleanup();
  }
});

test('an address with an account is sent to the account erasure, and a non-admin is refused (#2559)', async ({ page, browser }) => {
  const s = await seed();
  const repCtx = await browser.newContext();
  try {
    await signInAndSettle(page, s.adminEmail, PW, '/admin');
    const res = await page.request.post('/api/admin/company-contacts/forget', {
      data: { email: s.accountEmail, confirmEmail: s.accountEmail, adminPassword: PW },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('has_account');

    const repPage = await repCtx.newPage();
    await signInAndSettle(repPage, s.repEmail, PW, '/');
    const refused = await repPage.request.post('/api/admin/company-contacts/forget', {
      data: { email: s.contact, confirmEmail: s.contact, adminPassword: PW },
    });
    expect(refused.status()).toBe(401);
    expect((await prisma.companyInquiry.findUniqueOrThrow({ where: { id: s.own.inquiry.id } })).email).toBe(s.contact);
  } finally {
    await repCtx.close();
    await s.cleanup();
  }
});
