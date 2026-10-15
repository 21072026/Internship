import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';

// Sales channels (#2408): which marketplaces, shop systems and carriers an
// account works on.
//   1. an ADMIN adds a channel on the account page and changes its status;
//   2. the route accepts only the vocabulary, and only the caller's tenant;
//   3. a postal campaign's account picker filters on "sells on OTTO" — USING
//      only, so a merchant that stopped selling there is not targeted.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'SalesChannels123';

test('channels on the account page, and the campaign picker filters on them', async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Chan MKT ${stamp}`, slug: `chan-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const other = await prisma.organization.create({
    data: { name: `Chan Other ${stamp}`, slug: `chan-other-${stamp}`, vertical: 'MARKETING' },
  });
  const adminEmail = uniqueEmail('chan-admin');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Channel Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });

  const seller = await prisma.company.create({
    data: { orgId: org.id, name: `Otto Seller ${stamp}`, address: 'Weg 1, 10115 Berlin', country: 'DE' },
  });
  const stopped = await prisma.company.create({
    data: { orgId: org.id, name: `Otto Stopped ${stamp}`, address: 'Weg 2, 10115 Berlin', country: 'DE' },
  });
  const none = await prisma.company.create({
    data: { orgId: org.id, name: `No Channel ${stamp}`, address: 'Weg 3, 10115 Berlin', country: 'DE' },
  });
  await prisma.companyChannel.create({ data: { orgId: org.id, companyId: stopped.id, channel: 'otto', status: 'DROPPED' } });
  const foreign = await prisma.company.create({ data: { orgId: other.id, name: `Foreign ${stamp}` } });

  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, adminEmail, PW, '/admin');

    // 1. Add OTTO on the account page, then mark it "interested", then "uses".
    await gotoSettled(page, `/admin/companies/${seller.id}`);
    const editor = page.getByTestId('company-channels-editor');
    await editor.getByTestId('company-channel-new').selectOption('otto');
    await editor.getByTestId('company-channel-add').click();
    await expect(editor.getByTestId('company-channel-otto')).toBeVisible({ timeout: 20_000 });
    await editor.getByTestId('company-channel-status-otto').selectOption('INTERESTED');
    await expect
      .poll(async () => (await prisma.companyChannel.findUnique({ where: { companyId_channel: { companyId: seller.id, channel: 'otto' } } }))?.status)
      .toBe('INTERESTED');
    await editor.getByTestId('company-channel-status-otto').selectOption('USING');
    await expect
      .poll(async () => (await prisma.companyChannel.findUnique({ where: { companyId_channel: { companyId: seller.id, channel: 'otto' } } }))?.status)
      .toBe('USING');
    const row = await prisma.companyChannel.findUniqueOrThrow({ where: { companyId_channel: { companyId: seller.id, channel: 'otto' } } });
    expect(row.orgId).toBe(org.id);

    // 2. The vocabulary and the tenant are enforced by the route.
    const unknown = await page.request.put(`/api/admin/companies/${seller.id}/channels`, { data: { channel: 'wish', status: 'USING' } });
    expect(unknown.status()).toBe(400);
    const crossTenant = await page.request.put(`/api/admin/companies/${foreign.id}/channels`, { data: { channel: 'otto', status: 'USING' } });
    expect(crossTenant.status()).toBe(404);
    expect(await prisma.companyChannel.count({ where: { companyId: foreign.id } })).toBe(0);

    // 3. "Sells on OTTO" in the campaign picker: the USING one only.
    const created = await page.request.post('/api/admin/post-campaigns', {
      data: {
        name: `OTTO ${stamp}`,
        dataSource: 'Öffentliches Impressum der Shops, Oktober 2026',
        balancingNote: 'Berechtigtes Interesse an Direktwerbung gegenüber Online-Händlern, abgewogen.',
        letterBody: '{salutation}\n\nText {link}',
      },
    });
    expect(created.status()).toBe(201);
    const campaignId = (await created.json()).id;
    await gotoSettled(page, `/admin/acquisition/${campaignId}`);
    await page.getByTestId('post-campaign-search').fill(stamp);
    await expect(page.getByTestId(`post-campaign-candidate-${none.id}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('post-campaign-channel').selectOption('otto');
    await expect(page.getByTestId(`post-campaign-candidate-${seller.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`post-campaign-candidate-${none.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`post-campaign-candidate-${stopped.id}`)).toHaveCount(0);

    // Removing the channel takes it off the account.
    await gotoSettled(page, `/admin/companies/${seller.id}`);
    await page.getByTestId('company-channel-remove-otto').click();
    await expect(page.getByTestId('company-channel-otto')).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await prisma.postCampaign.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: { in: [org.id, other.id] } } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { targetId: { in: [seller.id, stopped.id, none.id, foreign.id] } } }).catch(() => {});
    await cleanupByEmail(adminEmail);
    await prisma.setting.deleteMany({ where: { orgId: { in: [org.id, other.id] } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } }).catch(() => {});
  }
});
