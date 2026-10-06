// Unit tests for the programme health scorecard's judgement (#1908): the
// band boundaries, the not-enough-data floor, the honest "not measurable"
// rows, and that every threshold is documented.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { bandFor, buildScorecard, medianOf, percentOf, SCORECARD_THRESHOLDS, SCORECARD_KEYS, MIN_TO_JUDGE } = await import('../../src/lib/programScorecard.ts');

test('a threshold is inclusive on the good side, in both directions', () => {
  assert.equal(bandFor('matchRate', 80), 'GREEN');
  assert.equal(bandFor('matchRate', 79), 'AMBER');
  assert.equal(bandFor('matchRate', 60), 'AMBER');
  assert.equal(bandFor('matchRate', 59), 'RED');
  assert.equal(bandFor('stalledPairs', 10), 'GREEN');
  assert.equal(bandFor('stalledPairs', 11), 'AMBER');
  assert.equal(bandFor('stalledPairs', 25), 'AMBER');
  assert.equal(bandFor('stalledPairs', 26), 'RED');
  assert.equal(bandFor('timeToFirstMeeting', 14), 'GREEN');
  assert.equal(bandFor('timeToFirstMeeting', 29), 'RED');
});

test('amber and red rows carry a destination; green rows do not', () => {
  const rows = buildScorecard({ matchRate: { value: 59, basis: 20 }, atRisk: { value: 5, basis: 20 }, stalledPairs: { value: 20, basis: 20 } });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.matchRate.band, 'RED');
  assert.equal(by.matchRate.nextAction, '/admin/mentorship');
  assert.equal(by.stalledPairs.band, 'AMBER');
  assert.equal(by.stalledPairs.nextAction, '/admin/health');
  assert.equal(by.atRisk.band, 'GREEN');
  assert.equal(by.atRisk.nextAction, null);
});

test('below the floor, or with nothing counted, a row says "not enough data" — never a 0', () => {
  const rows = buildScorecard({ matchRate: { value: 0, basis: MIN_TO_JUDGE - 1 }, activation: { value: null, basis: 0 } });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.matchRate.status, 'insufficient');
  assert.equal(by.activation.status, 'insufficient');
  assert.equal(by.meetingCadence.status, 'insufficient');
  assert.equal('value' in by.matchRate, false);
});

test('every indicator is measurable now: with no data a row says "not enough data", never "not measurable"', () => {
  const by = Object.fromEntries(buildScorecard({}).map((r) => [r.key, r]));
  // #1891 measured the last one.
  assert.equal(by.evaluationCoverage.status, 'insufficient');
  assert.equal(buildScorecard({}).some((r) => r.status === 'not_measurable'), false);
  assert.equal(bandFor('evaluationCoverage', 80), 'GREEN');
  assert.equal(bandFor('evaluationCoverage', 50), 'AMBER');
  assert.equal(bandFor('evaluationCoverage', 49), 'RED');
  // The survey indicators became measurable with #1910: no data is "not enough data", not "not measurable".
  assert.equal(by.nps.status, 'insufficient');
  assert.equal(by.surveyResponseRate.status, 'insufficient');
  assert.equal(buildScorecard({}).length, SCORECARD_KEYS.length);
});

test('helpers round once', () => {
  assert.equal(percentOf(1, 8), 13);
  assert.equal(percentOf(0, 0), null);
  assert.equal(medianOf([9, 1, 5]), 5);
  assert.equal(medianOf([1, 2, 3, 4]), 3);
  assert.equal(medianOf([]), null);
});

test('every threshold is justified in the source and published in the doc', () => {
  const src = readFileSync(new URL('../../src/lib/programScorecard.ts', import.meta.url), 'utf8');
  const doc = readFileSync(new URL('../../docs/program-scorecard.md', import.meta.url), 'utf8');
  for (const [key, t] of Object.entries(SCORECARD_THRESHOLDS)) {
    const line = src.split('\n').findIndex((l) => l.trimStart().startsWith(`${key}: {`));
    assert.ok(line > 0 && src.split('\n')[line - 1].trimStart().startsWith('//'), `${key} has a comment above it`);
    assert.match(doc, new RegExp(`\\| \`${key}\` \\|[^\\n]*\\| ${t.green} \\|[^\\n]*\\| ${t.amber} \\|`), `${key} row in the doc`);
  }
});

test('NPS is a signed score: above 0 is amber, 30 is green, a negative score is red', () => {
  assert.equal(bandFor('nps', 30), 'GREEN');
  assert.equal(bandFor('nps', 29), 'AMBER');
  assert.equal(bandFor('nps', 0), 'AMBER');
  assert.equal(bandFor('nps', -1), 'RED');
  const [row] = buildScorecard({ nps: { value: -12, basis: 40 } }).filter((r) => r.key === 'nps');
  assert.deepEqual({ status: row.status, band: row.band, unit: row.unit, nextAction: row.nextAction }, { status: 'ok', band: 'RED', unit: 'score', nextAction: '/admin/surveys' });
  assert.equal(bandFor('surveyResponseRate', 50), 'GREEN');
  assert.equal(bandFor('surveyResponseRate', 29), 'RED');
});
