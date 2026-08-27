import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
import { mapCompanyNeedToRequisition } from '../scripts/requisition-backfill-lib.mjs';

const execFileAsync = promisify(execFile);

const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const password = 'ReqPass123!';
const emails = {
  adminA: uniqueEmail('req-admin-a'), adminB: uniqueEmail('req-admin-b'),
  companyA: uniqueEmail('req-company-a'), companyA2: uniqueEmail('req-company-a2'),
  companyAOther: uniqueEmail('req-company-a-other'), inactiveOwner: uniqueEmail('req-inactive-owner'),
  companyB: uniqueEmail('req-company-b'), unassigned: uniqueEmail('req-unassigned'),
  mentor: uniqueEmail('req-mentor'), mentee: uniqueEmail('req-mentee'), source: uniqueEmail('req-source'),
};
let orgA: { id: string }; let orgB: { id: string }; let companyA: { id: string }; let companyAOther: { id: string }; let companyB: { id: string };
let ownerA2: { id: string }; let sameOrgOtherCompanyOwner: { id: string }; let inactiveOwner: { id: string }; let foreignOwner: { id: string }; let foreignReqId = '';

async function login(page: Page, email: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'));
}

test.describe.serial('Story #806 requisitions', () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(password, 10);
    orgA = await prisma.organization.create({ data: { name: `Req Org A ${stamp}`, slug: `req-a-${stamp}` } });
    orgB = await prisma.organization.create({ data: { name: `Req Org B ${stamp}`, slug: `req-b-${stamp}` } });
    companyA = await prisma.company.create({ data: { name: `Req Company A ${stamp}`, orgId: orgA.id } });
    companyAOther = await prisma.company.create({ data: { name: `Req Company A Other ${stamp}`, orgId: orgA.id } });
    companyB = await prisma.company.create({ data: { name: `Req Company B ${stamp}`, orgId: orgB.id } });
    const createUser = (email: string, role: 'ADMIN' | 'COMPANY' | 'MENTOR' | 'MENTEE' | 'SOURCE', orgId: string, companyId?: string) =>
      prisma.user.create({ data: { email, password: hash, fullName: email.split('@')[0], role, orgId, companyId, skills: [] } });
    await createUser(emails.adminA, 'ADMIN', orgA.id); await createUser(emails.adminB, 'ADMIN', orgB.id);
    await createUser(emails.companyA, 'COMPANY', orgA.id, companyA.id);
    ownerA2 = await createUser(emails.companyA2, 'COMPANY', orgA.id, companyA.id);
    sameOrgOtherCompanyOwner = await createUser(emails.companyAOther, 'COMPANY', orgA.id, companyAOther.id);
    inactiveOwner = await prisma.user.create({ data: { email: emails.inactiveOwner, password: hash, fullName: 'Inactive Owner', role: 'COMPANY', orgId: orgA.id, companyId: companyA.id, skills: [], isActive: false } });
    foreignOwner = await createUser(emails.companyB, 'COMPANY', orgB.id, companyB.id);
    await createUser(emails.unassigned, 'COMPANY', orgA.id);
    await createUser(emails.mentor, 'MENTOR', orgA.id); await createUser(emails.mentee, 'MENTEE', orgA.id); await createUser(emails.source, 'SOURCE', orgA.id);
    const foreign = await prisma.requisition.create({ data: { orgId: orgB.id, companyId: companyB.id, title: `Foreign ${stamp}`, openings: 1, requiredSkills: [] } });
    foreignReqId = foreign.id;
  });

  test.afterAll(async () => {
    await prisma.requisition.deleteMany({ where: { orgId: { in: [orgA?.id, orgB?.id].filter(Boolean) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [companyA?.id, companyAOther?.id, companyB?.id].filter(Boolean) } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: [orgA?.id, orgB?.id].filter(Boolean) } } }).catch(() => {});
    await prisma.$disconnect();
  });

  test('COMPANY is company-scoped and create input is normalized', async ({ page }) => {
    await login(page, emails.companyA);
    const foreignGet = await page.request.get(`/api/requisitions/${foreignReqId}`);
    expect(foreignGet.status()).toBe(404);
    expect((await page.request.patch(`/api/requisitions/${foreignReqId}`, { data: { title: 'Nope' } })).status()).toBe(404);
    expect((await page.request.post('/api/requisitions', { data: { companyId: companyB.id, title: 'Nope', openings: 1, requiredSkills: [] } })).status()).toBe(403);

    const created = await page.request.post('/api/requisitions', { data: {
      title: `Backend ${stamp}`, status: 'OPEN', openings: 2, filled: 1,
      requiredSkills: [' React ', '', 'react', ' TypeScript ', 'İngilizce', 'ingilizce', 'Işletme', 'ışletme', 'IT', 'ıt'],
    } });
    expect(created.status()).toBe(201);
    const body = await created.json();
    expect(body.requisition.companyId).toBe(companyA.id);
    expect(body.requisition.requiredSkills).toEqual(['React', 'TypeScript', 'İngilizce', 'Işletme', 'IT']);
    const list = await (await page.request.get('/api/requisitions')).json();
    expect(list.requisitions.some((item: { id: string }) => item.id === foreignReqId)).toBe(false);
    const paged = await (await page.request.get('/api/requisitions?page=1&pageSize=1')).json();
    expect(paged.pageSize).toBe(1); expect(paged.total).toBeGreaterThanOrEqual(1); expect(paged.requisitions).toHaveLength(1);
    await page.goto('/company/requisitions');
    await expect(page.getByTestId('company-requisitions')).toBeVisible();
  });

  test('validation, owner checks, protected fields and lifecycle are enforced', async ({ page }) => {
    await login(page, emails.adminA);
    const post = (data: Record<string, unknown>) => page.request.post('/api/requisitions', { data: { companyId: companyA.id, title: 'Valid', openings: 1, filled: 0, requiredSkills: [], ...data } });
    expect((await post({ title: '   ' })).status()).toBe(400);
    expect((await post({ openings: 0 })).status()).toBe(400);
    expect((await post({ filled: -1 })).status()).toBe(400);
    expect((await post({ filled: 2 })).status()).toBe(409);
    expect((await post({ requiredSkills: 'React' })).status()).toBe(400);
    expect((await post({ status: 'UNKNOWN' })).status()).toBe(400);
    expect((await post({ startDate: 'not-a-date' })).status()).toBe(400);
    expect((await post({ ownerId: foreignOwner.id })).status()).toBe(400);
    expect((await post({ ownerId: sameOrgOtherCompanyOwner.id })).status()).toBe(400);
    expect((await post({ ownerId: inactiveOwner.id })).status()).toBe(400);
    const validOwner = await post({ ownerId: ownerA2.id });
    expect(validOwner.status()).toBe(201);
    expect((await validOwner.json()).requisition.ownerId).toBe(ownerA2.id);
    const protectedRes = await post({ orgId: orgB.id });
    expect(protectedRes.status()).toBe(403);
    expect((await protectedRes.json()).code).toBe('protected_fields');

    const created = await post({ openings: 3, filled: 2, status: 'OPEN' });
    const item = (await created.json()).requisition;
    expect((await page.request.patch(`/api/requisitions/${item.id}`, { data: { openings: 1 } })).status()).toBe(409);
    const cancelled = await page.request.patch(`/api/requisitions/${item.id}`, { data: { status: 'CANCELLED' } });
    const cancelledItem = (await cancelled.json()).requisition;
    expect(cancelledItem.closedAt).toBeTruthy(); expect(cancelledItem.openings).toBe(3); expect(cancelledItem.filled).toBe(2);
    const reopened = await page.request.patch(`/api/requisitions/${item.id}`, { data: { status: 'ON_HOLD' } });
    expect((await reopened.json()).requisition.closedAt).toBeNull();
  });

  test('concurrent count PATCH allows one winner and preserves the invariant', async ({ page }) => {
    await login(page, emails.adminA);
    const created = await page.request.post('/api/requisitions', { data: {
      companyId: companyA.id, title: `Concurrent ${stamp}`, status: 'OPEN', openings: 3, filled: 0, requiredSkills: [],
    } });
    expect(created.status()).toBe(201);
    const id = (await created.json()).requisition.id as string;

    const [filledUpdate, openingsUpdate] = await Promise.all([
      page.request.patch(`/api/requisitions/${id}`, { data: { filled: 1 } }),
      page.request.patch(`/api/requisitions/${id}`, { data: { openings: 2 } }),
    ]);
    const responses = [filledUpdate, openingsUpdate];
    expect(responses.filter((response) => response.status() === 200)).toHaveLength(1);
    const conflict = responses.find((response) => response.status() === 409);
    expect(conflict).toBeTruthy();
    expect((await conflict!.json()).code).toBe('concurrent_update');

    const final = await prisma.requisition.findUniqueOrThrow({ where: { id } });
    expect(final.openings).toBeGreaterThanOrEqual(1);
    expect(final.filled).toBeGreaterThanOrEqual(0);
    expect(final.filled).toBeLessThanOrEqual(final.openings);
  });

  for (const [role, email] of [['MENTOR', emails.mentor], ['MENTEE', emails.mentee], ['SOURCE', emails.source]] as const) {
    test(`${role} is forbidden`, async ({ page }) => { await login(page, email); expect((await page.request.get('/api/requisitions')).status()).toBe(403); });
  }
  test('unassigned COMPANY fails closed and ADMIN cannot cross tenants', async ({ page }) => {
    await login(page, emails.unassigned); const unassigned = await page.request.get('/api/requisitions');
    expect(unassigned.status()).toBe(403); expect((await unassigned.json()).code).toBe('company_not_assigned');
    // Switching users in the same page needs the fresh-user guards — a blanket
    // clearCookies + login races the old session being re-issued (see helpers/auth.ts).
    await signInAsFreshUser(page, emails.adminA, password, '/admin');
    expect((await page.request.get(`/api/requisitions/${foreignReqId}`)).status()).toBe(404);
  });
});

