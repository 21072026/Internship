import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

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
  // Org creation is super-admin only (#1535).
  const adminEmail = uniqueEmail('preset-admin');
  const admin = await seedUser(adminEmail, 'PresetPass123', 'ADMIN', 'Preset Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });
  const created: string[] = [];
  try {
    await signInAndSettle(page, adminEmail, 'PresetPass123', '/admin');

    const mktId = await createOrg(page, 'MARKETING');
    created.push(mktId);
    const mktStages = await prisma.pipelineStage.findMany({
      where: { orgId: mktId }, orderBy: { order: 'asc' }, select: { key: true, isTerminal: true, isOffPath: true },
    });
    expect(mktStages.map((s) => s.key)).toEqual([
      'LEAD_NEW', 'LEAD_CONTACTED', 'LEAD_QUALIFIED', 'DEAL_PROPOSAL', 'DEAL_NEGOTIATION', 'DEAL_WON', 'DEAL_LOST',
    ]);
    // Won is a terminal on-path finish; Lost is the off-path exit.
    expect(mktStages.find((s) => s.key === 'DEAL_WON')).toMatchObject({ isTerminal: true, isOffPath: false });
    expect(mktStages.find((s) => s.key === 'DEAL_LOST')).toMatchObject({ isTerminal: true, isOffPath: true });
    // No canonical internship key leaked in.
    expect(mktStages.some((s) => s.key.includes('APPLICATION') || s.key.includes('INTERNSHIP'))).toBe(false);

    const intId = await createOrg(page, 'INTERNSHIP');
    created.push(intId);
    // INTERNSHIP writes NO rows — it resolves to the canonical built-ins.
    const intCount = await prisma.pipelineStage.count({ where: { orgId: intId } });
    expect(intCount).toBe(0);
  } finally {
    for (const id of created) {
      await prisma.pipelineStage.deleteMany({ where: { orgId: id } }).catch(() => {});
      await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { email: adminEmail } }).catch(() => {});
  }
});
