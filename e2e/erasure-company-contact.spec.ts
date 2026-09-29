import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
// Static imports, not `await import()` inside a test: Playwright resolves the
// `@/…` path alias when it transforms the spec's import graph, but a dynamic
// import is resolved by Node at runtime (see e2e/erasure-free-text.spec.ts).
import { anonymizeUser } from '../src/lib/accountErasure';
import { defaultOrgId } from '../src/lib/defaultOrg';

/**
 * Erase the person, keep the company — and only in the person's own tenant (#2434).
 *
 * `accountErasure.ts` never mentioned `CompanyInquiry`, so an "erased" account
 * read "Erased candidate" while the same person's name, e-mail address and
 * telephone number sat untouched on the enquiry they arrived through and on the
 * account whose primary contact they are (`Company.contact*`, #2407).
 *
 * Both tables are reached by ADDRESS (neither references `User`), and an
 * address is not a tenant boundary: two tenants may each hold the same
 * merchant, and each is its own data controller. With MT_ENFORCE_ISOLATION off
 * — the state production runs in (#2542), and the state this dev server runs
 * in — the Prisma middleware adds no org filter, so these tests are the proof
 * that the hand-written one in src/lib/companyContactErasure.ts holds:
 *
 *   1. through the real admin endpoint (name confirmation, password step-up,
 *      ActivityLog row — all unchanged, no new screen, no second path), a
 *      tenant-A erasure scrubs tenant A's enquiry and company contact, and
 *      leaves tenant B's rows with the SAME address, and not-yet-stamped rows,
 *      exactly as they were;
 *   2. for a default-org subject the not-yet-stamped rows ARE theirs (the
 *      deploy backfill assigns NULL-org rows to the default org), and another
 *      tenant's row still is not.
 *
 * Not `@smoke`: it seeds two tenants and a dozen rows, and erasure is not a
 * runtime-critical path. The pure rule is pinned by
 * scripts/test/company-contact-erasure.test.mjs.
 */

const ADMIN_PASSWORD = 'EraseAdmin123!';
const CONTACT_NAME = 'Company Contact Person';
const PHONE = '+49 30 123456';

type Seeded = {
  orgIds: string[];
  companyIds: string[];
  inquiryIds: string[];
  userIds: string[];
  emails: string[];
};

function tracker(): Seeded {
  return { orgIds: [], companyIds: [], inquiryIds: [], userIds: [], emails: [] };
}

