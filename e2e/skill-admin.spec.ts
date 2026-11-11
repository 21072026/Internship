import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi } from './helpers/auth';
import { resolveSkill } from '../src/lib/skillsResolve';
import { prisma as appPrisma } from '../src/lib/prisma';

// /admin/skills (#1817): create → alias → merge → retire through the screen,
// the review-queue tab, and the role gate on every route — asserted against
// the handlers, not inferred from a hidden nav link.

const PASSWORD = 'Pass1234!';
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const emails = {
  admin: uniqueEmail('skadm-admin'),
  mentor: uniqueEmail('skadm-mentor'),
  mentee: uniqueEmail('skadm-mentee'),
  company: uniqueEmail('skadm-company'),
  source: uniqueEmail('skadm-source'),
  m1: uniqueEmail('skadm-m1'),
  m2: uniqueEmail('skadm-m2'),
};
let orgId = '';
let otherOrgId = '';
const ids: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Skill Admin ${STAMP}`, slug: `skadm-${STAMP}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Skill Admin B ${STAMP}`, slug: `skadm-b-${STAMP}` } })).id;
  ids.admin = (await seedUser(emails.admin, PASSWORD, 'ADMIN', 'Skadm Admin', orgId)).id;
  await seedUser(emails.mentor, PASSWORD, 'MENTOR', 'Skadm Mentor', orgId);
  await seedUser(emails.mentee, PASSWORD, 'MENTEE', 'Skadm Mentee', orgId);
  await seedUser(emails.company, PASSWORD, 'COMPANY', 'Skadm Company', orgId);
  await seedUser(emails.source, PASSWORD, 'SOURCE', 'Skadm Source', orgId);
  ids.m1 = (await seedUser(emails.m1, PASSWORD, 'MENTEE', 'Skadm One', orgId)).id;
  ids.m2 = (await seedUser(emails.m2, PASSWORD, 'MENTEE', 'Skadm Two', orgId)).id;
});

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('every skill route refuses MENTOR, MENTEE, COMPANY and SOURCE', async ({ playwright, baseURL }) => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/api/admin/skills'],
    ['POST', '/api/admin/skills', { labelEn: 'Nope' }],
    ['PATCH', '/api/admin/skills/x', { status: 'RETIRED' }],
    ['POST', '/api/admin/skills/x/aliases', { alias: 'nope' }],
    ['DELETE', '/api/admin/skills/x/aliases/y'],
    ['GET', '/api/admin/skills/x/merge?targetId=y'],
    ['POST', '/api/admin/skills/x/merge', { targetId: 'y' }],
    ['PUT', '/api/admin/skills/x/edges', { edges: [] }],
    ['GET', '/api/admin/skills/unmapped'],
  ];
  for (const who of ['mentor', 'mentee', 'company', 'source'] as const) {
    const ctx = await playwright.request.newContext({ baseURL });
    expect((await signInViaApi(ctx, emails[who], PASSWORD)).ok, who).toBe(true);
    for (const [method, url, data] of routes) {
      const res = await ctx.fetch(url, { method, data });
      expect(res.status(), `${who} ${method} ${url}`).toBe(403);
    }
    await ctx.dispose();
  }
});

test('an admin creates, aliases, merges and retires through the screen', async ({ page }) => {
  await signInAndSettle(page, emails.admin, PASSWORD, '/admin');
  await page.goto('/admin/skills');
  await expect(page.getByTestId('skill-admin-table')).toBeVisible({ timeout: 20_000 });
  // The starter vocabulary was seeded on first open.
  await expect(page.getByTestId('skill-row-react')).toBeVisible();

  // Create.
  await page.getByTestId('skill-admin-new').fill('Reakt');
  await page.getByTestId('skill-admin-create').click();
  await page.getByTestId('skill-admin-search').fill('Reakt');
  const row = page.getByTestId('skill-row-reakt');
  await expect(row).toBeVisible();

  // Alias.
  await page.getByTestId('skill-alias-reakt').click();
  await page.getByTestId('skill-alias-input').fill('Reakt.js');
  await page.getByTestId('skill-alias-save').click();
  await expect(row.getByTestId('skill-alias-chip').filter({ hasText: 'reakt.js' })).toBeVisible();

  // A spelling another skill owns is refused, not silently reassigned.
  await page.getByTestId('skill-alias-input').fill('ReactJS');
  await page.getByTestId('skill-alias-save').click();
  await expect(page.getByTestId('skill-admin-error')).toBeVisible();

  // Two people hold the duplicate, one of them also holds React.
  const reakt = await prisma.skill.findFirstOrThrow({ where: { orgId, key: 'reakt' } });
  const react = await prisma.skill.findFirstOrThrow({ where: { orgId, key: 'react' } });
  await prisma.userSkill.createMany({
    data: [
      { userId: ids.m1, skillId: reakt.id },
      { userId: ids.m2, skillId: reakt.id },
      { userId: ids.m1, skillId: react.id },
    ],
  });

  // Merge: the dialog states the numbers before anything is written.
  await page.getByTestId('skill-merge-reakt').click();
  await page.getByTestId('skill-merge-target').selectOption({ label: 'React' });
  await expect(page.getByTestId('skill-merge-preview')).toContainText('2');
  await expect(page.getByTestId('skill-merge-preview')).toContainText('1');
  expect(await prisma.userSkill.count({ where: { skillId: reakt.id } })).toBe(2);
  await page.getByTestId('skill-merge-confirm').click();

  await expect.poll(() => prisma.userSkill.count({ where: { skillId: reakt.id } })).toBe(0);
  expect(await prisma.userSkill.count({ where: { skillId: react.id, userId: { in: [ids.m1, ids.m2] } } })).toBe(2);
  const loser = await prisma.skill.findUniqueOrThrow({ where: { id: reakt.id } });
  expect(loser.mergedIntoId).toBe(react.id);
  // Old spellings — the alias and the loser's own key — still resolve.
  expect((await resolveSkill(orgId, 'Reakt.js'))?.id).toBe(react.id);
  expect((await resolveSkill(orgId, 'reakt'))?.id).toBe(react.id);

  // Retire: gone from resolution, still on everybody's profile.
  await page.getByTestId('skill-admin-search').fill('');
  await page.getByTestId('skill-admin-search').fill('React');
  await page.getByTestId('skill-status-react').click();
  await expect.poll(async () => (await prisma.skill.findUniqueOrThrow({ where: { id: react.id } })).status).toBe('RETIRED');
  expect(await resolveSkill(orgId, 'React')).toBeNull();
  expect(await prisma.userSkill.count({ where: { skillId: react.id } })).toBe(2);

  // Every mutation left an activity row.
  const actions = await prisma.activityLog.findMany({
    where: { actorId: ids.admin, action: { startsWith: 'skill.' } },
    select: { action: true },
  });
  expect(new Set(actions.map((a) => a.action))).toEqual(new Set(['skill.created', 'skill.alias_added', 'skill.merged', 'skill.retired']));
});

test("another org's skill answers 404; neighbours are set and a self-edge is refused", async ({ request }) => {
  expect((await signInViaApi(request, emails.admin, PASSWORD)).ok).toBe(true);
  const foreign = await prisma.skill.create({
    data: { orgId: otherOrgId, key: `foreign-${STAMP}`, labelEn: 'Foreign', labelTr: 'Foreign', labelDe: 'Foreign' },
  });
  expect((await request.patch(`/api/admin/skills/${foreign.id}`, { data: { status: 'RETIRED' } })).status()).toBe(404);
  expect((await request.post(`/api/admin/skills/${foreign.id}/aliases`, { data: { alias: 'x' } })).status()).toBe(404);
  const anyOwn = await prisma.skill.findFirstOrThrow({ where: { orgId, status: 'ACTIVE', mergedIntoId: null } });
  expect((await request.post(`/api/admin/skills/${anyOwn.id}/merge`, { data: { targetId: foreign.id } })).status()).toBe(404);

  // Edges: set, read back, cannot point at itself.
  const vue = await prisma.skill.findFirstOrThrow({ where: { orgId, key: 'vue' } });
  const angular = await prisma.skill.findFirstOrThrow({ where: { orgId, key: 'angular' } });
  const put = await request.put(`/api/admin/skills/${vue.id}/edges`, { data: { edges: [{ skillId: angular.id, weight: 0.8 }] } });
  expect(put.ok()).toBe(true);
  expect(await prisma.skillEdge.count({ where: { orgId, OR: [{ fromSkillId: vue.id }, { toSkillId: vue.id, kind: 'ADJACENT' }] } })).toBe(1);
  expect((await request.put(`/api/admin/skills/${vue.id}/edges`, { data: { edges: [{ skillId: vue.id, weight: 1 }] } })).status()).toBe(400);
});

test('the review queue tab promotes a term', async ({ page }) => {
  await prisma.unmappedSkillTerm.create({ data: { orgId, normalizedKey: 'quantum knitting', term: 'Quantum Knitting', occurrences: 3 } });
  await signInAndSettle(page, emails.admin, PASSWORD, '/admin');
  await page.goto('/admin/skills');
  await page.getByTestId('skill-admin-tab-queue').click();
  const queueRow = page.getByTestId('skill-queue-row').filter({ hasText: 'Quantum Knitting' });
  await expect(queueRow).toBeVisible();
  await queueRow.getByTestId('skill-queue-promote').click();
  await expect(page.getByTestId('skill-queue-notice')).toBeVisible();
  await expect.poll(() => prisma.skill.count({ where: { orgId, key: 'quantum-knitting' } })).toBe(1);
});
