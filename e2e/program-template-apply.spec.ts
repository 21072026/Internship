import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { programTemplate, templateStagePayload } from '@/lib/programTemplates';

// Programme templates (#1641) — applying one to a fresh organization.
//
// The catalogue never writes: a template is turned into the body of the
// EXISTING stage editor endpoint (`templateStagePayload`) and posted to
// `PUT /api/admin/organizations/[id]/pipeline-stages`, so the template inherits
// that route's authz, its premium gate and its validation instead of getting a
// second, laxer writer. This spec is what proves the payload actually round-trips:
// the stage set that comes back must be the template, in the template's order.

const createdSlugs: string[] = [];

test.afterAll(async () => {
  for (const slug of createdSlugs) {
    const org = await prisma.organization.findUnique({ where: { slug } }).catch(() => null);
    if (org) {
      await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    }
  }
  await prisma.$disconnect();
});

test('a template applied to a fresh organization becomes exactly its stage set, in order', async ({ page }) => {
  const adminEmail = uniqueEmail('template-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Template Admin');
  // Managing another tenant's stages is super-admin only (#1535).
  await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });

  const tag = Date.now();
  const slug = `e2e-template-org-${tag}`;
  createdSlugs.push(slug);
  // A brand-new programme: no custom stages, nobody in the pipeline. Custom
  // stages are premium, so the tenant is on a paid plan.
  const org = await prisma.organization.create({
    data: { name: `E2E Template Org ${tag}`, slug, plan: 'PRO' },
  });

  const template = programTemplate('graduate_internship')!;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');

    // Fresh: the org resolves to the built-in catalogue and is not customized.
    const before = await page.request.get(`/api/admin/organizations/${org.id}/pipeline-stages`);
    expect(before.ok()).toBeTruthy();
    expect((await before.json()).custom).toBe(false);

    // Apply — through the existing editor endpoint, with the catalogue's payload.
    const applied = await page.request.put(`/api/admin/organizations/${org.id}/pipeline-stages`, {
      data: templateStagePayload(template, 'en'),
    });
    expect(applied.ok()).toBeTruthy();

    // What came back is the template: same keys, same order, same labels, and
    // the off-path/terminal flags the shape depends on.
    const expected = templateStagePayload(template, 'en').stages;
    const body = await applied.json();
    expect(body.custom).toBe(true);
    expect(body.stages.map((s: { key: string }) => s.key)).toEqual(expected.map((s) => s.key));
    expect(body.stages.map((s: { label: string }) => s.label)).toEqual(expected.map((s) => s.label));
    expect(body.stages.map((s: { order: number }) => s.order)).toEqual(expected.map((s) => s.order));

    // …and it is what a later read returns, not just what the write echoed.
    const after = await page.request.get(`/api/admin/organizations/${org.id}/pipeline-stages`);
    const reread = await after.json();
    expect(reread.custom).toBe(true);
    expect(reread.stages.map((s: { key: string }) => s.key)).toEqual(expected.map((s) => s.key));
    // The last two stages are the outcome pair the house style requires: a
    // terminal on-path ending and one off-path way out.
    const hired = reread.stages.find((s: { key: string }) => s.key === 'GRAD_HIRED');
    expect(hired).toMatchObject({ isTerminal: true, isOffPath: false });
    const withdrew = reread.stages.find((s: { key: string }) => s.key === 'GRAD_WITHDREW');
    expect(withdrew).toMatchObject({ isTerminal: true, isOffPath: true });

    // Persisted as rows, one per template stage — the template did not write
    // through a side door.
    expect(await prisma.pipelineStage.count({ where: { orgId: org.id } })).toBe(template.stages.length);

    // A second template replaces the first (same endpoint, same rules): this is
    // exactly why `templateApplyBlockers()` refuses an org whose mentees sit on
    // stages the new template does not contain.
    const other = programTemplate('onboarding_buddy')!;
    const second = await page.request.put(`/api/admin/organizations/${org.id}/pipeline-stages`, {
      data: templateStagePayload(other, 'tr'),
    });
    expect(second.ok()).toBeTruthy();
    const swapped = await second.json();
    expect(swapped.stages.map((s: { key: string }) => s.key))
      .toEqual(templateStagePayload(other, 'tr').stages.map((s) => s.key));
    // Applied in Turkish, so the labels are the Turkish ones.
    expect(swapped.stages[0].label).toBe('Rehber atandı');
    expect(await prisma.pipelineStage.count({ where: { orgId: org.id } })).toBe(other.stages.length);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
