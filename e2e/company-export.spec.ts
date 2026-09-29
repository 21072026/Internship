import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInAsFreshUser } from './helpers/auth';

/**
 * One company, one JSON file (#2435) — GET /api/companies/[id]/export.
 *
 * What is pinned, in the order it matters:
 *   1. another org's company cannot be exported by id — 404, nothing of it in
 *      the body, no audit row. This runs on a server with MT_ENFORCE_ISOLATION
 *      OFF (every deployment today), so it holds only because the route's own
 *      org term (#2542 pattern) holds, not because the middleware does;
 *   2. a role that may READ the company (the mentor of one of its relations)
 *      still cannot export it: 403, no company data, an `authz.scope_denied`
 *      row naming the route pattern; a role with no company scope likewise;
 *   3. the admin file is valid JSON and carries every section the issue lists,
 *      including the offer rule (an offer naming ANOTHER company stays out);
 *   4. every served file writes a `company.export` row, and the button on
 *      /admin/companies really downloads that file.
 *
 * Synthetic rows only, minted per run and removed in FK order afterwards.
 */
const PASSWORD = 'ExportPass123';
const stamp = Date.now();
// A name that is hostile to a response header on purpose: quotes, a semicolon
// and Turkish letters. The filename must come out as a plain slug.
const companyName = `Ölçü "Export"; Şirket ${stamp}`;
const expectedSlug = `olcu-export-sirket-${stamp}`;
const foreignName = `Foreign Export Co ${stamp}`;

const adminEmail = uniqueEmail('cexp-admin');
const mentorEmail = uniqueEmail('cexp-mentor');
const menteeEmail = uniqueEmail('cexp-mentee');

let orgId = '';
let foreignOrgId = '';
let companyId = '';
let otherCompanyId = '';
let foreignCompanyId = '';
let relationId = '';
let adminId = '';
let mentorId = '';
let menteeId = '';
const offerIds = { own: '', unlinked: '', otherCompany: '' };

test.beforeAll(async () => {
  const [org, foreignOrg] = await Promise.all([
    prisma.organization.create({ data: { name: `Export Org ${stamp}`, slug: `export-org-${stamp}` } }),
    prisma.organization.create({ data: { name: `Export Foreign Org ${stamp}`, slug: `export-foreign-${stamp}` } }),
  ]);
  orgId = org.id;
  foreignOrgId = foreignOrg.id;

  const [admin, mentor, mentee] = await Promise.all([
    seedUser(adminEmail, PASSWORD, 'ADMIN', 'Export Admin'),
    seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Export Mentor'),
    seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Export Mentee'),
  ]);
  adminId = admin.id;
  mentorId = mentor.id;
  menteeId = mentee.id;
  // The session carries orgId from sign-in, so it is set before anyone signs in.
  await prisma.user.updateMany({ where: { id: { in: [admin.id, mentor.id, mentee.id] } }, data: { orgId } });

  const [company, otherCompany, foreignCompany] = await Promise.all([
    prisma.company.create({
      data: {
        orgId,
        name: companyName,
        contactEmail: `buyer-${stamp}@export.example`,
        contactName: 'Export Buyer',
        contactPhone: '+49 30 000000',
        vatId: `DE${stamp}`,
        needs: { create: [{ position: 'Werkstudent', count: 2, period: '2026 Q1' }] },
      },
    }),
    // Same org, different account: an offer naming it must not ride along in
    // the first company's file just because it sits on one of its relations.
    prisma.company.create({ data: { orgId, name: `Other Export Co ${stamp}` } }),
    prisma.company.create({
      data: {
        orgId: foreignOrgId,
        name: foreignName,
        contactEmail: `foreign-${stamp}@export.example`,
        needs: { create: [{ position: 'Foreign role', count: 1, period: '2026 Q2' }] },
      },
    }),
  ]);
  companyId = company.id;
  otherCompanyId = otherCompany.id;
  foreignCompanyId = foreignCompany.id;

  const relation = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: mentor.id, menteeId: mentee.id, companyId: company.id },
  });
  relationId = relation.id;

  const [own, unlinked, otherCompanyOffer] = await Promise.all([
    prisma.offer.create({
      data: { orgId, relationId, companyId: company.id, position: `Own offer ${stamp}`, createdById: admin.id },
    }),
    prisma.offer.create({
      data: { orgId, relationId, companyId: null, position: `Unlinked offer ${stamp}`, createdById: admin.id },
    }),
    prisma.offer.create({
      data: { orgId, relationId, companyId: otherCompany.id, position: `Other company offer ${stamp}`, createdById: admin.id },
    }),
  ]);
  offerIds.own = own.id;
  offerIds.unlinked = unlinked.id;
  offerIds.otherCompany = otherCompanyOffer.id;

  await Promise.all([
    prisma.interactionLog.create({
      data: { relationId, date: new Date(), type: 'Meeting', notes: `export note ${stamp}` },
    }),
    prisma.statusChange.create({
      data: {
        relationId,
        fromStatus: 'APPLICATION_100',
        toStatus: 'APPROVAL_PENDING_220',
        changedById: admin.id,
        reasonNote: `export reason ${stamp}`,
      },
    }),
    prisma.requisition.create({
      data: { orgId, companyId: company.id, title: `Export Requisition ${stamp}`, openings: 1 },
    }),
    prisma.requisition.create({
      data: { orgId: foreignOrgId, companyId: foreignCompany.id, title: `Foreign Requisition ${stamp}`, openings: 1 },
    }),
    prisma.companyInterest.create({
      data: { companyId: company.id, menteeId: mentee.id, status: 'INTERESTED' },
    }),
    prisma.companyInquiry.create({
      data: {
        orgId,
        companyName,
        contactName: 'Export Buyer',
        email: `buyer-${stamp}@export.example`,
        convertedCompanyId: company.id,
      },
    }),
  ]);
});

