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
  derivedPageWindow,
  isDerivedSort,
  parseCompanySort,
  rankByDerivedKey,
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

// ── Bounding the two derived orders (#2528) ─────────────────────────────────
//
// The route no longer ranks the whole scoped set: it ranks only the accounts
// that HAVE a key and lets the database page the keyless tail in name order.
// That is only correct if (a) the tail really is last and alphabetical — which
// is what `rankByDerivedKey` says about a mixed set — and (b) the page
// arithmetic stitching the two runs together neither drops nor repeats a row.

test('the one ranking: key first, name as the tie-breaker, keyless accounts last and alphabetical', () => {
  const keys = new Map([
    ['b', 10],
    ['a', 10],
    ['c', 50],
  ]);
  const companies = [
    { id: 'z', name: 'Zeta' },
    { id: 'b', name: 'Beta' },
    { id: 'y', name: 'Alpha' },
    { id: 'a', name: 'Acme' },
    { id: 'c', name: 'Gamma' },
  ];
  const ranked = rankByDerivedKey(companies, keys).map((c) => c.id);
  assert.deepEqual(ranked, ['c', 'a', 'b', 'y', 'z']);
  // A copy is sorted — the caller's array keeps its order.
  assert.deepEqual(companies.map((c) => c.id), ['z', 'b', 'y', 'a', 'c']);
});

test('the route\'s derived path (keys, ranked head, paged tail) returns the same pages as ranking everything', () => {
  // A funnel mixing every case: several records per account, a no-op-only
  // account, a record with no company, and accounts with no records at all.
  const relations = [
    moved('acme', 200, 120),
    moved('acme', 60, 3),
    moved('beta', 90, 40),
    moved('gamma', 30, 40),
    moved('delta', 10, 1),
    untouched('epsilon', 300),
    {
      companyId: 'noop',
      startDate: at(200),
      statusChanges: [{ createdAt: at(1), fromStatus: 'TRIAL_ACTIVE', toStatus: 'TRIAL_ACTIVE' }],
    },
    { companyId: null, startDate: at(10), statusChanges: [{ createdAt: at(1), fromStatus: 'A', toStatus: 'B' }] },
  ];
  const names = ['acme', 'beta', 'gamma', 'delta', 'epsilon', 'noop', 'omega', 'kappa', 'lambda', 'mu'];
  const companies = names.map((id) => ({ id, name: id.toUpperCase() }));

  for (const sort of ['movement', 'waiting']) {
    // The reference: what the handler did before #2528 — every company, every
    // record, every row of history, ranked in one go.
    const everything = rankByDerivedKey(companies, companySortKeys(relations, sort, NOW)).map((c) => c.id);

    // The bounded path: the query hands each relation only its newest REAL move
    // (a relation with none is not returned at all), so feed the keys exactly that.
    const newestRealMove = relations.flatMap((r) => {
      const real = r.statusChanges.filter((c) => c.fromStatus !== c.toStatus);
      if (real.length === 0) return [];
      const newest = real.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      return [{ companyId: r.companyId, startDate: r.startDate, statusChanges: [{ createdAt: newest.createdAt }] }];
    });
    const keys = companySortKeys(newestRealMove, sort, NOW);
    const head = rankByDerivedKey(companies.filter((c) => keys.has(c.id)), keys).map((c) => c.id);
    // The database's `name asc` over everything that has no key.
    const tail = companies
      .filter((c) => !keys.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => c.id);

    assert.deepEqual([...head, ...tail], everything, `${sort}: the stitched order is the full order`);

    for (const pageSize of [1, 2, 3, 4, 7, 10, 25]) {
      for (let skip = 0; skip <= companies.length + pageSize; skip += pageSize) {
        const w = derivedPageWindow(head.length, skip, pageSize);
        const page = [...head.slice(w.headStart, w.headEnd), ...tail.slice(w.tailSkip, w.tailSkip + w.tailTake)];
        assert.deepEqual(page, everything.slice(skip, skip + pageSize), `${sort} skip=${skip} take=${pageSize}`);
      }
    }
  }
});

test('the page window: head first, then the tail from its own start, with no row dropped or repeated', () => {
  // Entirely inside the ranked head: no tail query at all.
  assert.deepEqual(derivedPageWindow(100, 0, 24), { headStart: 0, headEnd: 24, tailSkip: 0, tailTake: 0 });
  // Straddling the boundary: the rest of the head, then the tail from zero.
  assert.deepEqual(derivedPageWindow(30, 24, 24), { headStart: 24, headEnd: 30, tailSkip: 0, tailTake: 18 });
  // Past the head: the tail offset is the page offset minus the head's length.
  assert.deepEqual(derivedPageWindow(30, 48, 24), { headStart: 30, headEnd: 30, tailSkip: 18, tailTake: 24 });
  // Nothing has moved: the page is the tail's page, exactly as asked.
  assert.deepEqual(derivedPageWindow(0, 48, 24), { headStart: 0, headEnd: 0, tailSkip: 48, tailTake: 24 });
});
