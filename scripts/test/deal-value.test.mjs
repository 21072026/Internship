// Unit tests for the estimated won-deal value series (#2422) — src/lib/dealValue.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Every property the issue's acceptance criteria name is a property of the
// arithmetic, not of a page, so this is where they are proven:
//   • money is integer minor units — a float is refused, not rounded;
//   • a window holding two currencies returns the typed error, never a guess;
//   • past months are rebuilt from the recorded moves only: a move recorded
//     later cannot restate an earlier month, and today's stage is not an input;
//   • a transfer chain is ONE journey — one win, one book entry, one value;
//   • "won" and "churned" agree with the retention triangle on the same screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  valueByMonth,
  foldChains,
  winAndLoss,
  validateDealValue,
  parseDealValueInput,
  dealValueInputText,
  isDealValueEnabled,
  DEAL_VALUE_MAX_MINOR,
} = await import('../../src/lib/dealValue.ts');
const { retentionTriangle, cohortMonths } = await import('../../src/lib/funnelKpi.ts');
const { formatMinorAmount, parseMinorUnits } = await import('../../src/lib/money.ts');

// A marketing tenant's own order, written out so a preset change cannot
// silently rewrite what these assertions mean.
const ORDER = ['LEAD_NEW', 'LEAD_QUALIFIED', 'TRIAL_ACTIVE', 'DEAL_WON'];
const OPTS = { wonKeys: ['DEAL_WON'], offPath: ['DEAL_LOST'] };
const at = (iso) => Date.parse(iso);
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04'];

function journey(id, changes, extra = {}) {
  return {
    id,
    previousRelationId: null,
    startStatus: 'LEAD_NEW',
    startedAt: at('2025-12-01T00:00:00Z'),
    changes: changes.map(([toStatus, iso]) => ({ toStatus, at: at(iso) })),
    valueMinor: 4990,
    currency: 'EUR',
    ...extra,
  };
}

const month = (result, m) => result.months.find((row) => row.month === m);

test('won, lost and the month-end book, each with its estimated value', () => {
  const result = valueByMonth(
    ORDER,
    [
      journey('a', [['DEAL_WON', '2026-01-10T00:00:00Z'], ['DEAL_LOST', '2026-03-05T00:00:00Z']], { valueMinor: 10000 }),
      journey('b', [['DEAL_WON', '2026-02-28T23:59:59Z']], { valueMinor: 2500 }),
      journey('c', [['LEAD_QUALIFIED', '2026-01-02T00:00:00Z']]), // never won
    ],
    MONTHS,
    OPTS,
  );
  assert.equal(result.ok, true);
  assert.equal(result.currency, 'EUR');
  assert.deepEqual(month(result, '2026-01').won, { count: 1, valueMinor: 10000, unvalued: 0 });
  assert.deepEqual(month(result, '2026-01').activeAtEnd, { count: 1, valueMinor: 10000, unvalued: 0 });
  assert.deepEqual(month(result, '2026-02').won, { count: 1, valueMinor: 2500, unvalued: 0 });
  assert.deepEqual(month(result, '2026-02').activeAtEnd, { count: 2, valueMinor: 12500, unvalued: 0 });
  assert.deepEqual(month(result, '2026-03').lost, { count: 1, valueMinor: 10000, unvalued: 0 });
  assert.deepEqual(month(result, '2026-03').activeAtEnd, { count: 1, valueMinor: 2500, unvalued: 0 });
  assert.deepEqual(month(result, '2026-04').activeAtEnd, { count: 1, valueMinor: 2500, unvalued: 0 });
  // Integer arithmetic end to end.
  for (const row of result.months) {
    for (const t of [row.won, row.lost, row.activeAtEnd]) assert.ok(Number.isSafeInteger(t.valueMinor));
  }
});

test('month boundaries are UTC and half-open: 00:00 on the 1st belongs to the new month', () => {
  const result = valueByMonth(ORDER, [journey('a', [['DEAL_WON', '2026-02-01T00:00:00Z']])], MONTHS, OPTS);
  assert.equal(month(result, '2026-01').won.count, 0);
  assert.equal(month(result, '2026-01').activeAtEnd.count, 0);
  assert.equal(month(result, '2026-02').won.count, 1);
});

test('a deal won before the window is still in the book, and one that started won is won at its start', () => {
  const result = valueByMonth(
    ORDER,
    [
      journey('old', [['DEAL_WON', '2025-06-01T00:00:00Z']]),
      journey('imported', [], { startStatus: 'DEAL_WON', startedAt: at('2026-03-15T00:00:00Z') }),
    ],
    MONTHS,
    OPTS,
  );
  assert.equal(month(result, '2026-01').won.count, 0);
  assert.equal(month(result, '2026-01').activeAtEnd.count, 1);
  assert.equal(month(result, '2026-03').won.count, 1);
  assert.equal(month(result, '2026-04').activeAtEnd.count, 2);
});

