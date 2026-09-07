// Unit tests for the programme ROI model (#1892).
//
// Run: npm run test:roi  (node --test --experimental-strip-types)
//
// src/lib/roi.ts is the ONE ROI implementation in the tree: the internal report
// (#1895) and the public calculator (#1755) both compute through it, so a wrong
// number here is a wrong number in a prospect's browser. Nothing about money
// arithmetic is visible to the type system — an integer overflow, a division by
// zero rendered as Infinity, a coaching relation counted as a hire and a
// currency silently mixed all typecheck perfectly and all produce a confident,
// wrong figure. These assertions are what stands in for that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoi, roundMinor, DEFAULT_ASSUMPTIONS, formatMinor } from '../../src/lib/roi.ts';

const ok = (result) => {
  assert.equal(result.ok, true, `expected figures, got ${JSON.stringify(result)}`);
  return result;
};
const step = (result, key) => result.steps.find((s) => s.key === key);

// A placement with a recorded value, so a test that is not about assumptions
// does not silently depend on DEFAULT_ASSUMPTIONS.
const valued = (valueMinor, extra = {}) => ({ valueMinor, valueCurrency: 'EUR', ...extra });

test('the same input always produces the same output', () => {
  const input = {
    costs: [
      { category: 'PLATFORM', amountMinor: 120_000, currency: 'EUR' },
      { category: 'STAFF', amountMinor: 480_000, currency: 'EUR' },
    ],
    placements: [valued(1_500_000), { valueMinor: null }],
    mentorHours: 12,
    window: { startIso: '2026-01-01', endIso: '2026-06-30' },
  };
  const first = ok(computeRoi(input));
  const second = ok(computeRoi(input));
  assert.deepEqual(first, second, 'computeRoi must be a pure function of its argument');
  // No clock: a result computed "later" is byte-identical, which is the whole
  // reason this module takes its window as a string instead of reading Date.
  assert.deepEqual(first.window, { startIso: '2026-01-01', endIso: '2026-06-30' });
});

test('costs are additive and the total is the sum of the lines', () => {
  const result = ok(
    computeRoi({
      costs: [
        { amountMinor: 100_000, currency: 'EUR' },
        { amountMinor: 250_000, currency: 'EUR' },
        // A correction is a negative line, not a deleted row.
        { amountMinor: -50_000, currency: 'EUR' },
      ],
      placements: [],
    })
  );
  assert.equal(result.programCostMinor, 300_000);
  assert.equal(result.mentorTimeCostMinor, 0);
  assert.equal(result.totalCostMinor, 300_000);
  assert.equal(step(result, 'totalCost').valueMinor, 300_000);
});

test('unbilled mentor hours are priced onto the cost side, and are opt-in', () => {
  const base = { costs: [{ amountMinor: 100_000, currency: 'EUR' }], placements: [] };
  assert.equal(ok(computeRoi(base)).mentorTimeCostMinor, 0, 'no mentorHours means no imputed cost');

  const priced = ok(computeRoi({ ...base, mentorHours: 10 }));
  assert.equal(priced.mentorTimeCostMinor, 10 * DEFAULT_ASSUMPTIONS.mentorHourValueMinor);
  assert.equal(priced.totalCostMinor, 100_000 + 60_000);
});

test('a coaching relation is never a placement', () => {
  const result = ok(
    computeRoi({
      costs: [{ amountMinor: 600_000, currency: 'EUR' }],
      placements: [
        valued(1_000_000, { relationKind: 'PLACEMENT' }),
        valued(1_000_000, { relationKind: 'COACHING' }),
        // The column does not exist yet (#1503); an unset kind is a placement.
        valued(1_000_000),
      ],
    })
  );
  assert.equal(result.placementCount, 2, 'the coaching relation is excluded');
  assert.equal(result.recordedValueMinor, 2_000_000, 'and so is its value');
  // The denominator of cost-per-placement is the thing coaching would corrupt.
  assert.equal(result.costPerPlacementMinor, 300_000);
  assert.equal(step(result, 'placements').count, 2);
});

