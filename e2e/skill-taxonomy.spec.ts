import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { expandAdjacent, resolveMany, resolveSkill, seedSkillTaxonomy } from '../src/lib/skillsResolve';
import { SKILL_SEED } from '../src/lib/skillSeed';
import { prisma as appPrisma } from '../src/lib/prisma';

// The DB-backed half of the canonical skill taxonomy (#1815): the starter
// vocabulary lands in an org as rows, and the resolver turns every spelling of
// a skill into ONE canonical row — following merges, skipping retired skills,
// and never leaking another org's vocabulary. The pure graph rules are unit
// tested in scripts/test/skill-taxonomy.test.mjs.
//
// Browserless: it talks to the database directly, so it costs no page.

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let orgId = '';
let otherOrgId = '';

test.beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `Skill Taxonomy ${STAMP}`, slug: `skill-tax-${STAMP}` } });
  const other = await prisma.organization.create({ data: { name: `Skill Taxonomy B ${STAMP}`, slug: `skill-tax-b-${STAMP}` } });
  orgId = org.id;
  otherOrgId = other.id;
});

test.afterAll(async () => {
  // Cascades remove Skill / SkillAlias / SkillEdge with the org.
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId].filter(Boolean) } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test.describe.configure({ mode: 'serial' });

test('seeding is idempotent and brings the whole starter vocabulary', async () => {
  const first = await seedSkillTaxonomy(orgId);
  expect(first.skills).toBe(SKILL_SEED.length);
  expect(first.aliases).toBeGreaterThan(SKILL_SEED.length);
  expect(first.edges).toBeGreaterThan(0);

  const again = await seedSkillTaxonomy(orgId);
  expect(again).toEqual({ skills: 0, aliases: 0, edges: 0 });
});

test('React, react, React.js and REACTJS resolve to the same canonical row', async () => {
  const spellings = ['React', 'react', 'React.js', 'REACTJS'];
  const resolved = await resolveMany(orgId, spellings);
  const ids = spellings.map((s) => resolved.get(s)?.id);
  expect(ids[0]).toBeTruthy();
  expect(new Set(ids).size).toBe(1);
  expect(resolved.get('React')?.key).toBe('react');

  expect(await resolveSkill(orgId, 'Underwater basket weaving')).toBeNull();
  expect(await resolveSkill(orgId, '   ')).toBeNull();
});

test("another org's vocabulary never resolves", async () => {
  expect(await resolveSkill(otherOrgId, 'React')).toBeNull();
});

test('a merged skill keeps resolving to where it was merged, a retired one stops', async () => {
  const vue = await resolveSkill(orgId, 'Vue');
  const react = await resolveSkill(orgId, 'React');
  expect(vue && react).toBeTruthy();

  await prisma.skill.update({ where: { id: vue!.id }, data: { mergedIntoId: react!.id, status: 'RETIRED' } });
  expect((await resolveSkill(orgId, 'Vue.js'))?.id).toBe(react!.id);

  await prisma.skill.update({ where: { id: react!.id }, data: { status: 'RETIRED' } });
  expect(await resolveSkill(orgId, 'React')).toBeNull();
  expect((await resolveSkill(orgId, 'React', { includeRetired: true }))?.id).toBe(react!.id);

  await prisma.skill.update({ where: { id: react!.id }, data: { status: 'ACTIVE' } });
  await prisma.skill.update({ where: { id: vue!.id }, data: { mergedIntoId: null, status: 'ACTIVE' } });
});

test('expandAdjacent: origin at weight 1, neighbours below it, terminates on a cycle', async () => {
  const react = (await resolveSkill(orgId, 'React'))!;
  const frontend = (await resolveSkill(orgId, 'Frontend'))!;

  const out = await expandAdjacent(orgId, [react.id]);
  expect(out[0]).toEqual({ skillId: react.id, weight: 1 });
  const fe = out.find((w) => w.skillId === frontend.id);
  expect(fe?.weight).toBeGreaterThan(0);
  expect(fe!.weight).toBeLessThan(1);

  // The seeded graph is full of cycles (React ↔ Frontend ↔ Vue ↔ …); three
  // hops must still come back, with every id once.
  const deep = await expandAdjacent(orgId, [react.id], 3);
  expect(new Set(deep.map((w) => w.skillId)).size).toBe(deep.length);
  expect(deep.every((w) => w.weight <= 1 && w.weight > 0)).toBe(true);

  // A retired neighbour is dropped from the expansion.
  await prisma.skill.update({ where: { id: frontend.id }, data: { status: 'RETIRED' } });
  const without = await expandAdjacent(orgId, [react.id]);
  expect(without.some((w) => w.skillId === frontend.id)).toBe(false);
  await prisma.skill.update({ where: { id: frontend.id }, data: { status: 'ACTIVE' } });
});