test('a record without an estimate is counted, adds nothing, and is reported as unvalued', () => {
  const result = valueByMonth(
    ORDER,
    [journey('a', [['DEAL_WON', '2026-01-10T00:00:00Z']], { valueMinor: null, currency: null })],
    MONTHS,
    OPTS,
  );
  assert.deepEqual(month(result, '2026-01').won, { count: 1, valueMinor: 0, unvalued: 1 });
});

test('mixed currencies in the window return the typed error — never a converted total', () => {
  const result = valueByMonth(
    ORDER,
    [
      journey('a', [['DEAL_WON', '2026-01-10T00:00:00Z']], { currency: 'EUR' }),
      journey('b', [['DEAL_WON', '2026-02-10T00:00:00Z']], { currency: 'chf' }),
    ],
    MONTHS,
    OPTS,
  );
  assert.deepEqual(result, { ok: false, error: 'mixed_currency', currencies: ['CHF', 'EUR'] });
});

test('a valued deal that reaches none of the months does not trip the currency rule', () => {
  const result = valueByMonth(
    ORDER,
    [
      journey('a', [['DEAL_WON', '2026-01-10T00:00:00Z']], { currency: 'EUR' }),
      // Won and lost before the window opened: not in any month's numbers.
      journey('b', [['DEAL_WON', '2025-03-10T00:00:00Z'], ['DEAL_LOST', '2025-05-01T00:00:00Z']], { currency: 'USD' }),
      // Never won: not in any month's numbers either.
      journey('c', [], { currency: 'GBP' }),
    ],
    MONTHS,
    OPTS,
  );
  assert.equal(result.ok, true);
  assert.equal(result.currency, 'EUR');
});

test('a float or a malformed currency is refused, not rounded or guessed', () => {
  assert.deepEqual(
    valueByMonth(ORDER, [journey('a', [['DEAL_WON', '2026-01-10T00:00:00Z']], { valueMinor: 49.9 })], MONTHS, OPTS),
    { ok: false, error: 'invalid_amount', field: 'journeys[0].valueMinor' },
  );
  assert.deepEqual(
    valueByMonth(ORDER, [journey('a', [['DEAL_WON', '2026-01-10T00:00:00Z']], { currency: 'EURO' })], MONTHS, OPTS),
    { ok: false, error: 'invalid_currency', currencies: ['EURO'] },
  );
});

test('past months are rebuilt from the moves recorded before they closed — a later move never restates them', () => {
  const before = valueByMonth(ORDER, [journey('a', [['DEAL_WON', '2026-01-10T00:00:00Z']])], MONTHS, OPTS);
  // The same record, lost in April: January–March must read exactly as before.
  const after = valueByMonth(
    ORDER,
    [journey('a', [['DEAL_WON', '2026-01-10T00:00:00Z'], ['DEAL_LOST', '2026-04-20T00:00:00Z']])],
    MONTHS,
    OPTS,
  );
  for (const m of ['2026-01', '2026-02', '2026-03']) assert.deepEqual(month(after, m), month(before, m));
  assert.equal(month(after, '2026-04').lost.count, 1);
  assert.equal(month(after, '2026-04').activeAtEnd.count, 0);
});

test('a transfer chain is one journey: one win, one book entry, the newest estimate', () => {
  // Won in January under the first owner; transferred in February. The
  // successor starts ON the won stage with no StatusChange of its own (a
  // transfer carries the stage over, it does not move it).
  const root = journey('r1', [['DEAL_WON', '2026-01-10T00:00:00Z']], { valueMinor: 4990 });
  const successor = journey('r2', [], {
    previousRelationId: 'r1',
    startStatus: 'DEAL_WON',
    startedAt: at('2026-02-15T00:00:00Z'),
    valueMinor: 5990, // re-estimated after the handover
  });

  const unfolded = valueByMonth(ORDER, [root, successor], MONTHS, { ...OPTS, foldTransferChains: false });
  // The bug the fold exists for — a second "win" in February and a double book:
  assert.equal(month(unfolded, '2026-02').won.count, 1);
  assert.equal(month(unfolded, '2026-02').activeAtEnd.count, 2);

  const result = valueByMonth(ORDER, [successor, root], MONTHS, OPTS);
  assert.equal(month(result, '2026-01').won.count, 1);
  assert.equal(month(result, '2026-02').won.count, 0);
  for (const m of ['2026-02', '2026-03', '2026-04']) {
    assert.deepEqual(month(result, m).activeAtEnd, { count: 1, valueMinor: 5990, unvalued: 0 });
  }
});

