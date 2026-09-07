import { test, expect } from '@playwright/test';
import { prisma, uniqueEmail } from './helpers/db';
import { defaultPipelineStages, resolvePipelineStages, onPathKeys, startStageKey, isDefaultLabel } from '../src/lib/pipelineStages';

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

// The start stage a create writes (#1634). The interesting case is the set that
// is non-empty but has NO on-path stage: falling back to the canonical
// `APPLICATION_100` there would write a key the tenant does not have — exactly
// the invisible-relation bug #1634 exists to close.
test('startStageKey never returns a key outside a non-empty stage set', () => {
  const stage = (key: string, order: number, isOffPath = false) => ({
    key, label: key, order, isTerminal: false, isOffPath, color: null,
  });

  // Built-in catalogue: unchanged.
  expect(startStageKey(defaultPipelineStages())).toBe('APPLICATION_100');
  // Off-path stage ordered first is skipped, and order — not array position — wins.
  expect(startStageKey([stage('SCREENING', 2), stage('WITHDRAWN', 0, true), stage('SOURCED', 1)]))
    .toBe('SOURCED');
  // All off-path: the tenant's own first stage, not a key it has never heard of.
  expect(startStageKey([stage('LOST', 1, true), stage('WITHDRAWN', 0, true)])).toBe('WITHDRAWN');
  // Genuinely empty (an org on the defaults, resolved elsewhere): canonical floor.
  expect(startStageKey([])).toBe('APPLICATION_100');
});

// #2268: a stage the tenant never renamed must read back in the VIEWER'S
// language. The editor's GET used to prefill the English built-in labels and its
// Save posted them straight back, so a single click on an untouched editor froze
// English into the DB for every reader in every language.
test('isDefaultLabel recognizes a built-in label in any locale, and only for a built-in key', () => {
  // The label the editor prefilled, in each of the three languages.
  expect(isDefaultLabel('APPLICATION_100', '100 · First contact')).toBe(true);
  expect(isDefaultLabel('APPLICATION_100', '100 · İlk temas')).toBe(true);
  expect(isDefaultLabel('APPLICATION_100', '100 · Erstkontakt')).toBe(true);
  // Blank is the sentinel a save writes for an untouched stage.
  expect(isDefaultLabel('APPLICATION_100', '')).toBe(true);
  expect(isDefaultLabel('APPLICATION_100', '   ')).toBe(true);
  // Something an admin actually typed is theirs, and a custom KEY never counts
  // as a default however plausible its label reads.
  expect(isDefaultLabel('APPLICATION_100', 'Ön görüşme')).toBe(false);
  expect(isDefaultLabel('APPLICATION_100', '100 · First contacts')).toBe(false);
  expect(isDefaultLabel('LEAD', 'Lead')).toBe(false);
});

test('un-renamed stage rows localize, renamed ones render verbatim', async () => {
  const stamp = uniqueEmail('ps').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `PS ${stamp}`, slug: `psl-${stamp}` } });
  try {
    await prisma.pipelineStage.createMany({
      data: [
        // The sentinel a save writes now …
        { orgId: org.id, key: 'APPLICATION_100', label: '', order: 0 },
        // … and what the old editor actually persisted: the English default.
        { orgId: org.id, key: 'APPROVAL_PENDING_220', label: '220 · Awaiting approval', order: 1 },
        // A label the admin really typed.
        { orgId: org.id, key: 'INTERVIEW_PENDING_250', label: 'Ön görüşme', order: 2 },
      ],
    });

    const tr = await resolvePipelineStages(org.id, 'tr');
    expect(tr.map((s) => s.label)).toEqual(['100 · İlk temas', '220 · Onay bekliyor', 'Ön görüşme']);
    const de = await resolvePipelineStages(org.id, 'de');
    expect(de.map((s) => s.label)).toEqual(['100 · Erstkontakt', '220 · Warte auf Freigabe', 'Ön görüşme']);
    const en = await resolvePipelineStages(org.id, 'en');
    expect(en.map((s) => s.label)).toEqual(['100 · First contact', '220 · Awaiting approval', 'Ön görüşme']);
  } finally {
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
