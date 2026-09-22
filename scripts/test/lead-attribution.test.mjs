// Unit tests for lead attribution (#2421, epic #2348 / story #2393).
//
// WHY THIS FILE EXISTS
//   src/lib/leadAttribution.ts answers "which source actually brings
//   customers?", and every way of getting it wrong type-checks:
//
//     • counting against a HARDCODED finished-stage set reports 0% from every
//       source for any tenant on its own stage catalogue — which is every
//       MARKETING tenant, whose preset ends at DEAL_WON, not HIRED_660. That is
//       #1882, and it was reintroduced twice; here the finished set is an
//       argument, and the tests use a non-canonical one on purpose.
//     • counting a SOURCE login as a person that source referred shows the
//       source as having referred itself (src/lib/referrer.ts).
//     • a person with two funnel records, one won and one open, is ONE
//       conversion, not two and not zero.
//
//   None of that is reachable from a browser test without standing up a whole
//   tenant, so it is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// leadAttribution.ts imports './referrer' the way the bundler resolves it, so
// the runner needs the shared extensionless hook. Dynamic import, after
// register() — a static one is hoisted above it (see the hook's header).
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { FUNNEL_LEAD_ROLE, countsTowardSource, sourceAttributionRows } = await import(
  '../../src/lib/leadAttribution.ts'
);
const { encodeReferrer, sourceIsReferral } = await import('../../src/lib/referrer.ts');

// A tenant that renamed its pipeline — deliberately NOT the canonical keys.
const MARKETING_FINISHED = ['DEAL_WON'];

test('a SOURCE account is never counted toward the source it speaks for', () => {
  // The column means "which source this account speaks for" on that one role,
  // so reading it as a referral makes a source look like its own best channel.
  assert.equal(sourceIsReferral('SOURCE'), false);
  assert.equal(countsTowardSource('SOURCE'), false);
  // And the two rules agree with the encoder that already shipped the same one.
  assert.equal(encodeReferrer({ sourceId: 's1', role: 'SOURCE' }), '');
  assert.equal(encodeReferrer({ sourceId: 's1', role: FUNNEL_LEAD_ROLE }), 'source:s1');
});

test('only the funnel lead side is counted — staff attributed to a source are not leads', () => {
  assert.equal(countsTowardSource(FUNNEL_LEAD_ROLE), true);
  for (const role of ['ADMIN', 'MENTOR', 'COMPANY', null, undefined, '']) {
    assert.equal(countsTowardSource(role), false, `${String(role)} must not count as a lead`);
  }
});

test('conversion is measured against the TENANT\'s finished stages, not HIRED_660', () => {
  const rows = sourceAttributionRows(
    [
      {
        id: 'src1',
        name: 'Trade fair',
        leads: [
          { stages: ['DEAL_WON'] },
          { stages: ['LEAD_QUALIFIED'] },
          { stages: ['TRIAL_ACTIVE'] },
          { stages: ['DEAL_WON'] },
        ],
      },
    ],
    MARKETING_FINISHED,
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'src1',
    name: 'Trade fair',
    mentees: 4,
    inPipeline: 4,
    hired: 2,
    conversionToHired: 50,
  });

  // The same people against the internship catalogue convert at 0% — which is
  // exactly the bug when the set is hardcoded rather than resolved per tenant.
  const wrong = sourceAttributionRows(
    [{ id: 'src1', name: 'Trade fair', leads: [{ stages: ['DEAL_WON'] }] }],
    ['HIRED_660', 'EMPLOYED_700'],
  );
  assert.equal(wrong[0].hired, 0);
  assert.equal(wrong[0].conversionToHired, 0);
});

test('attributed but never in the funnel is counted in the total, not in the pipeline', () => {
  const [row] = sourceAttributionRows(
    [
      {
        id: 'src2',
        name: 'Referral partner',
        leads: [{ stages: [] }, { stages: [] }, { stages: ['DEAL_WON'] }],
      },
    ],
    MARKETING_FINISHED,
  );
  // Three people came from this source; one of them entered the funnel and won.
  assert.equal(row.mentees, 3);
  assert.equal(row.inPipeline, 1);
  assert.equal(row.hired, 1);
  assert.equal(row.conversionToHired, 33); // 1/3, rounded — never 1/1
});

test('one person with several funnel records converts once', () => {
  const [row] = sourceAttributionRows(
    [
      {
        id: 'src3',
        name: 'Webinar',
        leads: [{ stages: ['DEAL_LOST', 'DEAL_WON', 'TRIAL_ACTIVE'] }],
      },
    ],
    MARKETING_FINISHED,
  );
  assert.equal(row.mentees, 1);
  assert.equal(row.inPipeline, 1);
  assert.equal(row.hired, 1);
  assert.equal(row.conversionToHired, 100);
});

test('a source nobody came from reports zeroes instead of dividing by zero', () => {
  const [row] = sourceAttributionRows([{ id: 'src4', name: 'Cold list', leads: [] }], MARKETING_FINISHED);
  assert.equal(row.mentees, 0);
  assert.equal(row.conversionToHired, 0);
  assert.ok(Number.isFinite(row.conversionToHired));
});

test('rows come back in the order they were handed in, one per source', () => {
  const rows = sourceAttributionRows(
    [
      { id: 'a', name: 'A', leads: [] },
      { id: 'b', name: 'B', leads: [{ stages: ['DEAL_WON'] }] },
      { id: 'c', name: 'C', leads: [] },
    ],
    MARKETING_FINISHED,
  );
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c']);
});

test('an empty finished set converts nobody rather than everybody', () => {
  // outcomeStageKeys() returns `finished: []` for the degenerate catalogue with
  // no on-path stage at all. The honest answer there is 0 conversions.
  const [row] = sourceAttributionRows(
    [{ id: 'src5', name: 'Anything', leads: [{ stages: ['DEAL_WON'] }] }],
    [],
  );
  assert.equal(row.hired, 0);
  assert.equal(row.conversionToHired, 0);
});
