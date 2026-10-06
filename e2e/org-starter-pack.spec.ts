import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { applyOrgStarterPack } from '../src/lib/orgStarterPack';
import { defaultPipelineStages } from '../src/lib/pipeline';

// The tenant starter pack (#2066). Fresh orgs of their own: the pack is
// applied to an empty tenant, applied again (nothing new), applied over the
// tenant's own edits (kept), and refused to anyone but that org's admin.

const PW = 'Starter123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function wipeOrg(orgId: string) {
  await prisma.evaluationTemplate.deleteMany({ where: { orgId } });
  await prisma.projectTaskTemplate.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
}

test('the starter pack fills an empty tenant once, keeps the tenant’s edits, and only its admin may apply it', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `Starter ${stamp}`, slug: `starter-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `Starter other ${stamp}`, slug: `starter-other-${stamp}` } });
  const adminEmail = uniqueEmail('sp-admin');
  const mentorEmail = uniqueEmail('sp-mentor');
  const otherAdminEmail = uniqueEmail('sp-other');
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'SP Admin', org.id);
    await seedUser(mentorEmail, PW, 'MENTOR', 'SP Mentor', org.id);
    await seedUser(otherAdminEmail, PW, 'ADMIN', 'SP Other Admin', other.id);

    await signInAndSettle(page, adminEmail, PW, '/admin');
    const first = (await (await page.request.post(`/api/admin/organizations/${org.id}/starter-pack`)).json()).summary;
    const canonical = defaultPipelineStages().length;
    expect(first.stages).toEqual({ created: canonical, skipped: 0 });
    expect(first.slas.created).toBeGreaterThan(0);
    expect(first.documentRequirements).toEqual({ created: 4, skipped: 0 });
    expect(first.evaluationTemplates).toEqual({ created: 2, skipped: 0 });
    expect(first.goalTemplates.created).toBeGreaterThan(0);
    expect(await prisma.pipelineStage.count({ where: { orgId: org.id } })).toBe(canonical);
    const rubrics = await prisma.evaluationTemplate.findMany({ where: { orgId: org.id }, include: { criteria: true } });
    expect(rubrics.map((r) => r.scope).sort()).toEqual(['MENTEE', 'MENTOR']);

    // The tenant edits a service level, a document label and a criterion label…
    const sla = await prisma.stageSla.findFirstOrThrow({ where: { orgId: org.id } });
    await prisma.stageSla.update({ where: { id: sla.id }, data: { days: 99 } });
    const doc = await prisma.documentRequirement.findFirstOrThrow({ where: { orgId: org.id } });
    await prisma.documentRequirement.update({ where: { id: doc.id }, data: { labels: { en: 'Our CV', tr: 'Bizim CV', de: 'Unser CV' } } });
    const criterion = rubrics[0].criteria[0];
    await prisma.evaluationCriterion.update({ where: { id: criterion.id }, data: { labels: { en: 'Ours', tr: 'Bizim', de: 'Unser' } } });

    // …and applying again — through the settings screen — adds nothing and keeps every edit.
    await page.goto('/admin/settings');
    await page.getByTestId('starter-pack-apply').click();
    const summary = page.getByTestId('starter-pack-summary');
    for (const m of ['stages', 'slas', 'documentRequirements', 'evaluationTemplates', 'goalTemplates']) {
      await expect(summary.getByTestId(`starter-pack-${m}`)).toHaveAttribute('data-created', '0');
    }
    expect((await prisma.stageSla.findUniqueOrThrow({ where: { id: sla.id } })).days).toBe(99);
    expect((await prisma.documentRequirement.findUniqueOrThrow({ where: { id: doc.id } })).labels).toEqual({ en: 'Our CV', tr: 'Bizim CV', de: 'Unser CV' });
    expect((await prisma.evaluationCriterion.findUniqueOrThrow({ where: { id: criterion.id } })).labels).toEqual({ en: 'Ours', tr: 'Bizim', de: 'Unser' });
    expect(await prisma.evaluationTemplate.count({ where: { orgId: org.id } })).toBe(2);

    // Only this org's admin: a mentor and another tenant's admin are refused.
    await signInAsFreshUser(page, mentorEmail, PW, '/mentor');
    expect((await page.request.post(`/api/admin/organizations/${org.id}/starter-pack`)).status()).toBe(403);
    await signInAsFreshUser(page, otherAdminEmail, PW, '/admin');
    expect((await page.request.post(`/api/admin/organizations/${org.id}/starter-pack`)).status()).toBe(403);

    // A provisioning path calls it inside its own transaction, with an org it just created.
    const fresh = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name: `Starter tx ${stamp}`, slug: `starter-tx-${stamp}` } });
      const s = await applyOrgStarterPack(created.id, { tx });
      return { id: created.id, s };
    });
    expect(fresh.s.stages.created).toBe(canonical);
    expect(await prisma.pipelineStage.count({ where: { orgId: fresh.id } })).toBe(canonical);
    await wipeOrg(fresh.id);
  } finally {
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(otherAdminEmail);
    await wipeOrg(org.id);
    await wipeOrg(other.id);
  }
});
