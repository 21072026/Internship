import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { summarizeOutcomes, readDestinationAnswer, outcomeSurveyInput, DESTINATIONS } = await import('../../src/lib/outcomeDestination.ts');

const person = (id, cohort = 'Spring', source = null) => ({ personId: id, cohort, source });

test('knowledge rate counts consented answers only; a "no" is withheld, never broken down', () => {
  const people = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => person(id));
  const answers = new Map([
    ['a', { destination: 'EMPLOYED_ELSEWHERE', consent: true }],
    ['b', { destination: 'EMPLOYED_ELSEWHERE', consent: true }],
    ['c', { destination: 'EMPLOYED_HERE', consent: true }],
    ['d', { destination: 'CONTINUING_STUDY', consent: true }],
    ['e', { destination: 'SEEKING', consent: true }],
    ['f', { destination: 'EMPLOYED_HERE', consent: false }],
  ]);
  const { overall } = summarizeOutcomes(people, answers);
  assert.equal(overall.eligible, 8);
  assert.equal(overall.known, 5);
  assert.equal(overall.withheld, 1);
  assert.equal(overall.knowledgeRate, 5 / 8);
  assert.equal(overall.destinations.EMPLOYED_ELSEWHERE, 2);
  // The withheld EMPLOYED_HERE is not in the table.
  assert.equal(overall.destinations.EMPLOYED_HERE, 1);
  assert.equal(overall.placedRate, 4 / 5);
});

test('the floor applies per bucket: a small cohort shows its knowledge rate and nothing else', () => {
  const people = [...['a', 'b', 'c', 'd', 'e'].map((id) => person(id, 'Spring')), ...['x', 'y'].map((id) => person(id, 'Autumn')), person('z', null)];
  const answers = new Map([...people].map((p) => [p.personId, { destination: 'SEEKING', consent: true }]));
  const s = summarizeOutcomes(people, answers);
  const spring = s.byCohort.find((b) => b.label === 'Spring');
  const autumn = s.byCohort.find((b) => b.label === 'Autumn');
  assert.ok(spring.destinations);
  assert.equal(autumn.destinations, null);
  assert.equal(autumn.placedRate, null);
  assert.equal(autumn.knowledgeRate, 1);
  // Largest first, the unassigned bucket last.
  assert.deepEqual(s.byCohort.map((b) => b.label), ['Spring', 'Autumn', null]);
  // A floor can be raised, never lowered below the survey default.
  assert.equal(summarizeOutcomes(people, answers, 1).floor, 5);
  assert.equal(summarizeOutcomes(people, answers, 10).overall.destinations, null);
});

test('a stored response parses only with a known destination code', () => {
  assert.deepEqual(readDestinationAnswer([{ questionKey: 'destination', value: 'OTHER' }, { questionKey: 'consent', value: true }]), { destination: 'OTHER', consent: true });
  assert.deepEqual(readDestinationAnswer([{ questionKey: 'destination', value: 'OTHER' }]), { destination: 'OTHER', consent: false });
  assert.equal(readDestinationAnswer([{ questionKey: 'destination', value: 'Working somewhere else' }]), null);
});

test('the instrument stores codes, in all three languages, within the three-question cap', () => {
  const input = outcomeSurveyInput();
  assert.equal(input.questions.length, 3);
  const dest = input.questions.find((q) => q.key === 'destination');
  assert.equal(dest.type, 'SELECT');
  assert.deepEqual(dest.options.map((o) => o.value), [...DESTINATIONS]);
  for (const o of dest.options) assert.ok(o.labels.en && o.labels.tr && o.labels.de);
  assert.equal(input.questions.find((q) => q.key === 'consent').type, 'BOOLEAN');
  assert.equal(input.anonymity, 'IDENTIFIED');
});
