import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { confirmDialog, acceptConfirmDialog, cancelConfirmDialog } from './helpers/confirm';

// The daily work on the company/account list (#2436, #2437, #2441 — story #2397).
//
// Three things that all failed silently before, i.e. with a plausible-looking
// screen rather than an error:
//   • ordering — there was none, and the one that mattered most ("what has not
//     moved in weeks") has to put the accounts with NO stage movement LAST, not
//     first, which is the opposite of what MySQL does with NULLs by default;
//   • search — it ran in the browser over the rows already fetched, so once the
//     list is paged it would only ever find what was already on screen;
//   • delete — `window.confirm()` repeated the company's name back and said
//     nothing about the records that go with it.

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the list is ordered by the server, and accounts that never moved stage come last', async ({
  page,
}) => {
  const adminEmail = uniqueEmail('co-sort-admin');
  const mentorEmail = uniqueEmail('co-sort-mentor');
  const menteeEmail = uniqueEmail('co-sort-mentee');
  const pw = 'CoSortPass123';
  const tag = `sort${Date.now()}`;

  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Company Sort Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Company Sort Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Company Sort Mentee');

  // Deliberately alphabetical in the OPPOSITE direction to both stage orders,
  // so a list that silently fell back to `name: 'asc'` cannot pass.
  const recent = await prisma.company.create({ data: { name: `AA Recent ${tag}` } });
  const stale = await prisma.company.create({ data: { name: `BB Stale ${tag}` } });
  const never = await prisma.company.create({ data: { name: `CC Never ${tag}` } });

  const relationFor = async (companyId: string, startedDaysAgo: number) =>
    prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, companyId, startDate: ago(startedDaysAgo) },
    });

  const recentRel = await relationFor(recent.id, 40);
  const staleRel = await relationFor(stale.id, 200);
  // `never` gets a funnel record too — otherwise "no stage movement" would be
  // indistinguishable from "no records at all", and only the easy half of the
  // rule would be under test.
  await relationFor(never.id, 300);

  await prisma.statusChange.create({
    data: {
      relationId: recentRel.id,
      fromStatus: 'APPLICATION_100',
      toStatus: 'APPROVAL_PENDING_220',
      changedById: admin.id,
      createdAt: ago(1),
    },
  });
  await prisma.statusChange.create({
    data: {
      relationId: staleRel.id,
      fromStatus: 'APPLICATION_100',
      toStatus: 'APPROVAL_PENDING_220',
      changedById: admin.id,
      createdAt: ago(120),
    },
  });

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');

    // Positions of OUR three rows inside whatever else the tenant holds.
    const orderOf = async (sort: string) => {
      const res = await page.request.get(`/api/companies?all=1&sort=${sort}`);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      const names: string[] = body.companies.map((c: { name: string }) => c.name);
      return [recent.name, stale.name, never.name].map((n) => names.indexOf(n));
    };

    // Newest stage movement first: recent (1 day) → stale (120 days) → never (none).
    const [recentAt, staleAt, neverAt] = await orderOf('movement');
    expect(recentAt).toBeGreaterThanOrEqual(0);
    expect(recentAt).toBeLessThan(staleAt);
    expect(staleAt).toBeLessThan(neverAt);

    // Longest in stage first — the exact REVERSE for the two that moved, which
    // is what proves each order is really applied rather than one of them
    // falling through to the other. The account that never moved is still last.
    const [recentWait, staleWait, neverWait] = await orderOf('waiting');
    expect(staleWait).toBeLessThan(recentWait);
    expect(recentWait).toBeLessThan(neverWait);

    // An unknown value is not a 500: it falls back to the default (name A–Z).
    const bogus = await page.request.get('/api/companies?all=1&sort=definitely-not-a-sort');
    expect(bogus.status()).toBe(200);
    const bogusNames: string[] = (await bogus.json()).companies.map((c: { name: string }) => c.name);
    const ours = bogusNames.filter((n) => n.endsWith(tag));
    expect(ours).toEqual([recent.name, stale.name, never.name]);
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: { in: [recentRel.id, staleRel.id] } } });
    await prisma.mentorshipRelation.deleteMany({
      where: { companyId: { in: [recent.id, stale.id, never.id] } },
    });
    await prisma.company.deleteMany({ where: { id: { in: [recent.id, stale.id, never.id] } } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('search and paging happen on the server, and an empty result shows the empty state', async ({
  page,
}) => {
  const adminEmail = uniqueEmail('co-page-admin');
  const pw = 'CoPagePass123';
  const tag = `page${Date.now()}`;
  await seedUser(adminEmail, pw, 'ADMIN', 'Company Paging Admin');

  const created = await Promise.all(
    [1, 2, 3].map((n) => prisma.company.create({ data: { name: `Paged ${tag} ${n}` } }))
  );

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');

    // The API pages: the same query returns `total` for the whole match and only
    // `pageSize` rows per request.
    const first = await page.request.get(`/api/companies?search=${tag}&pageSize=2&page=1`);
    const firstBody = await first.json();
    expect(firstBody.total).toBe(3);
    expect(firstBody.companies).toHaveLength(2);

    const second = await page.request.get(`/api/companies?search=${tag}&pageSize=2&page=2`);
    const secondBody = await second.json();
    expect(secondBody.total).toBe(3);
    expect(secondBody.companies).toHaveLength(1);

    await page.goto('/admin/companies');
    await expect(page.getByTestId('companies-search')).toBeVisible({ timeout: 20_000 });

    // Typing in the box must produce a REQUEST carrying the term — that is what
    // "the client-side filter is gone" means in practice.
    const searched = page.waitForRequest(
      (r) => r.url().includes('/api/companies?') && r.url().includes(`search=${tag}`),
      { timeout: 20_000 }
    );
    await page.getByTestId('companies-search').fill(tag);
    await searched;

    const list = page.getByTestId('companies-list');
    await expect(list.getByText(created[0].name, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('companies-total')).toContainText('3');

    // A term that matches nothing lands on the shared EmptyState, not a blank grid.
    await page.getByTestId('companies-search').fill(`${tag}-no-such-company`);
    await expect(page.getByTestId('empty-admin-companies')).toBeVisible({ timeout: 20_000 });
  } finally {
    await prisma.company.deleteMany({ where: { id: { in: created.map((c) => c.id) } } });
    await cleanupByEmail(adminEmail);
  }
});

test('deleting a company asks in the app and names what is lost and what is only unlinked', async ({
  page,
}) => {
  const adminEmail = uniqueEmail('co-del-admin');
  const mentorEmail = uniqueEmail('co-del-mentor');
  const menteeEmail = uniqueEmail('co-del-mentee');
  const pw = 'CoDelPass123';
  const tag = `del${Date.now()}`;

  await seedUser(adminEmail, pw, 'ADMIN', 'Company Delete Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Company Delete Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Company Delete Mentee');

  const company = await prisma.company.create({
    data: {
      name: `Doomed ${tag}`,
      // Cascade side: a CompanyNeed goes with the row.
      needs: { create: [{ position: 'Backend intern', count: 1, period: 'Summer' }] },
    },
  });
  // SetNull side: both of these survive the delete with their company link cleared.
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id },
  });
  const project = await prisma.project.create({
    data: { name: `Doomed project ${tag}`, ownerType: 'COMPANY', ownerCompanyId: company.id },
  });

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await page.goto('/admin/companies');
    await expect(page.getByTestId('companies-search')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('companies-search').fill(tag);
    await expect(page.getByTestId(`delete-company-${company.id}`)).toBeVisible({ timeout: 20_000 });

    await page.getByTestId(`delete-company-${company.id}`).click();

    // The in-app dialog, not the browser's confirm() — a spec that had to
    // register page.on('dialog') would be waiting for an event that never fires.
    await expect(confirmDialog(page)).toBeVisible({ timeout: 20_000 });
    await expect(confirmDialog(page)).toContainText(company.name);

    // The two consequences are stated SEPARATELY, each with its counts.
    await expect(page.getByTestId('company-delete-cascade')).toContainText('1 open positions', {
      timeout: 20_000,
    });
    const detach = page.getByTestId('company-delete-detach');
    await expect(detach).toContainText('1 mentorships');
    await expect(detach).toContainText('1 projects');

    // Cancelling deletes nothing.
    await cancelConfirmDialog(page);
    expect(await prisma.company.count({ where: { id: company.id } })).toBe(1);

    await page.getByTestId(`delete-company-${company.id}`).click();
    await acceptConfirmDialog(page);
    await expect(page.getByTestId('empty-admin-companies')).toBeVisible({ timeout: 20_000 });

    expect(await prisma.company.count({ where: { id: company.id } })).toBe(0);
    // Cascade really cascaded, and the "kept" side really was kept.
    expect(await prisma.companyNeed.count({ where: { companyId: company.id } })).toBe(0);
    const survivor = await prisma.project.findUnique({ where: { id: project.id } });
    expect(survivor?.ownerCompanyId).toBeNull();
  } finally {
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