test('a chain is valued by its tip: clearing the successor\'s estimate is not undone by the predecessor\'s copy', () => {
  // A transfer COPIES the estimate and leaves the predecessor's row in place.
  // The owner then clears the live record's estimate.
  const root = journey('r1', [['DEAL_WON', '2026-01-10T00:00:00Z']], { valueMinor: 4990 });
  const successor = journey('r2', [], {
    previousRelationId: 'r1',
    startStatus: 'DEAL_WON',
    startedAt: at('2026-02-15T00:00:00Z'),
    valueMinor: null,
    currency: null,
  });
  const result = valueByMonth(ORDER, [root, successor], MONTHS, OPTS);
  for (const m of MONTHS) {
    assert.deepEqual(month(result, m).activeAtEnd, { count: 1, valueMinor: 0, unvalued: 1 }, m);
  }
  // A fork (two successors of one link — no writer does it, but the fold must
  // still pick ONE tip): the latest start wins, whatever the input order.
  const forkA = journey('f1', [], { previousRelationId: 'r1', startedAt: at('2026-03-01T00:00:00Z'), valueMinor: 111 });
  const forkB = journey('f2', [], { previousRelationId: 'r1', startedAt: at('2026-02-01T00:00:00Z'), valueMinor: 222 });
  assert.equal(foldChains([forkA, root, forkB])[0].valueMinor, 111);
  assert.equal(foldChains([forkB, root, forkA])[0].valueMinor, 111);
});

test('amounts use each record\'s CURRENT estimate: re-estimating restates past months (counts do not move)', () => {
  // Deliberate (see the dealValue.ts header, rule 2, and the card hint): the
  // estimate is not historised, so the same moves with a new estimate give the
  // same counts and new amounts for months already shown.
  const moves = [['DEAL_WON', '2026-01-10T00:00:00Z']];
  const before = valueByMonth(ORDER, [journey('a', moves, { valueMinor: 4990 })], MONTHS, OPTS);
  const after = valueByMonth(ORDER, [journey('a', moves, { valueMinor: 9990 })], MONTHS, OPTS);
  assert.equal(month(before, '2026-01').won.count, month(after, '2026-01').won.count);
  assert.equal(month(before, '2026-01').won.valueMinor, 4990);
  assert.equal(month(after, '2026-01').won.valueMinor, 9990);
});

test('a loss on the successor churns the chain once, in the month it happened', () => {
  const root = journey('r1', [['DEAL_WON', '2026-01-10T00:00:00Z']]);
  const successor = journey('r2', [['DEAL_LOST', '2026-03-02T00:00:00Z']], {
    previousRelationId: 'r1',
    startStatus: 'DEAL_WON',
    startedAt: at('2026-02-15T00:00:00Z'),
  });
  const result = valueByMonth(ORDER, [root, successor], MONTHS, OPTS);
  assert.equal(month(result, '2026-03').lost.count, 1);
  assert.equal(month(result, '2026-03').activeAtEnd.count, 0);
  assert.equal(month(result, '2026-04').activeAtEnd.count, 0);
});

test('foldChains: every link lands in exactly one journey, cycles and missing roots included', () => {
  const folded = foldChains([
    journey('a', [], { previousRelationId: 'missing' }),
    journey('b', [], { previousRelationId: 'a' }),
    journey('x', [], { previousRelationId: 'y' }),
    journey('y', [], { previousRelationId: 'x' }), // a cycle no writer produces
    journey('solo', []),
  ]);
  assert.deepEqual(folded.map((j) => j.id).sort(), ['a', 'solo', 'x']);
});

test('"won in month M" is the retention triangle\'s cohort of month M — the two cards agree', () => {
  const journeys = [
    journey('a', [['LEAD_QUALIFIED', '2026-01-02T00:00:00Z'], ['DEAL_WON', '2026-01-20T00:00:00Z'], ['DEAL_LOST', '2026-02-11T00:00:00Z']]),
    journey('b', [['DEAL_WON', '2026-02-03T00:00:00Z'], ['LEAD_QUALIFIED', '2026-02-04T00:00:00Z'], ['DEAL_WON', '2026-03-01T00:00:00Z']]),
    journey('c', [], { startStatus: 'DEAL_WON', startedAt: at('2026-03-09T00:00:00Z') }),
    journey('d', [['DEAL_LOST', '2026-01-05T00:00:00Z']]), // lost before ever winning: not churn
    journey('e', [['DEAL_WON', '2026-04-30T12:00:00Z'], ['DEAL_LOST', '2026-04-30T12:00:00Z']]),
  ];
  const months = cohortMonths(new Date('2026-01-01T00:00:00Z'), new Date('2026-04-30T00:00:00Z'));
  const triangle = retentionTriangle(ORDER, journeys, months, [1], { ...OPTS, now: new Date('2030-01-01T00:00:00Z') });
  const series = valueByMonth(ORDER, journeys, months, OPTS);
  for (const cohort of triangle) assert.equal(month(series, cohort.month).won.count, cohort.won, cohort.month);
  // Same churn rule: the first loss after the win, per journey.
  for (const j of journeys) {
    const { wonAt, lostAt } = winAndLoss(ORDER, j, OPTS);
    if (j.id === 'd') assert.deepEqual({ wonAt, lostAt }, { wonAt: null, lostAt: null });
    if (j.id === 'e') assert.equal(lostAt, at('2026-04-30T12:00:00Z'));
  }
  // …and the fallbacks: no keys given → last stage wins, anything off `order` loses.
  assert.deepEqual(winAndLoss(ORDER, journeys[0]), { wonAt: at('2026-01-20T00:00:00Z'), lostAt: at('2026-02-11T00:00:00Z') });
});

