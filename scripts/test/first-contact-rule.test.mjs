// Unit tests for the go-live week numbers (#2578, src/lib/firstContactRule.ts).
//
// Run: node --test --experimental-strip-types scripts/test/first-contact-rule.test.mjs
//
// What a reviewer cannot keep in their head: the median is over the records
// whose clock STARTED in the window, a record not contacted yet is counted as
// waiting and never as zero, the clock starts at the request when there was one,
// and the definition in the checklist is the code's own sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIRST_CONTACT_DEFINITION, firstContactStart, firstContactSummary, median, trialEndCoverage } from '../../src/lib/firstContactRule.ts';

const H = 60 * 60 * 1000;
const t0 = Date.parse('2026-11-02T08:00:00Z');
const at = (hours) => new Date(t0 + hours * H);

test('median: odd, even, empty', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('the clock starts at the request, else at the record', () => {
  assert.equal(firstContactStart({ requestedAt: at(0), startDate: at(5) }), t0);
  assert.equal(firstContactStart({ requestedAt: null, startDate: at(5) }), t0 + 5 * H);
});

test('median hours from request to first interaction; waiting is counted, not folded in', () => {
  const s = firstContactSummary([
    { requestedAt: at(0), startDate: at(1), firstInteractionAt: at(2) }, // 2h from the request, not 1h
    { startDate: at(0), firstInteractionAt: at(10) }, // 10h, no request
    { requestedAt: at(0), startDate: at(0), firstInteractionAt: at(30) }, // 30h
    { requestedAt: at(0), startDate: at(0), firstInteractionAt: null }, // waiting
  ]);
  assert.deepEqual(s, { medianHours: 10, contacted: 3, waiting: 1, contactedBefore: 0 });
});

test('an even population takes the mean of the two middle values, to one decimal', () => {
  const s = firstContactSummary([
    { startDate: at(0), firstInteractionAt: at(1) },
    { startDate: at(0), firstInteractionAt: at(2.25) },
  ]);
  assert.equal(s.medianHours, 1.6); // 1.625 → 1.6
});

test('an interaction before the request is not a response time', () => {
  const s = firstContactSummary([
    { requestedAt: at(10), startDate: at(10), firstInteractionAt: at(2) },
    { requestedAt: at(0), startDate: at(0), firstInteractionAt: at(4) },
  ]);
  assert.deepEqual(s, { medianHours: 4, contacted: 1, waiting: 0, contactedBefore: 1 });
});

test('only records whose clock started inside the window count; no window = everything', () => {
  const rows = [
    { requestedAt: at(-48), startDate: at(-48), firstInteractionAt: at(-47) }, // before the window
    { requestedAt: at(0), startDate: at(0), firstInteractionAt: at(3) },
    { requestedAt: at(200), startDate: at(200), firstInteractionAt: null }, // after the window
  ];
  assert.deepEqual(firstContactSummary(rows, { from: at(-1), to: at(100) }), { medianHours: 3, contacted: 1, waiting: 0, contactedBefore: 0 });
  assert.equal(firstContactSummary(rows).contacted, 2);
  assert.equal(firstContactSummary(rows).waiting, 1);
});

test('nobody contacted yet: no median, the waiting count says why', () => {
  assert.deepEqual(firstContactSummary([{ startDate: at(0) }]), { medianHours: null, contacted: 0, waiting: 1, contactedBefore: 0 });
  assert.deepEqual(firstContactSummary([]), { medianHours: null, contacted: 0, waiting: 0, contactedBefore: 0 });
});

test('trial-date coverage: share of TRIAL_ACTIVE records with an end date, as a whole percent', () => {
  assert.deepEqual(
    trialEndCoverage([
      { startDate: at(0), trialStartedAt: at(0), trialEndsAt: at(24 * 14) },
      { startDate: at(0), trialStartedAt: at(0), trialEndsAt: null },
      { startDate: at(0), trialStartedAt: null, trialEndsAt: at(24 * 14) },
    ]),
    { total: 3, withEnd: 2, rate: 67 },
  );
  assert.deepEqual(trialEndCoverage([]), { total: 0, withEnd: 0, rate: null });
});

test('trial-date coverage in a window: by trial start, else the record start', () => {
  const rows = [
    { startDate: at(-500), trialStartedAt: at(5), trialEndsAt: null }, // trial started inside
    { startDate: at(6), trialStartedAt: null, trialEndsAt: null }, // no stamp: the record start, inside
    { startDate: at(-500), trialStartedAt: at(-400), trialEndsAt: at(0) }, // before the window
  ];
  assert.deepEqual(trialEndCoverage(rows, { from: at(0), to: at(100) }), { total: 2, withEnd: 0, rate: 0 });
});

test('the checklist carries the definition word for word', () => {
  const doc = readFileSync(new URL('../../docs/marketing-vertical/go-live-checklist.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(FIRST_CONTACT_DEFINITION), 'go-live-checklist.md §2 must quote FIRST_CONTACT_DEFINITION verbatim');
  // And the rule never leans on the last-contact rule (#2275), which counts messages.
  const rule = readFileSync(new URL('../../src/lib/firstContactRule.ts', import.meta.url), 'utf8');
  assert.ok(!/^import .*lastContact/m.test(rule));
});
