// Unit tests for the forecast and capacity arithmetic (#1897).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { projectPlacements, capacityRequirement, horizonDaysFrom, resolvedConversions, MIN_JOURNEYS_PER_STAGE } = await import('../../src/lib/forecast.ts');

const ORDER = ['A', 'B', 'C', 'DONE'];
const conv = (key, entered, advanced) => ({ key, entered, advanced, rate: null, terminal: key === 'DONE' });
// 40 entered A, 20 reached B, 10 reached C, 5 finished: each step converts 50%.
const CONVERSIONS = [conv('A', 40, 20), conv('B', 20, 10), conv('C', 10, 5), conv('DONE', 5, 0)];
const DWELL = { A: 30, B: 30, C: 30 };
const base = (over = {}) => ({
  order: ORDER,
  finishedKey: 'DONE',
  cohortByStage: { A: 8, B: 4, C: 2 },
  conversions: CONVERSIONS,
  medianDwellByStage: DWELL,
  horizonDays: 120,
  ...over,
});

test('the projection is count × the product of the remaining step rates, summed', () => {
  const p = projectPlacements(base());
  assert.equal(p.status, 'ok');
  assert.equal(p.population, 14);
  // A: 8 × .5³ = 1, B: 4 × .5² = 1, C: 2 × .5 = 1
  assert.deepEqual(p.byStage.map((s) => [s.key, s.remainingConversion, s.dwellToFinishDays, s.expected]), [
    ['A', 0.125, 90, 1],
    ['B', 0.25, 60, 1],
    ['C', 0.5, 30, 1],
  ]);
  assert.equal(p.expected, 3);
  assert.ok(p.low < p.expected && p.expected < p.high, 'the sensitivity band brackets the figure');
  // The inputs come back with the outputs, so the screen can show the working.
  assert.deepEqual(p.steps.map((s) => [s.key, s.entered, s.advanced, s.rate]), [
    ['A', 40, 20, 0.5],
    ['B', 20, 10, 0.5],
    ['C', 10, 5, 0.5],
  ]);
});

test('a stage whose summed median dwell does not fit the horizon is not counted', () => {
  const p = projectPlacements(base({ horizonDays: 45 }));
  assert.deepEqual(p.byStage.map((s) => [s.key, s.fits, s.expected]), [
    ['A', false, 0],
    ['B', false, 0],
    ['C', true, 1],
  ]);
  assert.equal(p.expected, 1);
});

test('an unknown dwell on the way never counts as fitting', () => {
  const p = projectPlacements(base({ medianDwellByStage: { A: 30, B: null, C: 30 } }));
  const a = p.byStage.find((s) => s.key === 'A');
  assert.equal(a.dwellToFinishDays, null);
  assert.equal(a.fits, false);
  assert.equal(p.byStage.find((s) => s.key === 'C').expected, 1);
});

test('below the sample-size floor it refuses and names the stage', () => {
  const thin = [conv('A', 40, 20), conv('B', 20, 4), conv('C', 4, 2), conv('DONE', 2, 0)];
  const p = projectPlacements(base({ conversions: thin }));
  assert.equal(p.status, 'insufficient');
  assert.deepEqual(p.belowFloor, [{ key: 'C', entered: 4 }]);
  assert.equal(p.expected, 0);
  assert.deepEqual(p.byStage, []);
  assert.equal(p.minJourneys, MIN_JOURNEYS_PER_STAGE);
});

test('the floor only covers stages somebody is multiplied through', () => {
  // Nobody sits in A, so A's thin history is not used.
  const thinA = [conv('A', 3, 2), conv('B', 20, 10), conv('C', 10, 5), conv('DONE', 5, 0)];
  const p = projectPlacements(base({ conversions: thinA, cohortByStage: { B: 4 } }));
  assert.equal(p.status, 'ok');
  assert.equal(p.expected, 1);
});

test('zero conversion projects zero, with a zero band', () => {
  const dead = [conv('A', 40, 20), conv('B', 20, 10), conv('C', 10, 0), conv('DONE', 0, 0)];
  const p = projectPlacements(base({ conversions: dead }));
  assert.equal(p.status, 'ok');
  assert.equal(p.expected, 0);
  assert.equal(p.low, 0);
  assert.equal(p.high, 0);
});