test.afterAll(async () => {
  const companyIds = [companyId, otherCompanyId, foreignCompanyId].filter(Boolean);
  const userIds = [adminId, mentorId, menteeId].filter(Boolean);
  await prisma.activityLog.deleteMany({
    where: { OR: [{ targetId: { in: companyIds } }, { actorId: { in: userIds } }] },
  });
  // Offers and stage changes point at the admin (createdById / changedById), so
  // they go before the users; the relation's own cascade would come too late.
  await prisma.offer.deleteMany({ where: { OR: [{ relationId }, { companyId: { in: companyIds } }] } });
  await prisma.statusChange.deleteMany({ where: { relationId } });
  await prisma.interactionLog.deleteMany({ where: { relationId } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
  await prisma.companyInquiry.deleteMany({ where: { convertedCompanyId: { in: companyIds } } });
  for (const email of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(email);
  // Needs, interests and requisitions cascade with their company.
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, foreignOrgId].filter(Boolean) } } });
  await prisma.$disconnect();
});

const exportCount = (targetId: string) =>
  prisma.activityLog.count({ where: { action: 'company.export', targetId } });

test('another org\'s company cannot be exported by id', { tag: '@smoke' }, async ({ page }) => {
  // The row is really there — the 404 below is the org boundary answering, not
  // a missing id.
  expect(await prisma.company.count({ where: { id: foreignCompanyId, orgId: foreignOrgId } })).toBe(1);

  await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
  const res = await page.request.get(`/api/companies/${foreignCompanyId}/export`);
  expect(res.status(), 'a foreign tenant\'s account is a 404, like an id that does not exist').toBe(404);
  const body = await res.text();
  for (const leak of [foreignCompanyId, foreignName, `foreign-${stamp}@export.example`, `Foreign Requisition ${stamp}`]) {
    expect(body, `the 404 must not carry "${leak}"`).not.toContain(leak);
  }
  expect(res.headers()['content-disposition'], 'no file is offered').toBeUndefined();
  expect(await exportCount(foreignCompanyId), 'nothing was exported, so nothing is audited').toBe(0);

  // And an id that does not exist at all gets the very same answer.
  const missing = await page.request.get(`/api/companies/cexp-missing-${stamp}/export`);
  expect(missing.status()).toBe(404);
});

test('a role that may read the company still cannot export it, and the refusal is audited', async ({ page }) => {
  // The mentor is named in one of the company's relations, so the READ route
  // answers it — the export is the operator's alone.
  await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
  const read = await page.request.get(`/api/companies/${companyId}`);
  expect(read.status(), 'precondition: the mentor may read this company').toBe(200);

  const denied = await page.request.get(`/api/companies/${companyId}/export`);
  expect(denied.status()).toBe(403);
  const body = await denied.text();
  expect(body).not.toContain(companyId);
  expect(body).not.toContain(`Export Requisition ${stamp}`);

  // A role with no company scope at all is refused the same way.
  await signInAsFreshUser(page, menteeEmail, PASSWORD, '/portal');
  const menteeDenied = await page.request.get(`/api/companies/${companyId}/export`);
  expect(menteeDenied.status()).toBe(403);
  expect(await menteeDenied.text()).not.toContain(companyId);

  // logScopeDenial() is awaited before the 403 goes out. The target is the
  // route PATTERN, never the requested id.
  for (const actorId of [mentorId, menteeId]) {
    const denial = await prisma.activityLog.findFirst({
      where: { action: 'authz.scope_denied', actorId, targetId: 'GET /api/companies/[id]/export' },
    });
    expect(denial, 'the refusal is audited').not.toBeNull();
  }
  expect(await exportCount(companyId), 'a refusal is not an export').toBe(0);
});