test('input: integer minor units only, bounded, in an allowed currency', () => {
  assert.deepEqual(validateDealValue(4990, 'eur'), { ok: true, valueMinor: 4990, currency: 'EUR' });
  assert.deepEqual(validateDealValue(4990, undefined), { ok: true, valueMinor: 4990, currency: 'EUR' });
  assert.deepEqual(validateDealValue(49.9, 'EUR'), { ok: false, error: 'invalid_amount' });
  assert.deepEqual(validateDealValue('4990', 'EUR'), { ok: false, error: 'invalid_amount' });
  assert.deepEqual(validateDealValue(-1, 'EUR'), { ok: false, error: 'negative' });
  assert.deepEqual(validateDealValue(DEAL_VALUE_MAX_MINOR + 1, 'EUR'), { ok: false, error: 'too_large' });
  assert.deepEqual(validateDealValue(100, 'JPY'), { ok: false, error: 'invalid_currency' });
});

test('input text: the importer\'s parser, and back again', () => {
  assert.deepEqual(parseDealValueInput('49,90'), { ok: true, valueMinor: 4990 });
  assert.deepEqual(parseDealValueInput('1.234,50'), { ok: true, valueMinor: 123450 });
  assert.deepEqual(parseDealValueInput('990'), { ok: true, valueMinor: 99000 });
  assert.deepEqual(parseDealValueInput('  '), { ok: true, valueMinor: null });
  assert.deepEqual(parseDealValueInput('n/a'), { ok: false, error: 'invalid_amount' });
  assert.deepEqual(parseDealValueInput('-5'), { ok: false, error: 'negative' });
  // One separator + exactly three digits is ambiguous for a person typing
  // (a thousands group, or a slipped cent digit?) — the editor asks.
  assert.deepEqual(parseDealValueInput('49,999'), { ok: false, error: 'ambiguous_amount' });
  assert.deepEqual(parseDealValueInput('49.905'), { ok: false, error: 'ambiguous_amount' });
  assert.deepEqual(parseDealValueInput('1.234'), { ok: false, error: 'ambiguous_amount' });
  assert.deepEqual(parseDealValueInput('1234'), { ok: true, valueMinor: 123400 });
  assert.deepEqual(parseDealValueInput('1.234,00'), { ok: true, valueMinor: 123400 });
  assert.deepEqual(parseDealValueInput('49,99'), { ok: true, valueMinor: 4999 });
  // The importer's reading is unchanged — this is the editor's rule only.
  assert.equal(parseMinorUnits('1.234'), 123400);
  assert.equal(parseMinorUnits('49,90'), 4990); // the same function the import reads `mrr` with
  assert.equal(dealValueInputText(4990), '49.90');
  assert.equal(dealValueInputText(5), '0.05');
  assert.equal(dealValueInputText(null), '');
  assert.deepEqual(parseDealValueInput(dealValueInputText(123456)), { ok: true, valueMinor: 123456 });
});

test('formatting goes through money.ts: EUR as on the pricing page, others with their code', () => {
  assert.equal(formatMinorAmount(123450, 'EUR', 'de'), '1.234,50\u00a0€');
  assert.equal(formatMinorAmount(123450, 'EUR', 'en'), '€1,234.50');
  assert.equal(formatMinorAmount(4990, 'CHF', 'de'), '49,90\u00a0CHF');
  assert.equal(formatMinorAmount(4990, 'chf', 'en'), 'CHF\u00a049.90');
});

test('deal values exist where the sales surface does: pipeline without mentorship', () => {
  assert.equal(isDealValueEnabled(['companies', 'pipeline', 'messaging', 'documents']), true);
  assert.equal(isDealValueEnabled(['pipeline', 'mentorship']), false);
  assert.equal(isDealValueEnabled([]), false);
});
