// Unit tests for the company/account list ordering (#2436).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Two rules are worth pinning down, because both fail SILENTLY — with a
// plausible-looking list rather than an error:
//
//  1. An unknown `sort` value falls back to the default. The acceptance
//     criterion is "not a 500", and a route that threw on a stale bookmark
//     would satisfy nobody.
//  2. An account with no stage movement sorts LAST, in both stage-derived
//     orders. MySQL puts NULLs first on an ascending sort, so "never moved"
//     would otherwise read as "moved longest ago" — the exact bug the inherited
//     task was written about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `companySort.ts` imports `./stageClock`, which in turn imports `./pipeline`
// and `./offers` — extensionless specifiers the app's bundler resolves and
// Node's ESM resolver does not. The hook has to be installed before the module
// loads, hence the dynamic import (a static one would be hoisted above it).
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  COMPANY_SORT_KEYS,
  DEFAULT_COMPANY_SORT,
  companySortKeys,
  compareSortKeys,
  isDerivedSort,
  parseCompanySort,
} = await import('../../src/lib/companySort.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T00:00:00Z').getTime();
const at = (daysAgo) => new Date(NOW - daysAgo * DAY);

/** A funnel record that moved stage `daysAgo` days ago. */
const moved = (companyId, startedDaysAgo, movedDaysAgo) => ({
  companyId,
  startDate: at(startedDaysAgo),
  statusChanges: [
    { createdAt: at(movedDaysAgo), fromStatus: 'LEAD_QUALIFIED', toStatus: 'TRIAL_ACTIVE' },
  ],
});

/** A funnel record that has never moved. */
const untouched = (companyId, startedDaysAgo) => ({
  companyId,
  startDate: at(startedDaysAgo),
  statusChanges: [],
});

test('an unknown, empty or missing sort falls back to the default instead of failing', () => {
  assert.equal(parseCompanySort('nonsense'), DEFAULT_COMPANY_SORT);
  assert.equal(parseCompanySort(''), DEFAULT_COMPANY_SORT);
  assert.equal(parseCompanySort(null), DEFAULT_COMPANY_SORT);
  assert.equal(parseCompanySort(undefined), DEFAULT_COMPANY_SORT);
  // …and every advertised option is honoured.
  for (const key of COMPANY_SORT_KEYS) assert.equal(parseCompanySort(key), key);
});

test('only the two stage-derived orders are ranked in the server, the scalars go to Prisma', () => {
  assert.equal(isDerivedSort('name'), false);
  assert.equal(isDerivedSort('created'), false);
  assert.equal(isDerivedSort('movement'), true);
  assert.equal(isDerivedSort('waiting'), true);
  // A non-derived sort produces no keys at all, so the route never pays for the
  // relation query on the common path.
  assert.equal(companySortKeys([moved('a', 30, 2)], 'name', NOW).size, 0);
});

test('a company with no stage movement has no key, and a keyless company sorts last', () => {
  const keys = companySortKeys([untouched('quiet', 300), moved('busy', 30, 2)], 'movement', NOW);
  assert.equal(keys.has('quiet'), false);
  assert.equal(keys.has('busy'), true);

  // Both directions, and both derived orders: "absent" always loses.
  assert.ok(compareSortKeys(undefined, 5) > 0);
  assert.ok(compareSortKeys(5, undefined) < 0);
  assert.equal(compareSortKeys(undefined, undefined), 0);
});

test('a company that started long ago but never moved does not win "longest in stage"', () => {
  // The trap: `daysInStage` falls back to startDate, so the untouched account
  // would score 300 days and top the list — ahead of the account that really
  // has been stuck in a stage for 40 days.
  const keys = companySortKeys([untouched('quiet', 300), moved('stuck', 90, 40)], 'waiting', NOW);
  assert.equal(keys.get('stuck'), 40);
  assert.equal(keys.has('quiet'), false);

  const order = ['quiet', 'stuck'].sort((a, b) => compareSortKeys(keys.get(a), keys.get(b)));
  assert.deepEqual(order, ['stuck', 'quiet']);
});

test('an account takes the STRONGEST of its records, not the quietest', () => {
  // Five sleepy deals must not drag an account with one live deal to the bottom.
  const relations = [moved('acme', 200, 120), moved('acme', 60, 3), moved('other', 90, 40)];

  const movement = companySortKeys(relations, 'movement', NOW);
  assert.equal(movement.get('acme'), at(3).getTime());

  const waiting = companySortKeys(relations, 'waiting', NOW);
  assert.equal(waiting.get('acme'), 120);
});

test('a no-op StatusChange row is not a movement', () => {
  // Rows whose fromStatus equals their toStatus record nothing happening
  // (#2264). Counting one as a move would make an account that has never
  // progressed look freshly active — and pull it off the end of the list.
  const keys = companySortKeys(
    [
      {
        companyId: 'noop',
        startDate: at(200),
        statusChanges: [
          { createdAt: at(1), fromStatus: 'TRIAL_ACTIVE', toStatus: 'TRIAL_ACTIVE' },
        ],
      },
    ],
    'movement',
    NOW
  );
  assert.equal(keys.has('noop'), false);
});

test('a funnel record with no company is ignored rather than keyed under "null"', () => {
  const keys = companySortKeys(
    [{ companyId: null, startDate: at(10), statusChanges: [{ createdAt: at(1), fromStatus: 'A', toStatus: 'B' }] }],
    'movement',
    NOW
  );
  assert.equal(keys.size, 0);
});
