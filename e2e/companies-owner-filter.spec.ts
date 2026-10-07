import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';

// "My accounts" on the admin account list (#2397): a MARKETING admin who also
// owns leads narrows the list to the companies behind their own relations.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the owner filter shows only the admin’s own accounts', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `Own ${stamp}`, slug: `own-${stamp}`, vertical: 'MARKETING' } });
  const adminEmail = uniqueEmail('own-admin');
  const repEmail = uniqueEmail('own-rep');
  const leadEmail = uniqueEmail('own-lead');
  const admin = await seedUser(adminEmail, 'OwnFilter123', 'ADMIN', 'Own Admin');
  const rep = await seedUser(repEmail, 'OwnFilter123', 'MENTOR', 'Own Rep');
  const lead = await seedUser(leadEmail, 'OwnFilter123', 'MENTEE', 'Own Lead');
  await prisma.user.updateMany({ where: { id: { in: [admin.id, rep.id, lead.id] } }, data: { orgId: org.id } });
  const mine = await prisma.company.create({ data: { orgId: org.id, name: `Mine ${stamp}` } });
  const theirs = await prisma.company.create({ data: { orgId: org.id, name: `Theirs ${stamp}` } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: admin.id, menteeId: lead.id, companyId: mine.id } });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: rep.id, menteeId: lead.id, companyId: theirs.id, status: 'COMPLETED' } });

  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, adminEmail, 'OwnFilter123', '/admin');

    const ids = async (q: string) =>
      ((await (await page.request.get(`/api/companies?search=${stamp}${q}`)).json()).companies as { id: string }[]).map((c) => c.id).sort();
    expect(await ids('')).toEqual([mine.id, theirs.id].sort());
    expect(await ids('&owner=me')).toEqual([mine.id]);
    expect(await ids('&owner=bogus')).toEqual([mine.id, theirs.id].sort());

    await gotoSettled(page, '/admin/companies');
    await page.getByTestId('companies-search').fill(stamp);
    await page.getByTestId('companies-owner-filter').selectOption('me');
    await expect(page.getByTestId('companies-total')).toContainText('1', { timeout: 20_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of [adminEmail, repEmail, leadEmail]) await cleanupByEmail(e);
    await prisma.setting.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
