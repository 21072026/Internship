import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { analyticsFacts, factsText, ungroundedNumbers, acceptNarrative } = await import('../../src/lib/ai/narrativeRules.ts');

// The golden case (#2046): a fixed dashboard, a paragraph that cites only what
// it was given, and the ways a paragraph goes wrong — each must be rejected.
const dashboard = {
  range: { from: '2026-05-01', to: '2026-10-06' },
  totalRelations: 42,
  conversionToHired: 19,
  finishedLabel: 'Hired',
  funnel: { APPLICATION_100: 12, INTERNSHIP_IN_PROGRESS_450: 9, HIRED_660: 8 },
  engagement: { interactions: 310, meetings: 57 },
  rsvp: { acceptanceRate: 88 },
  trends: { months: ['2026-08', '2026-09'], newRelations: [7, 3], interactions: [64, 41] },
  signupFunnel: [{ days: 7, registered: 5, verified: 4, active: 4 }, { days: 30, registered: 21, verified: 18, active: 17 }],
};
const labels = { APPLICATION_100: 'Application', INTERNSHIP_IN_PROGRESS_450: 'Internship in progress', HIRED_660: 'Hired' };
const facts = analyticsFacts(dashboard, (k) => labels[k] ?? k);

test('the facts carry the figures and nothing that identifies a person', () => {
  const text = factsText(facts);
  assert.match(text, /Pairings in the pipeline now \(all time\): 42/);
  assert.match(text, /Pairings at stage "Application" now: 12/);
  assert.match(text, /Interactions logged in 2026-09: 41/);
  assert.doesNotMatch(text, /APPLICATION_100/); // stage keys carry numbers of their own
});

test('golden: a paragraph citing only given figures is kept', () => {
  const good = 'Interactions fell from 64 in 2026-08 to 41 in 2026-09, and new pairings from 7 to 3. Why is not visible in these figures. 8 pairings are at the Hired stage, 19 percent of 42.';
  assert.deepEqual(ungroundedNumbers(good, facts), []);
  assert.equal(acceptNarrative(good, facts), good);
});

test('golden: an invented, derived or rounded figure rejects the whole paragraph', () => {
  // A computed change the input never stated.
  assert.equal(acceptNarrative('Interactions dropped by 36% between 2026-08 and 2026-09.', facts), null);
  assert.deepEqual(ungroundedNumbers('Interactions dropped by 36% between 2026-08 and 2026-09.', facts), ['36']);
  // A rounded figure.
  assert.equal(acceptNarrative('Around 300 interactions were logged.', facts), null);
  // A year that is not in the range.
  assert.equal(acceptNarrative('Activity is the lowest since 2024.', facts), null);
  // Thousands separators and decimal commas are read both ways, never as a loophole.
  assert.deepEqual(ungroundedNumbers('1.310 interactions', facts), ['1.310']);
  assert.equal(acceptNarrative('', facts), null);
});
