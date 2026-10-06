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

test('the sample programme is labelled, mail-proof, added once, and removed as exactly its own rows', async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `Sample ${stamp}`, slug: `sample-${stamp}` } });
  const adminEmail = uniqueEmail('sample-admin');
  const realMentorEmail = uniqueEmail('sample-real-mentor');
  const realMenteeEmail = uniqueEmail('sample-real-mentee');
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Sample Admin', org.id);
    const realMentor = await seedUser(realMentorEmail, PW, 'MENTOR', 'Real Mentor', org.id);
    const realMentee = await seedUser(realMenteeEmail, PW, 'MENTEE', 'Real Mentee', org.id);
    const realRel = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: realMentor.id, menteeId: realMentee.id, status: 'ACTIVE' } });

    await signInAndSettle(page, adminEmail, PW, '/admin');
    // Through the settings card, with the sample box ticked.
    await page.goto('/admin/settings');
    await page.getByTestId('starter-pack-sample').check();
    await page.getByTestId('starter-pack-apply').click();
    await expect(page.getByTestId('starter-pack-sampleProgram')).not.toHaveAttribute('data-created', '0');

    const sampleUsers = await prisma.user.findMany({ where: { orgId: org.id, sampleData: true }, select: { email: true, fullName: true, role: true } });
    expect(sampleUsers).toHaveLength(6);
    expect(sampleUsers.filter((u) => u.role === 'MENTOR')).toHaveLength(2);
    expect(sampleUsers.every((u) => u.email.endsWith('@sample.invalid') && u.fullName.endsWith('(sample)'))).toBe(true);
    const sampleRels = await prisma.mentorshipRelation.findMany({ where: { orgId: org.id, sampleData: true }, select: { id: true, pipelineStatus: true } });
    expect(sampleRels).toHaveLength(4);
    expect(new Set(sampleRels.map((r) => r.pipelineStatus)).size).toBeGreaterThan(1); // spread over the pipeline
    expect(await prisma.weeklyReport.count({ where: { relationId: { in: sampleRels.map((r) => r.id) } } })).toBe(1);
    expect(await prisma.company.count({ where: { orgId: org.id, sampleData: true } })).toBe(1);
    expect(await prisma.requisition.count({ where: { orgId: org.id, sampleData: true } })).toBe(1);

    // Asked again: nothing new.
    const again = (await (await page.request.post(`/api/admin/organizations/${org.id}/starter-pack`, { data: { sampleProgram: true } })).json()).summary;
    expect(again.sampleProgram).toEqual({ created: 0, skipped: 1 });
    expect(await prisma.user.count({ where: { orgId: org.id, sampleData: true } })).toBe(6);

    // Removed as a set — and the real pair is untouched.
    await page.getByTestId('starter-pack-remove-sample').click();
    await expect(page.getByTestId('starter-pack-removed')).toBeVisible();
    expect(await prisma.user.count({ where: { orgId: org.id, sampleData: true } })).toBe(0);
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id, sampleData: true } })).toBe(0);
    expect(await prisma.company.count({ where: { orgId: org.id, sampleData: true } })).toBe(0);
    expect(await prisma.requisition.count({ where: { orgId: org.id, sampleData: true } })).toBe(0);
    expect(await prisma.mentorshipRelation.findUnique({ where: { id: realRel.id }, select: { id: true } })).not.toBeNull();
    expect(await prisma.user.count({ where: { id: { in: [realMentor.id, realMentee.id] } } })).toBe(2);
    // Nothing was ever mailed to a sample address.
    expect(await prisma.emailLog.count({ where: { to: { endsWith: '@sample.invalid' } } })).toBe(0);

    // A mentor cannot remove anything.
    await signInAsFreshUser(page, realMentorEmail, PW, '/mentor');
    expect((await page.request.delete(`/api/admin/organizations/${org.id}/sample-data`)).status()).toBe(403);
  } finally {
    await prisma.user.deleteMany({ where: { orgId: org.id, sampleData: true } }).catch(() => {});
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(realMentorEmail);
    await cleanupByEmail(realMenteeEmail);
    await prisma.company.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await wipeOrg(org.id);
  }
});