test('no records in the pipeline is its own state, not a zero forecast', () => {
  const p = projectPlacements(base({ cohortByStage: { DONE: 9 } }));
  assert.equal(p.status, 'no_population');
  assert.equal(p.population, 0);
});

test('a finished stage that is first or missing has nothing to project', () => {
  assert.equal(projectPlacements(base({ finishedKey: 'A' })).status, 'no_population');
  assert.equal(projectPlacements(base({ finishedKey: 'NOPE' })).status, 'no_population');
});

test('capacity: mentee-days per stage against seats × horizon, the first overflow is the bottleneck', () => {
  const p = projectPlacements(base());
  // A: 8 × 30 = 240.  B: 4 × 30 + 8 × .5 × 30 = 240.  C: 2 × 30 + 4 × .5 × 30 + 8 × .25 × 30 = 180.
  const tight = capacityRequirement(p, { mentors: 2, mentorsWithCapacity: 2, seats: 4 });
  assert.equal(tight.status, 'ok');
  assert.deepEqual(tight.byStage.map((s) => [s.key, s.requiredDays, s.cumulativeDays]), [
    ['A', 240, 240],
    ['B', 240, 480],
    ['C', 180, 660],
  ]);
  assert.equal(tight.availableDays, 480); // 4 seats × 120 days
  assert.equal(tight.bottleneck, 'C');
  // 180 mentee-days short, at 2 mentees per mentor over 120 days = 1 more mentor.
  assert.equal(tight.additionalMentors, 1);

  const roomy = capacityRequirement(p, { mentors: 3, mentorsWithCapacity: 3, seats: 9 });
  assert.equal(roomy.bottleneck, null);
  assert.equal(roomy.additionalMentors, 0);
});

test('capacity stops at the horizon: a stage reached after it needs no seat', () => {
  const p = projectPlacements(base({ horizonDays: 45 }));
  const c = capacityRequirement(p, { mentors: 1, mentorsWithCapacity: 1, seats: 50 });
  // A: 8 × 30.  B: 4 × 30 + 8 × .5 × 15.  C: 2 × 30 + 4 × .5 × 15 + 8 × .25 × 0.
  assert.deepEqual(c.byStage.map((s) => s.requiredDays), [240, 180, 90]);
});

test('capacity is unknown when no mentor stated one, or when the projection refused', () => {
  const p = projectPlacements(base());
  assert.equal(capacityRequirement(p, { mentors: 4, mentorsWithCapacity: 0, seats: 0 }).status, 'unknown');
  const refused = projectPlacements(base({ conversions: [conv('A', 2, 1), conv('B', 1, 1), conv('C', 1, 1), conv('DONE', 1, 0)] }));
  assert.equal(capacityRequirement(refused, { mentors: 1, mentorsWithCapacity: 1, seats: 5 }).status, 'unknown');
});

test('horizon days run to the end of the horizon day and never go negative', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(horizonDaysFrom(now, '2026-10-30'), 10);
  assert.equal(horizonDaysFrom(now, '2026-10-01'), 0);
  assert.equal(horizonDaysFrom(now, 'garbage'), 0);
});

test('conversion counts an open journey only for the stages it has already left', () => {
  const j = (start, ...to) => ({ startStatus: start, startedAt: 0, changes: to.map((k, i) => ({ toStatus: k, at: i + 1 })) });
  const rows = resolvedConversions(['A', 'B', 'C'], [
    { journey: j('A'), open: false }, // stopped at A
    { journey: j('A'), open: true }, // still deciding A — not in A's rate
    { journey: j('A', 'B'), open: true }, // left A, still deciding B
    { journey: j('A', 'B', 'C'), open: false }, // finished
  ]);
  assert.deepEqual(rows.map((r) => [r.key, r.entered, r.advanced]), [
    ['A', 3, 2],
    ['B', 1, 1],
    ['C', 1, 0],
  ]);
});