test('backfill mapping preserves legacy data and rejects unresolved orgs', () => {
  const mapped = mapCompanyNeedToRequisition({ id: 'need-1', companyId: 'company-1', position: 'Developer', count: 2, period: 'Winter 2026', company: { orgId: 'org-1' } });
  expect(mapped).toMatchObject({ legacyCompanyNeedId: 'need-1', orgId: 'org-1', companyId: 'company-1', title: 'Developer', openings: 2, status: 'OPEN', requiredSkills: [] });
  expect(mapped.description).toContain('Winter 2026');
  expect(mapCompanyNeedToRequisition({ id: 'need-1', companyId: 'company-1', position: 'Developer', count: 2, period: 'Winter 2026', company: { orgId: 'org-1' } }).legacyCompanyNeedId).toBe(mapped.legacyCompanyNeedId);
  expect(() => mapCompanyNeedToRequisition({ id: 'need-2', companyId: 'company-2', company: { orgId: null } })).toThrow(/missing_org/);
});

test('manual backfill is DB-idempotent and leaves CompanyNeed unchanged', async () => {
  const backfillStamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
  const org = await prisma.organization.create({ data: { name: `Backfill Org ${backfillStamp}`, slug: `backfill-${backfillStamp}` } });
  const company = await prisma.company.create({ data: { name: `Backfill Company ${backfillStamp}`, orgId: org.id } });
  const need = await prisma.companyNeed.create({ data: { companyId: company.id, position: `Engineer ${backfillStamp}`, count: 3, period: 'Winter 2027' } });
  const expected = { companyId: need.companyId, position: need.position, count: need.count, period: need.period };
  const runBackfill = async () => {
    try {
      await execFileAsync(process.execPath, ['scripts/backfill-requisitions.mjs'], { cwd: process.cwd(), env: process.env });
    } catch {
      // An unrelated legacy row without orgId makes the manual script exit
      // non-zero by design. Assertions below still prove this seeded row was
      // processed safely and idempotently.
    }
  };

  try {
    await runBackfill();
    expect(await prisma.requisition.count({ where: { legacyCompanyNeedId: need.id } })).toBe(1);
    await runBackfill();
    expect(await prisma.requisition.count({ where: { legacyCompanyNeedId: need.id } })).toBe(1);
    const original = await prisma.companyNeed.findUniqueOrThrow({ where: { id: need.id } });
    expect(original).toMatchObject(expected);
  } finally {
    await prisma.requisition.deleteMany({ where: { legacyCompanyNeedId: need.id } }).catch(() => {});
    await prisma.companyNeed.deleteMany({ where: { id: need.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: company.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
