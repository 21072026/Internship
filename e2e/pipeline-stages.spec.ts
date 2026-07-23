import { test, expect } from '@playwright/test';
import { prisma, uniqueEmail } from './helpers/db';
import { defaultPipelineStages, resolvePipelineStages, onPathKeys } from '../src/lib/pipelineStages';

// Per-tenant pipeline stages (#747, Phase A). Behavior-preserving: no rows → the
// canonical enum defaults; rows → the tenant's override. Exercised against a real
// DB so the fallback + override paths are both proven.
test.afterAll(async () => { await prisma.$disconnect(); });

test('defaults mirror the canonical 13 stages with correct flags', () => {
  const d = defaultPipelineStages('en');
  expect(d).toHaveLength(13);
  expect(d[0].key).toBe('APPLICATION_100');
  expect(d.find((s) => s.key === 'EMPLOYED_700')?.isTerminal).toBe(true);
  expect(d.find((s) => s.key === 'INTERNSHIP_DROPPED_460')?.isOffPath).toBe(true);
  expect(d.find((s) => s.key === 'INTERNSHIP_FOUND_ELSEWHERE_800')?.isOffPath).toBe(true);
  // on-path excludes the two off-path stages.
  expect(onPathKeys(d)).not.toContain('INTERNSHIP_DROPPED_460');
  expect(onPathKeys(d)).not.toContain('INTERNSHIP_FOUND_ELSEWHERE_800');
  expect(onPathKeys(d)[0]).toBe('APPLICATION_100');
});

test('resolves defaults for a null org and for an org with no custom rows', async () => {
  expect((await resolvePipelineStages(null)).length).toBe(13);
  const stamp = uniqueEmail('ps').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `PS ${stamp}`, slug: `ps-${stamp}` } });
  try {
    const resolved = await resolvePipelineStages(org.id);
    expect(resolved.map((s) => s.key)).toEqual(defaultPipelineStages().map((s) => s.key));
  } finally {
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('an org with custom rows overrides the defaults', async () => {
  const stamp = uniqueEmail('ps').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `PS ${stamp}`, slug: `psc-${stamp}` } });
  try {
    await prisma.pipelineStage.createMany({
      data: [
        { orgId: org.id, key: 'LEAD', label: 'Lead', order: 0, color: '#2563eb' },
        { orgId: org.id, key: 'HIRED', label: 'Hired', order: 1, isTerminal: true },
        { orgId: org.id, key: 'LOST', label: 'Lost', order: 2, isOffPath: true, isTerminal: true },
      ],
    });
    const resolved = await resolvePipelineStages(org.id);
    expect(resolved.map((s) => s.key)).toEqual(['LEAD', 'HIRED', 'LOST']);
    expect(resolved[0].color).toBe('#2563eb');
    expect(onPathKeys(resolved)).toEqual(['LEAD', 'HIRED']); // LOST is off-path
  } finally {
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
