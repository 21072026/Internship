// The tenant starter pack's catalogue (#2066) — no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const P = await import('../../src/lib/orgStarterPack.ts');
const { templateStages, programTemplate } = await import('../../src/lib/programTemplates.ts');
const { defaultPipelineStages } = await import('../../src/lib/pipeline.ts');
const LOCALES = ['en', 'tr', 'de'];

test('the canonical starter is the default stage set, keys straight from the catalogue', () => {
  const t = P.starterTemplate('INTERNSHIP');
  assert.equal(t.key, 'canonical_pipeline');
  assert.deepEqual(templateStages(t).map((s) => s.key), defaultPipelineStages().map((s) => s.key));
  assert.equal(P.starterTemplate('MARKETING').key, 'marketing_funnel');
  assert.equal(P.starterTemplate(null).key, 'canonical_pipeline');
});

test('every starter service level names a stage of its template, and the canonical days line up', () => {
  const canonical = programTemplate('canonical_pipeline');
  const onPath = templateStages(canonical).filter((s) => !s.isTerminal && !s.isOffPath);
  assert.equal(onPath.length, P.CANONICAL_SLA_DAYS.length, 'one day value per on-path, non-terminal canonical stage');
  for (const key of ['canonical_pipeline', 'marketing_funnel']) {
    const t = programTemplate(key);
    const stageKeys = new Set(templateStages(t).map((s) => s.key));
    for (const sla of P.starterSlas(t)) {
      assert.ok(stageKeys.has(sla.stageKey), `${key}: ${sla.stageKey}`);
      assert.ok(Number.isInteger(sla.days) && sla.days > 0);
    }
  }
  // Terminal and off-path stages never get a deadline.
  const terminal = new Set(templateStages(canonical).filter((s) => s.isTerminal || s.isOffPath).map((s) => s.key));
  assert.ok(P.starterSlas(canonical).every((s) => !terminal.has(s.stageKey)));
});

test('every label in the pack exists in all three languages', () => {
  const labelled = [
    ...P.STARTER_DOCUMENTS.map((d) => [d.key, d.labels]),
    ...P.STARTER_EVALUATION.MENTEE.criteria.map((c) => [c.key, c.labels]),
    ...P.STARTER_EVALUATION.MENTOR.criteria.map((c) => [c.key, c.labels]),
    ...P.STARTER_GOALS.map((g) => [g.tr, g]),
  ];
  for (const [key, labels] of labelled) for (const l of LOCALES) assert.ok(labels[l]?.trim(), `${key} lacks ${l}`);
  assert.equal(P.STARTER_DOCUMENTS.length, 4);
});

test('criterion keys are unique per scope and 5-6 per rubric; built-in keys come first', () => {
  for (const scope of ['MENTEE', 'MENTOR']) {
    const keys = P.STARTER_EVALUATION[scope].criteria.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.length >= 5 && keys.length <= 6);
  }
  assert.deepEqual(P.STARTER_EVALUATION.MENTEE.criteria.slice(0, 4).map((c) => c.key), ['technical', 'communication', 'reliability', 'growth']);
  assert.deepEqual(P.STARTER_EVALUATION.MENTOR.criteria.slice(0, 4).map((c) => c.key), ['guidance', 'availability', 'expertise', 'support']);
});