test('a recorded value is used; a missing one falls back to the documented assumptions', () => {
  const result = ok(
    computeRoi({
      costs: [{ amountMinor: 1_000_000, currency: 'EUR' }],
      placements: [valued(2_000_000), { valueMinor: null }, {}],
    })
  );
  const perPlacement =
    DEFAULT_ASSUMPTIONS.recruiterFeeAvoidedPerPlacementMinor +
    DEFAULT_ASSUMPTIONS.vacancyMonthsAvoidedPerPlacement * DEFAULT_ASSUMPTIONS.unfilledRoleCostPerMonthMinor;

  assert.equal(result.valuedPlacements, 1);
  assert.equal(result.assumedPlacements, 2, 'the count of assumed placements is reported, never hidden');
  assert.equal(result.recordedValueMinor, 2_000_000);
  assert.equal(result.assumedValueMinor, 2 * perPlacement);
  assert.equal(result.realisedValueMinor, 2_000_000 + 2 * perPlacement);
});

test('a success fee is reported but never added to realised value', () => {
  const result = ok(
    computeRoi({
      costs: [{ amountMinor: 100_000, currency: 'EUR' }],
      placements: [valued(1_000_000, { feeMinor: 89_000, feeCurrency: 'EUR' })],
    })
  );
  assert.equal(result.successFeeMinor, 89_000);
  assert.equal(result.realisedValueMinor, 1_000_000, 'the fee accrues to the other party — adding it double-counts');
  assert.equal(result.netMinor, 900_000);
});

test('net and the ROI percentage follow from the intermediates', () => {
  const result = ok(
    computeRoi({
      costs: [{ amountMinor: 1_000_000, currency: 'EUR' }],
      placements: [valued(2_500_000)],
    })
  );
  assert.equal(result.totalCostMinor, 1_000_000);
  assert.equal(result.netMinor, 1_500_000);
  assert.equal(result.roiPercent, 150);
  assert.equal(step(result, 'roiPercent').percent, 150);
  assert.equal(step(result, 'roiPercent').valueMinor, null, 'a percentage is not money');
});

test('a negative return is reported as a negative number, not clamped', () => {
  const result = ok(
    computeRoi({
      costs: [{ amountMinor: 5_000_000, currency: 'EUR' }],
      placements: [valued(1_000_000)],
    })
  );
  assert.equal(result.netMinor, -4_000_000);
  assert.equal(result.roiPercent, -80);
});

test('empty windows divide by nothing: no placements and no costs return null, not Infinity or NaN', () => {
  const empty = ok(computeRoi({ costs: [], placements: [] }));
  assert.equal(empty.totalCostMinor, 0);
  assert.equal(empty.placementCount, 0);
  assert.equal(empty.costPerPlacementMinor, null, '0 placements has no cost each');
  assert.equal(empty.roiPercent, null, '"infinite return" is not a number');
  assert.equal(empty.netMinor, 0);

  const noCost = ok(computeRoi({ costs: [], placements: [valued(1_000_000)] }));
  assert.equal(noCost.costPerPlacementMinor, 0);
  assert.equal(noCost.roiPercent, null);
});

test('every intermediate step is exposed, in order, for the show-your-working panel', () => {
  const result = ok(
    computeRoi({ costs: [{ amountMinor: 100_000, currency: 'EUR' }], placements: [valued(400_000)] })
  );
  assert.deepEqual(
    result.steps.map((s) => s.key),
    [
      'programCost',
      'mentorTimeCost',
      'totalCost',
      'placements',
      'recordedValue',
      'assumedValue',
      'realisedValue',
      'successFee',
      'costPerPlacement',
      'net',
      'roiPercent',
    ]
  );
  for (const s of result.steps) {
    assert.equal(typeof s.expression, 'string');
    assert.ok(s.expression.length > 0, `step ${s.key} must show its arithmetic`);
  }
});

