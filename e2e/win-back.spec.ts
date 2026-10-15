import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// A lost customer comes back (#2842): the lost journey
// closes as churned and a new one opens, linked back — never an in-place
// DEAL_LOST → DEAL_WON move.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'WinBack12345';

test('win-back opens a new journey and closes the lost one as churned', async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `WinBack ${stamp}`, slug: `winback-${stamp}`, vertical: 'MARKETING' } });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  const emails = ['admin', 'rep', 'lead'].map((k) => uniqueEmail(`winback-${k}`));
  const admin = await seedUser(emails[0], PW, 'ADMIN', 'WinBack Admin');
  const rep = await seedUser(emails[1], PW, 'MENTOR', 'WinBack Rep');
  const lead = await seedUser(emails[2], PW, 'MENTEE', `Returning ${stamp}`);
  await prisma.user.updateMany({ where: { id: { in: [admin.id, rep.id, lead.id] } }, data: { orgId: org.id } });
  const company = await prisma.company.create({ data: { orgId: org.id, name: `Returning GmbH ${stamp}` } });
  const lost = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: rep.id, menteeId: lead.id, companyId: company.id, pipelineStatus: 'DEAL_LOST' },
  });

  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, emails[1], PW, '/sales');
    await gotoSettled(page, `/sales/leads/${lost.id}`);
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('win-back-won').click();
    await page.waitForURL((u) => u.pathname.startsWith('/sales/leads/') && !u.pathname.endsWith(lost.id), { timeout: 30_000 });

    const old = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: lost.id } });
    expect(old).toMatchObject({ status: 'COMPLETED', lifecycleState: 'ENDED_CHURNED', pipelineStatus: 'DEAL_LOST' });
    const fresh = await prisma.mentorshipRelation.findFirstOrThrow({ where: { previousRelationId: lost.id } });
    expect(fresh).toMatchObject({ status: 'ACTIVE', pipelineStatus: 'DEAL_WON', mentorId: rep.id, menteeId: lead.id, companyId: company.id });

    // The closed record cannot be won back twice; a non-lost one never.
    expect((await page.request.post(`/api/mentorship/${lost.id}/win-back`, { data: { toStage: 'DEAL_WON' } })).status()).toBe(409);
    const notLost = await page.request.post(`/api/mentorship/${fresh.id}/win-back`, { data: { toStage: 'DEAL_WON' } });
    expect((await notLost.json()).code).toBe('not_lost');

    // The account page says win-back, not "continues an earlier deal".
    await page.context().clearCookies();
    await signInAndSettle(page, emails[0], PW, '/admin');
    await gotoSettled(page, `/admin/companies/${company.id}`);
    await expect(page.getByTestId(`company-detail-relation-won-back-${fresh.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`company-detail-relation-chain-${fresh.id}`)).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.updateMany({ where: { orgId: org.id }, data: { previousRelationId: null } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { action: 'pipeline.win_back', actorId: rep.id } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
