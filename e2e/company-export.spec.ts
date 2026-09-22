import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

/**
 * One account, one JSON file (#2435).
 *
 * Three things are asserted, in the order they matter:
 *   1. a role with NO company scope is refused and receives no company data;
 *   2. the admin file really carries every relation the issue lists;
 *   3. a reader whose company scope is narrower gets a NARROWER file — the
 *      export may never be broader than the read it goes through, and a MENTOR
 *      may not read requisitions, offers, the shortlist or the enquiry
 *      anywhere else in the product.
 */
const PASSWORD = 'ExportPass123';
const stamp = Date.now();

const adminEmail = uniqueEmail('cexp-admin');
const mentorEmail = uniqueEmail('cexp-mentor');
const menteeEmail = uniqueEmail('cexp-mentee');

let orgId = '';
let companyId = '';
let relationId = '';
let adminId = '';
let menteeId = '';

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Export Org ${stamp}`, slug: `export-org-${stamp}` },
  });
  orgId = org.id;

  const [admin, mentor, mentee] = await Promise.all([
    seedUser(adminEmail, PASSWORD, 'ADMIN', 'Export Admin'),
    seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Export Mentor'),
    seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Export Mentee'),
  ]);
  adminId = admin.id;
  menteeId = mentee.id;
  await prisma.user.updateMany({ where: { id: { in: [admin.id, mentor.id, mentee.id] } }, data: { orgId } });

  const company = await prisma.company.create({
    data: {
      orgId,
      name: `Export Co ${stamp}`,
      contactEmail: `buyer-${stamp}@export.example`,
      contactName: 'Export Buyer',
      contactPhone: '+49 30 000000',
      vatId: `DE${stamp}`,
      needs: { create: [{ position: 'Werkstudent', count: 2, period: '2026 Q1' }] },
    },
  });
  companyId = company.id;

  const relation = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: mentor.id, menteeId: mentee.id, companyId: company.id },
  });
  relationId = relation.id;

  await Promise.all([
    prisma.interactionLog.create({
      data: { relationId: relation.id, date: new Date(), type: 'Meeting', notes: `export note ${stamp}` },
    }),
    prisma.statusChange.create({
      data: {
        relationId: relation.id,
        fromStatus: 'APPLICATION_100',
        toStatus: 'APPROVAL_PENDING_220',
        changedById: admin.id,
        reasonNote: `export reason ${stamp}`,
      },
    }),
    prisma.requisition.create({
      data: { orgId, companyId: company.id, title: `Export Requisition ${stamp}`, openings: 1 },
    }),
    prisma.offer.create({
      data: { orgId, relationId: relation.id, companyId: company.id, position: 'Intern', createdById: admin.id },
    }),
    prisma.companyInterest.create({
      data: { companyId: company.id, menteeId: mentee.id, status: 'INTERESTED' },
    }),
    prisma.companyInquiry.create({
      data: {
        orgId,
        companyName: `Export Co ${stamp}`,
        contactName: 'Export Buyer',
        email: `buyer-${stamp}@export.example`,
        convertedCompanyId: company.id,
      },
    }),
  ]);
});

test.afterAll(async () => {
  await prisma.offer.deleteMany({ where: { relationId } });
  await prisma.statusChange.deleteMany({ where: { relationId } });
  await prisma.interactionLog.deleteMany({ where: { relationId } });
  await prisma.companyInterest.deleteMany({ where: { companyId } });
  await prisma.companyInquiry.deleteMany({ where: { convertedCompanyId: companyId } });
  await prisma.requisition.deleteMany({ where: { companyId } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
  await prisma.activityLog.deleteMany({ where: { targetId: companyId } });
  for (const email of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(email);
  await prisma.companyNeed.deleteMany({ where: { companyId } });
  await prisma.company.deleteMany({ where: { id: companyId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

test('an admin exports one company with every attached record, and it is audited', async ({ page }) => {
  await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

  const res = await page.request.get(`/api/companies/${companyId}/export`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-disposition']).toContain(`company-${companyId}.json`);

  const data = await res.json();
  expect(data.company.id).toBe(companyId);
  // ADMIN-only columns survive for an ADMIN reader (redactCompanyForReader).
  expect(data.company.vatId).toBe(`DE${stamp}`);
  expect(data.needs).toHaveLength(1);
  expect(data.relations.map((r: { id: string }) => r.id)).toContain(relationId);
  expect(data.interactions.map((i: { notes: string }) => i.notes)).toContain(`export note ${stamp}`);
  expect(data.statusChanges).toHaveLength(1);
  expect(data.statusChanges[0].reasonNote).toBe(`export reason ${stamp}`);
  expect(data.requisitions).toHaveLength(1);
  expect(data.offers).toHaveLength(1);
  expect(data.interests).toHaveLength(1);
  expect(data.inquiries).toHaveLength(1);

  await expect
    .poll(
      async () =>
        prisma.activityLog.count({ where: { action: 'company.export', targetId: companyId, actorId: adminId } }),
      { timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(1);
});

test('a mentor exports only what it may read; a role with no company scope is refused', async ({ page }) => {
  // The mentor is named in the relation, so the company IS in its scope — but
  // the commercial book that hangs off it is not.
  await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
  const mentorRes = await page.request.get(`/api/companies/${companyId}/export`);
  expect(mentorRes.status()).toBe(200);
  const mentorData = await mentorRes.json();
  expect(mentorData.company.id).toBe(companyId);
  expect(mentorData.company.vatId, 'ADMIN-only columns stay ADMIN-only').toBeUndefined();
  expect(mentorData.relations.map((r: { id: string }) => r.id)).toEqual([relationId]);
  for (const section of ['requisitions', 'offers', 'interests', 'inquiries'] as const) {
    expect(mentorData[section], `${section} is withheld, not emptied`).toBeNull();
  }
  expect(mentorData.statusChanges[0].reasonNote, 'the drop-off prose is ADMIN-only').toBeUndefined();

  // MENTEE has no `company` builder at all → 403, an audit row, and not one
  // byte of the account in the body.
  await signInAsFreshUser(page, menteeEmail, PASSWORD, '/portal');
  const denied = await page.request.get(`/api/companies/${companyId}/export`);
  expect(denied.status()).toBe(403);
  const body = await denied.text();
  expect(body).not.toContain(companyId);
  expect(body).not.toContain(`Export Co ${stamp}`);

  await expect
    .poll(
      async () =>
        prisma.activityLog.count({
          where: { action: 'authz.scope_denied', actorId: menteeId, targetId: 'GET /api/companies/[id]/export' },
        }),
      { timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(1);
});
