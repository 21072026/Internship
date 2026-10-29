import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The free-text → taxonomy backfill and its review queue (#1819).
//
// One throwaway org with synthetic people. The backfill runs as the deploy
// runs it (`node prisma/backfill-skill-taxonomy.mjs`), scoped to that org with
// `--org`; the queue is driven through its ADMIN-only routes.

const PASSWORD = 'Pass1234!';
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let orgId = '';
let otherOrgId = '';
const adminEmail = uniqueEmail('skbf-admin');
const mentorEmail = uniqueEmail('skbf-mentor');
const ids: Record<string, string> = {};

function backfill(...args: string[]): string {
  return execFileSync('node', ['prisma/backfill-skill-taxonomy.mjs', '--org', orgId, ...args], {
    encoding: 'utf8',
    env: process.env,
  });
}

async function counts() {
  const [skills, aliases, edges, userSkills, terms] = await Promise.all([
    prisma.skill.count({ where: { orgId } }),
    prisma.skillAlias.count({ where: { orgId } }),
    prisma.skillEdge.count({ where: { orgId } }),
    prisma.userSkill.count({ where: { user: { orgId } } }),
    prisma.unmappedSkillTerm.count({ where: { orgId } }),
  ]);
  return { skills, aliases, edges, userSkills, terms };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Skill Backfill ${STAMP}`, slug: `skbf-${STAMP}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Skill Backfill B ${STAMP}`, slug: `skbf-b-${STAMP}` } })).id;
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Skbf Admin', orgId);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Skbf Mentor', orgId);
  const a = await seedUser(uniqueEmail('skbf-a'), PASSWORD, 'MENTEE', 'Skbf A', orgId);
  const b = await seedUser(uniqueEmail('skbf-b'), PASSWORD, 'MENTEE', 'Skbf B', orgId);
  Object.assign(ids, { admin: admin.id, mentor: mentor.id, a: a.id, b: b.id });
  await prisma.user.update({ where: { id: a.id }, data: { skills: ['ReactJS', 'VERİ MÜHENDİSLİĞİ', 'Bilgisayar Görüsü', 'Kubernetes Operators'] } });
  await prisma.user.update({ where: { id: b.id }, data: { skills: ['react', 'bilgisayar görüsü', 'Lindy Hop'] } });
  await prisma.user.update({ where: { id: mentor.id }, data: { skills: ['Kubernetes operators'] } });
});

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  await prisma.$disconnect();
});

test('dry run writes nothing and reports resolved and unmapped terms', async () => {
  const out = backfill();
  expect(out).toContain('dry run');
  expect(out).toMatch(/8 distinct entries — 3 resolved \(38%\), 5 unmapped \(3 distinct terms\)/);
  expect(out).toContain('top unmapped terms:');
  expect(out).toMatch(/2\s+Bilgisayar Görüsü|2\s+bilgisayar görüsü/);
  expect(await counts()).toEqual({ skills: 0, aliases: 0, edges: 0, userSkills: 0, terms: 0 });
});

test('apply maps what resolves (Turkish letters included), queues the rest, and is idempotent', async () => {
  backfill('--apply');
  const first = await counts();
  expect(first.skills).toBeGreaterThan(50);
  expect(first.userSkills).toBe(3);
  expect(first.terms).toBe(3);

  const aSkills = await prisma.userSkill.findMany({ where: { userId: ids.a }, select: { skill: { select: { key: true } }, source: true } });
  expect(aSkills.map((r) => r.skill.key).sort()).toEqual(['data-engineering', 'react']);
  expect(aSkills.every((r) => r.source === 'BACKFILL')).toBe(true);

  const cv = await prisma.unmappedSkillTerm.findFirst({ where: { orgId, normalizedKey: 'bilgisayar gorusu' } });
  expect(cv?.occurrences).toBe(2);
  expect(cv?.resolution).toBe('PENDING');

  backfill('--apply');
  expect(await counts()).toEqual(first);

  // The JSON column is never touched.
  const a = await prisma.user.findUnique({ where: { id: ids.a }, select: { skills: true } });
  expect(a?.skills).toEqual(['ReactJS', 'VERİ MÜHENDİSLİĞİ', 'Bilgisayar Görüsü', 'Kubernetes Operators']);
});

test('the queue is ADMIN-only', async ({ playwright, baseURL }) => {
  const mentorCtx = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(mentorCtx, mentorEmail, PASSWORD)).ok).toBe(true);
  expect((await mentorCtx.get('/api/admin/skills/unmapped')).status()).toBe(403);
  const term = await prisma.unmappedSkillTerm.findFirstOrThrow({ where: { orgId } });
  expect((await mentorCtx.post(`/api/admin/skills/unmapped/${term.id}`, { data: { action: 'discard' } })).status()).toBe(403);
  await mentorCtx.dispose();
});

test('an admin aliases one term and promotes another; holders are linked retroactively', async ({ request }) => {
  expect((await signInViaApi(request, adminEmail, PASSWORD)).ok).toBe(true);

  const list = await request.get('/api/admin/skills/unmapped');
  expect(list.ok()).toBe(true);
  const { terms } = await list.json();
  expect(terms.map((t: { normalizedKey: string }) => t.normalizedKey)).toEqual(['bilgisayar gorusu', 'kubernetes operators', 'lindy hop']);

  // Alias "Bilgisayar Görüsü" onto the Machine Learning skill (the curator's call).
  const cvSkill = await prisma.skill.findFirstOrThrow({ where: { orgId, key: 'machine-learning' } });
  const cvTerm = terms[0];
  const alias = await request.post(`/api/admin/skills/unmapped/${cvTerm.id}`, { data: { action: 'alias', skillId: cvSkill.id } });
  expect(alias.ok()).toBe(true);
  expect(await alias.json()).toMatchObject({ resolution: 'ALIASED', skillId: cvSkill.id, linkedUsers: 2 });
  expect(await prisma.userSkill.count({ where: { skillId: cvSkill.id } })).toBe(2);
  expect(await prisma.skillAlias.count({ where: { orgId, key: 'bilgisayar gorusu', skillId: cvSkill.id } })).toBe(1);

  // Deciding it twice is a conflict, not a second write.
  const again = await request.post(`/api/admin/skills/unmapped/${cvTerm.id}`, { data: { action: 'discard' } });
  expect(again.status()).toBe(409);

  // Promote "Kubernetes Operators" to a canonical skill of its own.
  const k8sTerm = terms[1];
  const promote = await request.post(`/api/admin/skills/unmapped/${k8sTerm.id}`, { data: { action: 'promote' } });
  expect(promote.ok()).toBe(true);
  const promoted = await promote.json();
  expect(promoted).toMatchObject({ resolution: 'PROMOTED', linkedUsers: 2 });
  const k8s = await prisma.skill.findUniqueOrThrow({ where: { id: promoted.skillId } });
  expect(k8s.key).toBe('kubernetes-operators');
  expect(k8s.labelEn).toBe('Kubernetes Operators');

  // Discard the last one; nothing is linked.
  const lindy = await request.post(`/api/admin/skills/unmapped/${terms[2].id}`, { data: { action: 'discard' } });
  expect(await lindy.json()).toMatchObject({ resolution: 'DISCARDED', skillId: null });

  // A term of another org answers 404, like a missing one.
  const foreign = await prisma.unmappedSkillTerm.create({ data: { orgId: otherOrgId, normalizedKey: 'x', term: 'x' } });
  expect((await request.post(`/api/admin/skills/unmapped/${foreign.id}`, { data: { action: 'discard' } })).status()).toBe(404);

  // The next deploy's backfill now resolves both decided terms and leaves the
  // decisions alone.
  backfill('--apply');
  const decided = await prisma.unmappedSkillTerm.findMany({ where: { orgId }, select: { normalizedKey: true, resolution: true } });
  expect(Object.fromEntries(decided.map((d) => [d.normalizedKey, d.resolution]))).toEqual({
    'bilgisayar gorusu': 'ALIASED',
    'kubernetes operators': 'PROMOTED',
    'lindy hop': 'DISCARDED',
  });
});
