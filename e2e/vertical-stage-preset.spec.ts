import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle } from './helpers/auth';

// Vertical stage preset at org creation (#2353, epic #2348). A new MARKETING org
// starts on the marketing funnel; a new INTERNSHIP org starts on the canonical
// built-ins (no rows written — the resolve fallback serves them), exactly as
// every org did before verticals existed. Provisioning runs server-side at
// creation, bypassing the editor's FREE-plan gate.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function createOrg(page: import('@playwright/test').Page, vertical: string) {
  const res = await page.request.post('/api/admin/organizations', {
    data: { name: `Preset ${vertical} ${Date.now()}`, vertical },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).organization.id as string;
}

test('a new MARKETING org is provisioned with the marketing funnel, an INTERNSHIP org with none', async ({ page }) => {
  // Org creation is super-admin only (#1535), and per world (docs/worlds.md §
  // Super admin): the MARKETING org is created by the MARKETING world's super
  // admin — an account of a MARKETING org, on the marketing host — and the
  // INTERNSHIP org by the INTERNSHIP one.
  const home = await prisma.organization.create({
    data: { name: `Preset home ${Date.now()}`, slug: `preset-home-${Date.now()}`, vertical: 'MARKETING' },
  });
  const adminEmail = uniqueEmail('preset-admin');
  const admin = await seedUser(adminEmail, 'PresetPass123', 'ADMIN', 'Preset Admin', home.id);
  await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });
  const intAdminEmail = uniqueEmail('preset-int-admin');
  const intAdmin = await seedUser(intAdminEmail, 'PresetPass123', 'ADMIN', 'Preset Int Admin');
  await prisma.user.update({ where: { id: intAdmin.id }, data: { isSuperAdmin: true } });
  const created: string[] = [home.id];
  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, adminEmail, 'PresetPass123', '/admin');

    const mktId = await createOrg(page, 'MARKETING');
    created.push(mktId);
    const mktStages = await prisma.pipelineStage.findMany({
      where: { orgId: mktId }, orderBy: { order: 'asc' }, select: { key: true, isTerminal: true, isOffPath: true },
    });
    expect(mktStages.map((s) => s.key)).toEqual([
      'LEAD_NEW', 'LEAD_CONTACTED', 'LEAD_QUALIFIED', 'TRIAL_ACTIVE', 'TRIAL_EXPIRED',
      'DEAL_PROPOSAL', 'DEAL_NEGOTIATION', 'DEAL_WON', 'DEAL_LOST',
    ]);
    // Won is a terminal on-path finish; Lost is the off-path exit.
    expect(mktStages.find((s) => s.key === 'DEAL_WON')).toMatchObject({ isTerminal: true, isOffPath: false });
    expect(mktStages.find((s) => s.key === 'DEAL_LOST')).toMatchObject({ isTerminal: true, isOffPath: true });
    // The trial pair (#2413) is provisioned and BOTH are on-path. TRIAL_EXPIRED
    // being on-path is load-bearing: an expired trial is a record waiting for a
    // decision, not a drop-out, so the auto-advance (#2417) that moves it there
    // does not have to invent a drop-off reason — and it still leaves through
    // DEAL_WON or DEAL_LOST like anything else.
    expect(mktStages.find((s) => s.key === 'TRIAL_ACTIVE')).toMatchObject({ isTerminal: false, isOffPath: false });
    expect(mktStages.find((s) => s.key === 'TRIAL_EXPIRED')).toMatchObject({ isTerminal: false, isOffPath: false });
    // No canonical internship key leaked in.
    expect(mktStages.some((s) => s.key.includes('APPLICATION') || s.key.includes('INTERNSHIP'))).toBe(false);

    await page.context().setExtraHTTPHeaders({});
    await page.context().clearCookies();
    await signInAndSettle(page, intAdminEmail, 'PresetPass123', '/admin');
    const intId = await createOrg(page, 'INTERNSHIP');
    created.push(intId);
    // INTERNSHIP writes NO rows — it resolves to the canonical built-ins.
    const intCount = await prisma.pipelineStage.count({ where: { orgId: intId } });
    expect(intCount).toBe(0);
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, intAdminEmail] } } }).catch(() => {});
    for (const id of created) {
      await prisma.pipelineStage.deleteMany({ where: { orgId: id } }).catch(() => {});
      await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, intAdminEmail] } } }).catch(() => {});
  }
});