async function seedOrg(s: Seeded, label: string) {
  const org = await prisma.organization.create({
    data: { slug: `erase-${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, name: `Erase ${label}` },
  });
  s.orgIds.push(org.id);
  return org;
}

/** A company whose primary contact is `email`, plus the enquiry it came from. */
async function seedAccount(s: Seeded, orgId: string | null, email: string, label: string) {
  const company = await prisma.company.create({
    data: {
      orgId,
      name: `Erasure Co ${label} ${crypto.randomBytes(3).toString('hex')}`,
      contactEmail: email,
      contactName: CONTACT_NAME,
      contactPhone: PHONE,
    },
  });
  s.companyIds.push(company.id);
  const inquiry = await prisma.companyInquiry.create({
    data: {
      orgId,
      companyName: company.name,
      contactName: CONTACT_NAME,
      email,
      phone: PHONE,
      openRoles: 'Two backend interns',
      message: `We would like to host two interns (${label}).`,
      note: `Called back on Tuesday (${label}).`,
      status: 'CONTACTED',
      convertedCompanyId: company.id,
    },
  });
  s.inquiryIds.push(inquiry.id);
  return { company, inquiry };
}

async function cleanup(s: Seeded) {
  await prisma.companyInquiry.deleteMany({ where: { id: { in: s.inquiryIds } } });
  await prisma.company.deleteMany({ where: { id: { in: s.companyIds } } });
  await prisma.mentorshipRelation.deleteMany({
    where: { OR: [{ menteeId: { in: s.userIds } }, { mentorId: { in: s.userIds } }] },
  });
  // By id, not by address: the anonymise path has already rewritten it.
  await prisma.user.deleteMany({ where: { id: { in: s.userIds } } });
  for (const email of s.emails) await cleanupByEmail(email);
  await prisma.organization.deleteMany({ where: { id: { in: s.orgIds } } }).catch(() => {});
}

/** The row must be exactly as seeded: another tenant's lead is not ours to erase. */
async function expectUntouched(inquiryId: string, companyId: string, email: string) {
  const inquiry = await prisma.companyInquiry.findUnique({ where: { id: inquiryId } });
  expect(inquiry?.email).toBe(email);
  expect(inquiry?.contactName).toBe(CONTACT_NAME);
  expect(inquiry?.phone).toBe(PHONE);
  expect(inquiry?.message).not.toBeNull();
  expect(inquiry?.note).not.toBeNull();
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  expect(company?.contactEmail).toBe(email);
  expect(company?.contactName).toBe(CONTACT_NAME);
  expect(company?.contactPhone).toBe(PHONE);
}

/** The person is gone from the row; the account's own facts are all still there. */
async function expectErased(inquiryId: string, companyId: string, tombstone: string) {
  const inquiry = await prisma.companyInquiry.findUnique({ where: { id: inquiryId } });
  expect(inquiry, 'the enquiry row survives — it is where the account came from').not.toBeNull();
  expect(inquiry?.email).toBe(tombstone);
  expect(inquiry?.contactName).toBe('Erased contact');
  expect(inquiry?.phone).toBeNull();
  expect(inquiry?.note, 'free text written ABOUT them is scrubbed').toBeNull();
  expect(inquiry?.message, 'what they wrote is tombstoned').toBeNull();
  expect(inquiry?.openRoles, 'what the account hires for is not personal data').toBe('Two backend interns');
  expect(inquiry?.status).toBe('CONTACTED');
  expect(inquiry?.convertedCompanyId).toBe(companyId);

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  expect(company, 'the company and its commercial history stay').not.toBeNull();
  expect(company?.name).toBe(inquiry?.companyName);
  expect(company?.contactEmail).toBeNull();
  expect(company?.contactName, 'the named person goes with the address').toBeNull();
  expect(company?.contactPhone).toBeNull();
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('erasing a person clears their enquiry and company contact in their own tenant only', async ({ page }) => {
  const s = tracker();
  try {
    const orgA = await seedOrg(s, 'a');
    const orgB = await seedOrg(s, 'b');
    const adminEmail = uniqueEmail('erase-co-admin');
    const contactEmail = uniqueEmail('erase-co-contact');
    s.emails.push(adminEmail, contactEmail);
    const admin = await seedUser(adminEmail, ADMIN_PASSWORD, 'ADMIN', 'Erase Co Admin');
    const person = await seedUser(contactEmail, 'x', 'MENTEE', CONTACT_NAME);
    s.userIds.push(admin.id, person.id);
    await prisma.user.updateMany({ where: { id: { in: [admin.id, person.id] } }, data: { orgId: orgA.id } });

    const own = await seedAccount(s, orgA.id, contactEmail, 'tenant A');
    // The same merchant, the same contact address, in another tenant.
    const other = await seedAccount(s, orgB.id, contactEmail, 'tenant B');
    // Not yet stamped by the deploy backfill, i.e. the DEFAULT org's — not A's.
    const unstamped = await seedAccount(s, null, contactEmail, 'unstamped');
    // Tenant A, a different person: an address match is the only way in.
    const bystanderEmail = uniqueEmail('erase-co-bystander');
    const bystander = await seedAccount(s, orgA.id, bystanderEmail, 'bystander');

    await signInAndSettle(page, adminEmail, ADMIN_PASSWORD, '/admin');

    // The step-up still guards the path: a wrong admin password changes nothing.
    const refused = await page.request.post(`/api/admin/users/${person.id}/erase`, {
      data: { mode: 'delete', confirmName: CONTACT_NAME, adminPassword: 'WrongPass123!' },
    });
    expect(refused.status()).toBe(400);
    await expectUntouched(own.inquiry.id, own.company.id, contactEmail);

    const ok = await page.request.post(`/api/admin/users/${person.id}/erase`, {
      data: { mode: 'delete', confirmName: CONTACT_NAME, adminPassword: ADMIN_PASSWORD },
    });
    expect(ok.status()).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: person.id } })).toBeNull();

    await expectErased(own.inquiry.id, own.company.id, `erased-${person.id}@erased.local`);
    await expectUntouched(other.inquiry.id, other.company.id, contactEmail);
    await expectUntouched(unstamped.inquiry.id, unstamped.company.id, contactEmail);
    await expectUntouched(bystander.inquiry.id, bystander.company.id, bystanderEmail);
    // Nothing moved tenant on the way.
    expect((await prisma.companyInquiry.findUnique({ where: { id: other.inquiry.id } }))?.orgId).toBe(orgB.id);

    // The audit row is the existing one, unchanged.
    const audit = await prisma.activityLog.findFirst({
      where: { action: 'user.erase.delete', targetId: person.id, actorId: admin.id },
    });
    expect(audit?.detail).toBe(`MENTEE ${CONTACT_NAME}`);
  } finally {
    await prisma.activityLog.deleteMany({ where: { targetId: { in: s.userIds } } });
    await cleanup(s);
  }
});

test('a default-org subject also takes the not-yet-stamped rows, and still never another tenant’s', async () => {
  const s = tracker();
  try {
    const fallbackOrgId = await defaultOrgId();
    const orgB = await seedOrg(s, 'b');
    const contactEmail = uniqueEmail('erase-co-default');
    s.emails.push(contactEmail);
    // No org at all: the default org's, exactly as registration and the
    // deploy backfill would have it.
    const person = await seedUser(contactEmail, 'x', 'MENTEE', CONTACT_NAME);
    s.userIds.push(person.id);

    const stamped = await seedAccount(s, fallbackOrgId, contactEmail, 'default');
    const unstamped = await seedAccount(s, null, contactEmail, 'unstamped');
    const other = await seedAccount(s, orgB.id, contactEmail, 'tenant B');

    await anonymizeUser(person.id);

    const tombstone = `erased-${person.id}@erased.local`;
    // One tombstone vocabulary: the anonymised User row and the enquiry agree.
    expect((await prisma.user.findUnique({ where: { id: person.id } }))?.email).toBe(tombstone);
    await expectErased(stamped.inquiry.id, stamped.company.id, tombstone);
    await expectErased(unstamped.inquiry.id, unstamped.company.id, tombstone);
    await expectUntouched(other.inquiry.id, other.company.id, contactEmail);

    // Re-running is harmless: the second pass matches only its own tombstones.
    await anonymizeUser(person.id);
    await expectErased(stamped.inquiry.id, stamped.company.id, tombstone);
    await expectUntouched(other.inquiry.id, other.company.id, contactEmail);
  } finally {
    await cleanup(s);
  }
});