test('an admin exports one company with every section the issue lists, and it is audited', async ({ page }) => {
  const before = await exportCount(companyId);
  await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

  const res = await page.request.get(`/api/companies/${companyId}/export`);
  expect(res.status()).toBe(200);
  const headers = res.headers();
  expect(headers['content-type']).toContain('application/json');
  expect(headers['cache-control']).toContain('no-store');
  expect(headers['content-disposition']).toBe(`attachment; filename="company-${expectedSlug}-${companyId}.json"`);

  // Valid JSON as a FILE, not just something Playwright's json() tolerates.
  const data = JSON.parse(await res.text());
  expect(typeof data.exportedAt).toBe('string');
  expect(data.company.id).toBe(companyId);
  expect(data.company.name).toBe(companyName);
  // The ADMIN-only columns are in an admin's file.
  expect(data.company.vatId).toBe(`DE${stamp}`);
  expect(data.company.contactPhone).toBe('+49 30 000000');

  expect(data.needs.map((n: { position: string }) => n.position)).toEqual(['Werkstudent']);
  expect(data.requisitions.map((r: { title: string }) => r.title)).toEqual([`Export Requisition ${stamp}`]);
  expect(data.interests).toHaveLength(1);
  expect(data.interests[0].menteeId).toBe(menteeId);
  expect(data.inquiries).toHaveLength(1);
  expect(data.inquiries[0].email).toBe(`buyer-${stamp}@export.example`);

  expect(data.relations.map((r: { id: string }) => r.id)).toEqual([relationId]);
  expect(data.relations[0].mentee).toEqual({ id: menteeId, fullName: 'Export Mentee', email: menteeEmail });
  expect(data.relations[0].mentor.id).toBe(mentorId);
  expect(data.relations[0].mentor.password, 'a relation names people, never a whole User row').toBeUndefined();
  expect(data.interactions.map((i: { notes: string }) => i.notes)).toEqual([`export note ${stamp}`]);
  expect(data.statusChanges).toHaveLength(1);
  expect(data.statusChanges[0]).toMatchObject({
    relationId,
    toStatus: 'APPROVAL_PENDING_220',
    reasonNote: `export reason ${stamp}`,
  });

  // The company's own offer and the one with no company on its relation are
  // this account's; the one naming another company is that company's.
  const offerIdsInFile = data.offers.map((o: { id: string }) => o.id).sort();
  expect(offerIdsInFile).toEqual([offerIds.own, offerIds.unlinked].sort());
  expect(offerIdsInFile).not.toContain(offerIds.otherCompany);

  // Nothing of the other tenant rides along.
  const text = JSON.stringify(data);
  expect(text).not.toContain(foreignCompanyId);
  expect(text).not.toContain(`Foreign Requisition ${stamp}`);

  // logActivity() is awaited before the file goes out, so the row is there.
  expect(await exportCount(companyId), 'one served file, one row').toBe(before + 1);
  const audit = await prisma.activityLog.findFirst({
    where: { action: 'company.export', targetId: companyId },
    orderBy: { createdAt: 'desc' },
  });
  expect(audit).toMatchObject({
    actorId: adminId,
    actorEmail: adminEmail,
    targetType: 'company',
    // No company name: the activity feed is not tenant-scoped yet (#2433).
    detail: null,
  });
});

test('the export button on /admin/companies downloads the file, and each download is audited', async ({ page }) => {
  const before = await exportCount(companyId);
  await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
  await gotoSettled(page, '/admin/companies');
  // The grid is paged; search so the seeded company is on the first page.
  await page.getByTestId('companies-search').fill(String(stamp));
  const button = page.getByTestId(`export-company-${companyId}`);
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(button).toHaveAttribute('aria-label', 'Export all data (JSON)');

  const downloadStarted = page.waitForEvent('download', { timeout: 20_000 });
  await button.click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe(`company-${expectedSlug}-${companyId}.json`);
  const path = await download.path();
  expect(path, 'the download completed').toBeTruthy();
  const file = JSON.parse(await readFile(path as string, 'utf8'));
  expect(file.company.id).toBe(companyId);
  expect(file.relations.map((r: { id: string }) => r.id)).toEqual([relationId]);

  // A second copy leaving the system is a second row — no repeat suppression.
  expect(await exportCount(companyId)).toBe(before + 1);
});