test('a mixed-currency window refuses rather than guessing a rate', () => {
  const result = computeRoi({
    costs: [
      { amountMinor: 100_000, currency: 'EUR' },
      { amountMinor: 100_000, currency: 'TRY' },
    ],
    placements: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'mixed_currency');
  assert.deepEqual(result.currencies, ['EUR', 'TRY'], 'sorted, so the message is stable');
});

test('a placement value in another currency is mixed currency too', () => {
  const result = computeRoi({
    costs: [{ amountMinor: 100_000, currency: 'EUR' }],
    placements: [{ valueMinor: 1_000_000, valueCurrency: 'USD' }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.currencies, ['EUR', 'USD']);
});

test('a currency code on a row that carries no amount is noise, not a mixed window', () => {
  // A Placement row can hold `valueCurrency` with a null `valueMinor` — the
  // row contributes nothing, so it must not block the whole report.
  const result = ok(
    computeRoi({
      costs: [{ amountMinor: 100_000, currency: 'EUR' }],
      placements: [{ valueMinor: null, valueCurrency: 'USD', feeMinor: null, feeCurrency: 'GBP' }],
    })
  );
  assert.equal(result.currency, 'EUR');
});

test('currency codes are normalised before they are compared', () => {
  const result = ok(
    computeRoi({
      costs: [
        { amountMinor: 100_000, currency: 'eur' },
        { amountMinor: 100_000, currency: ' EUR ' },
      ],
      placements: [],
    })
  );
  assert.equal(result.currency, 'EUR', '"eur" and "EUR" are one currency, not two');
});

test('a malformed currency code is its own error, not a mixed-currency one', () => {
  const result = computeRoi({ costs: [{ amountMinor: 100_000, currency: '€' }], placements: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_currency');
  assert.deepEqual(result.currencies, ['€']);
});

test('a non-integer amount is refused instead of being rounded into the total', () => {
  const fractional = computeRoi({ costs: [{ amountMinor: 100_000.5, currency: 'EUR' }], placements: [] });
  assert.equal(fractional.ok, false);
  assert.equal(fractional.error, 'invalid_amount');
  assert.equal(fractional.field, 'costs[0].amountMinor', 'the message names the row');

  const badPlacement = computeRoi({ costs: [], placements: [{ valueMinor: 1.25 }] });
  assert.equal(badPlacement.ok, false);
  assert.equal(badPlacement.field, 'placements[0].valueMinor');

  const badHours = computeRoi({ costs: [], placements: [], mentorHours: -3 });
  assert.equal(badHours.ok, false);
  assert.equal(badHours.field, 'mentorHours');
});

test('an org may override any subset of the assumptions', () => {
  const result = ok(
    computeRoi({
      costs: [],
      placements: [{}],
      assumptions: { recruiterFeeAvoidedPerPlacementMinor: 0, vacancyMonthsAvoidedPerPlacement: 0 },
    })
  );
  assert.equal(result.assumedValueMinor, 0, 'an org that claims no avoided cost gets no assumed value');
  assert.equal(
    result.assumptions.mentorHourValueMinor,
    DEFAULT_ASSUMPTIONS.mentorHourValueMinor,
    'what is not overridden falls back to the documented default'
  );
});

test('a fractional assumption is rounded once, at the end, half away from zero', () => {
  // 2.5 months x 450000 = 1125000 exactly; 1.5 x 450001 = 675001.5 -> 675002.
  const result = ok(
    computeRoi({
      costs: [],
      placements: [{}],
      assumptions: {
        vacancyMonthsAvoidedPerPlacement: 1.5,
        unfilledRoleCostPerMonthMinor: 450_001,
        recruiterFeeAvoidedPerPlacementMinor: 0,
      },
    })
  );
  assert.equal(result.assumedValueMinor, 675_002);
  assert.ok(Number.isInteger(result.assumedValueMinor), 'money never leaves this module as a fraction');
});

test('roundMinor rounds half AWAY from zero, so a refund mirrors its charge', () => {
  assert.equal(roundMinor(2.5), 3);
  assert.equal(roundMinor(-2.5), -3, 'Math.round(-2.5) is -2, which would break the mirror');
  assert.equal(roundMinor(2.4), 2);
  assert.equal(roundMinor(-2.4), -2);
  assert.equal(roundMinor(0), 0);
});

test('formatMinor asks the currency how many decimals it has', () => {
  // The reason storage is "minor units" and not "cents": JPY has none, so 1500
  // minor units is ¥1,500 and not ¥15.00.
  assert.match(formatMinor(150_000, 'EUR', 'en-US'), /1,500\.00/);
  assert.match(formatMinor(1_500, 'JPY', 'en-US'), /1,500/);
  assert.doesNotMatch(formatMinor(1_500, 'JPY', 'en-US'), /15\.00/);
});
