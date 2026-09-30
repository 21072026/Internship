// Unit tests for the two cohort metrics in src/lib/funnelKpi.ts (#2420, #2425).
//
// Run: npm run test:funnel-cohorts  (node --test --experimental-strip-types)
//
// The two wrong numbers these pin down, both of which look plausible on screen:
//
//   1. A conversion rate above 100%. It happens the moment a month's numerator
//      and denominator describe different people: a deal signed in March that
//      arrived in January is one conversion in March and zero new entries, and
//      in any month where late conversions outnumber fresh arrivals the rate
//      goes over 100. Cohorting by the month of ENTRY is the fix, and the
//      structural guarantee is asserted below rather than assumed.
//   2. A young cohort printing 0% churn. A cohort won last week has had no
//      opportunity to leave; "0% churned" reads as perfect retention where
//      there is simply no evidence yet. Immature buckets must be null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// funnelKpi imports `./meteringRules` for the month boundary; the resolve hook
// is what lets an extensionless relative import work under node --test.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  conversionByEntryMonth,
  retentionTriangle,
  cohortMonths,
  stageConversions,
  relationChains,
  mergeChainJourney,
  trialConversion,
  trialStartOf,
} = await import('../../src/lib/funnelKpi.ts');

// A marketing tenant's own stage order (src/lib/programTemplates.ts), on-path
// only — exactly what `onPathKeys()` hands the functions. Written out here
// rather than imported so a change to the preset cannot silently rewrite what
// these assertions mean.
const ORDER = [
  'LEAD_NEW',
  'LEAD_CONTACTED',
  'LEAD_QUALIFIED',
  'TRIAL_ACTIVE',
  'TRIAL_EXPIRED',
  'DEAL_PROPOSAL',
  'DEAL_NEGOTIATION',
  'DEAL_WON',
];
const OFF_PATH = ['DEAL_LOST'];

const ms = (iso) => new Date(iso).getTime();
const journey = (startStatus, startedAt, changes = []) => ({
  startStatus,
  startedAt: ms(startedAt),
  changes: changes.map(([toStatus, at]) => ({ toStatus, at: ms(at) })),
});

// ── #2420 · conversion by entry month ────────────────────────────────────────

test('a late conversion is credited to the month the record entered, so no month exceeds 100%', () => {
  const months = ['2026-01', '2026-02'];
  // Three January leads that all sign in February, and one February lead that
  // has not signed. Counting conversions in the month they HAPPEN gives
  // February 3/1 = 300%.
  const journeys = [
    journey('LEAD_NEW', '2026-01-03', [['LEAD_QUALIFIED', '2026-01-06'], ['DEAL_WON', '2026-02-11']]),
    journey('LEAD_NEW', '2026-01-04', [['LEAD_QUALIFIED', '2026-01-09'], ['DEAL_WON', '2026-02-12']]),
    journey('LEAD_NEW', '2026-01-05', [['LEAD_QUALIFIED', '2026-01-20'], ['DEAL_WON', '2026-02-18']]),
    journey('LEAD_NEW', '2026-02-02', [['LEAD_QUALIFIED', '2026-02-05']]),
  ];

  const rows = conversionByEntryMonth(ORDER, journeys, 'LEAD_QUALIFIED', 'DEAL_WON', months);
  assert.deepEqual(rows[0], { month: '2026-01', entered: 3, converted: 3, rate: 100 });
  assert.deepEqual(rows[1], { month: '2026-02', entered: 1, converted: 0, rate: 0 });
  for (const r of rows) {
    assert.ok(r.converted <= r.entered, `${r.month}: numerator must not exceed denominator`);
    assert.ok(r.rate === null || r.rate <= 100, `${r.month}: rate must not exceed 100%`);
  }
});

test('a month with nobody in it has no rate — null, not 0%', () => {
  const rows = conversionByEntryMonth(
    ORDER,
    [journey('LEAD_NEW', '2026-01-03', [['LEAD_QUALIFIED', '2026-01-06']])],
    'LEAD_QUALIFIED',
    'DEAL_WON',
    ['2026-01', '2026-02', '2026-03'],
  );
  assert.equal(rows[0].rate, 0, 'January had one entry and no conversion: a real 0%');
  assert.equal(rows[1].rate, null, 'February had nobody — 0% would claim everyone dropped');
  assert.equal(rows[1].entered, 0);
  assert.equal(rows[2].rate, null);
});

test('the cohort denominators add up to the same "entered" the stage-to-stage card shows', () => {
  // Deliberately awkward journeys: one skips the qualification stage entirely,
  // one was imported already past it, one never gets near it.
  const journeys = [
    journey('LEAD_NEW', '2026-01-03', [['LEAD_QUALIFIED', '2026-01-06'], ['DEAL_WON', '2026-03-01']]),
    journey('LEAD_NEW', '2026-02-01', [['DEAL_PROPOSAL', '2026-02-10']]), // skipped the stage
    journey('DEAL_NEGOTIATION', '2026-03-04', []), // imported past it
    journey('LEAD_NEW', '2026-01-30', [['LEAD_CONTACTED', '2026-02-02']]), // never reached it
  ];
  const months = ['2026-01', '2026-02', '2026-03'];
  const rows = conversionByEntryMonth(ORDER, journeys, 'LEAD_QUALIFIED', 'DEAL_WON', months);

  const total = rows.reduce((s, r) => s + r.entered, 0);
  const qualified = stageConversions(ORDER, journeys).find((c) => c.key === 'LEAD_QUALIFIED');
  assert.equal(
    total,
    qualified.entered,
    'two cards on one screen must not disagree about how many records reached a stage',
  );
  assert.equal(total, 3);
  // The skipper is credited to the month it crossed the line, the import to
  // the month it appeared.
  assert.equal(rows[1].entered, 1, 'February: the journey that skipped the stage');
  assert.equal(rows[2].entered, 1, 'March: the record that was already past it');
});

test('an entry month outside the reported window is dropped, not folded into the nearest bucket', () => {
  const rows = conversionByEntryMonth(
    ORDER,
    [
      journey('LEAD_NEW', '2025-11-01', [['LEAD_QUALIFIED', '2025-11-05'], ['DEAL_WON', '2026-02-01']]),
      journey('LEAD_NEW', '2026-02-01', [['LEAD_QUALIFIED', '2026-02-05']]),
    ],
    'LEAD_QUALIFIED',
    'DEAL_WON',
    ['2026-01', '2026-02'],
  );
  assert.equal(rows[0].entered, 0, 'November belongs to no reported month');
  assert.deepEqual(rows[1], { month: '2026-02', entered: 1, converted: 0, rate: 0 });
});

test('a key this tenant does not have, or a backwards pair, yields null rates rather than zeros', () => {
  const months = ['2026-01'];
  const journeys = [journey('LEAD_NEW', '2026-01-03', [['DEAL_WON', '2026-01-09']])];
  for (const [from, to] of [
    ['CUSTOMER_ACTIVE_700', 'DEAL_WON'], // a key from another product's funnel
    ['DEAL_WON', 'LEAD_QUALIFIED'], // backwards
    ['DEAL_WON', 'DEAL_WON'], // degenerate
  ]) {
    const rows = conversionByEntryMonth(ORDER, journeys, from, to, months);
    assert.deepEqual(rows, [{ month: '2026-01', entered: 0, converted: 0, rate: null }], `${from} -> ${to}`);
  }
});

// ── #2425 · retention triangle ───────────────────────────────────────────────

const RETENTION = (journeys, months, buckets, options) =>
  retentionTriangle(ORDER, journeys, months, buckets, { offPath: OFF_PATH, ...options });

test('a bucket whose window has not closed yet is null, never 0%', () => {
  const journeys = [journey('LEAD_NEW', '2026-01-02', [['DEAL_WON', '2026-01-20']])];
  // The January cohort closes on 2026-02-01; its 1-month window closes on
  // 2026-03-01 and its 3-month window on 2026-05-01.
  const rows = RETENTION(journeys, ['2026-01'], [1, 3], { now: new Date('2026-03-15T00:00:00Z') });
  assert.equal(rows[0].won, 1);
  assert.equal(rows[0].buckets[0].rate, 0, '1-month window has closed and nobody left: a real 0%');
  assert.equal(rows[0].buckets[1].churned, null, '3-month window is still open');
  assert.equal(rows[0].buckets[1].rate, null, 'a young cohort must not advertise perfect retention');
});

test('churn lands in the first window that has closed around it', () => {
  const journeys = [
    journey('LEAD_NEW', '2026-01-02', [['DEAL_WON', '2026-01-20'], ['DEAL_LOST', '2026-02-10']]),
    journey('LEAD_NEW', '2026-01-03', [['DEAL_WON', '2026-01-25'], ['DEAL_LOST', '2026-04-05']]),
  ];
  const rows = RETENTION(journeys, ['2026-01'], [1, 3], { now: new Date('2026-06-01T00:00:00Z') });
  assert.deepEqual(rows[0].buckets[0], { months: 1, churned: 1, rate: 50 }, 'window ends 2026-03-01');
  assert.deepEqual(rows[0].buckets[1], { months: 3, churned: 2, rate: 100 }, 'window ends 2026-05-01');
});

test('a loss BEFORE the win is not churn — the same stage means two things either side of the deal', () => {
  const journeys = [
    // Lost, re-opened, then won: the deal was saved, the customer never left.
    journey('LEAD_NEW', '2026-01-02', [
      ['DEAL_LOST', '2026-01-05'],
      ['DEAL_PROPOSAL', '2026-01-12'],
      ['DEAL_WON', '2026-01-20'],
    ]),
  ];
  const rows = RETENTION(journeys, ['2026-01'], [1], { now: new Date('2026-06-01T00:00:00Z') });
  assert.equal(rows[0].won, 1);
  assert.deepEqual(rows[0].buckets[0], { months: 1, churned: 0, rate: 0 });
});

test('only the first departure counts, and a deal that never won is in no cohort', () => {
  const journeys = [
    journey('LEAD_NEW', '2026-01-02', [
      ['DEAL_WON', '2026-01-10'],
      ['DEAL_LOST', '2026-01-20'],
      ['DEAL_PROPOSAL', '2026-02-01'],
      ['DEAL_LOST', '2026-02-15'],
    ]),
    journey('LEAD_NEW', '2026-01-03', [['DEAL_LOST', '2026-01-09']]), // lost before ever winning
  ];
  const rows = RETENTION(journeys, ['2026-01'], [1], { now: new Date('2026-06-01T00:00:00Z') });
  assert.equal(rows[0].won, 1, 'a deal that never won is not a customer we kept or lost');
  assert.deepEqual(rows[0].buckets[0], { months: 1, churned: 1, rate: 100 }, 'one departure, not two');
});

test('an empty cohort reports no rate even once its window has closed', () => {
  const rows = RETENTION([], ['2026-01'], [1], { now: new Date('2026-06-01T00:00:00Z') });
  assert.deepEqual(rows, [{ month: '2026-01', won: 0, buckets: [{ months: 1, churned: 0, rate: null }] }]);
});

test('a record imported already won belongs to the month it appeared', () => {
  const journeys = [journey('DEAL_WON', '2026-02-03', [['DEAL_LOST', '2026-02-20']])];
  const rows = RETENTION(journeys, ['2026-01', '2026-02'], [1], { now: new Date('2026-06-01T00:00:00Z') });
  assert.equal(rows[0].won, 0);
  assert.equal(rows[1].won, 1);
  assert.equal(rows[1].buckets[0].churned, 1);
});

test('wonKeys is the tenant resolved outcome set, not just the last stage (#1882)', () => {
  const ORDER_INTERNSHIP = ['APPLICATION_100', 'HIREABLE_600', 'HIRED_660', 'EMPLOYED_700'];
  const journeys = [
    journey('APPLICATION_100', '2026-01-02', [
      ['HIRED_660', '2026-01-20'],
      ['INTERNSHIP_DROPPED_460', '2026-02-10'],
    ]),
  ];
  const now = new Date('2026-06-01T00:00:00Z');
  const offPath = ['INTERNSHIP_DROPPED_460', 'INTERNSHIP_FOUND_ELSEWHERE_800'];

  const bare = retentionTriangle(ORDER_INTERNSHIP, journeys, ['2026-01'], [1], { now, offPath });
  assert.equal(bare[0].won, 0, 'the last key alone is EMPLOYED_700, which most records never reach');

  const resolved = retentionTriangle(ORDER_INTERNSHIP, journeys, ['2026-01'], [1], {
    now,
    offPath,
    wonKeys: ['HIRED_660', 'EMPLOYED_700'],
  });
  assert.equal(resolved[0].won, 1);
  assert.deepEqual(resolved[0].buckets[0], { months: 1, churned: 1, rate: 100 });
});

test('a stage merely REMOVED from the order is not read as a customer leaving', () => {
  // The record moved to a stage the tenant has since deleted from its set. With
  // the tenant's real off-path keys that is not a departure; with no list to go
  // on, anything outside the order has to be treated as one.
  const journeys = [journey('LEAD_NEW', '2026-01-02', [['DEAL_WON', '2026-01-10'], ['RETIRED_STAGE', '2026-01-25']])];
  const now = new Date('2026-06-01T00:00:00Z');

  const withList = retentionTriangle(ORDER, journeys, ['2026-01'], [1], { now, offPath: OFF_PATH });
  assert.equal(withList[0].buckets[0].churned, 0);

  const withoutList = retentionTriangle(ORDER, journeys, ['2026-01'], [1], { now });
  assert.equal(withoutList[0].buckets[0].churned, 1, 'no off-path list: off the path is the only reading left');
});

test('an EMPTY off-path list falls back, rather than reporting nobody ever leaves', () => {
  // `outcomeStageKeysFrom()` returns [] for a tenant whose stage set has no
  // off-path row, and the route passes that straight through. Read as a set it
  // would answer "not a loss" to every key, and the whole triangle would print
  // a confident 0% — the same permanent-0%-churn answer the design note
  // rules out, arrived at from the other direction.
  const journeys = [journey('LEAD_NEW', '2026-01-02', [['DEAL_WON', '2026-01-10'], ['GONE', '2026-01-25']])];
  const now = new Date('2026-06-01T00:00:00Z');

  const empty = retentionTriangle(ORDER, journeys, ['2026-01'], [1], { now, offPath: [] });
  assert.deepEqual(empty[0].buckets[0], { months: 1, churned: 1, rate: 100 });

  const absent = retentionTriangle(ORDER, journeys, ['2026-01'], [1], { now });
  assert.deepEqual(absent[0].buckets[0], empty[0].buckets[0], '[] and undefined must read the same');
});

// ── the month list both take ─────────────────────────────────────────────────

test('cohortMonths walks whole UTC months inclusive, across a year boundary', () => {
  assert.deepEqual(
    cohortMonths(new Date('2025-11-17T23:00:00Z'), new Date('2026-02-01T00:00:00Z')),
    ['2025-11', '2025-12', '2026-01', '2026-02'],
  );
  assert.deepEqual(cohortMonths(new Date('2026-03-04T00:00:00Z'), new Date('2026-03-28T00:00:00Z')), ['2026-03']);
  assert.deepEqual(cohortMonths(new Date('2026-05-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z')), [], 'reversed range');
  assert.deepEqual(cohortMonths(new Date('nope'), new Date('2026-04-01T00:00:00Z')), []);
});

test('cohortMonths drops a month the period grammar rejects, instead of 500ing the endpoint', () => {
  // `?from=0999-01-01` parses fine as a Date, and `periodOf` formats year 999
  // as '999-01' — which `periodRange()` throws on. That throw is inside the
  // funnel handler, so an out-of-range year on the query string used to be a
  // 500 rather than an empty card.
  const months = cohortMonths(new Date('0999-01-01T00:00:00Z'), new Date('0999-03-01T00:00:00Z'));
  assert.deepEqual(months, []);
  assert.deepEqual(retentionTriangle(ORDER, [], months, [1]), [], 'and nothing downstream throws');

  // The valid tail of a range that starts out of bounds is still reported.
  const spanning = cohortMonths(new Date('0999-11-01T00:00:00Z'), new Date('1000-02-01T00:00:00Z'));
  assert.deepEqual(spanning, ['1000-01', '1000-02']);
});

test('cohortMonths keeps the newest months when a hand-typed range is absurdly wide', () => {
  const months = cohortMonths(new Date('1970-01-01T00:00:00Z'), new Date('2026-03-31T00:00:00Z'));
  assert.equal(months.length, 36);
  assert.equal(months[35], '2026-03', 'the rows anyone is reading are the recent ones');
  assert.equal(months[0], '2023-04');
});

// ── #2556 · transfer chains and trial → paid ─────────────────────────────────

// A relation as the funnel route hands it to the chain helper: its own
// journey plus the two link fields.
const link = (id, previousRelationId, j) => ({ id, previousRelationId, ...j });

test('a two-link transfer chain is one journey and one win, not two', () => {
  // The customer entered in January and was won in February; in March the
  // owner changed, which closes the relation and opens a successor ON DEAL_WON
  // (src/lib/mentorTransfer.ts) — no StatusChange, the stage is carried over.
  const a = link('a', null, journey('LEAD_NEW', '2026-01-05', [['LEAD_QUALIFIED', '2026-01-10'], ['DEAL_WON', '2026-02-10']]));
  const b = link('b', 'a', journey('DEAL_WON', '2026-03-03'));
  const months = ['2026-01', '2026-02', '2026-03'];

  // Unfolded — the bug: March gains an entry and a conversion out of nowhere,
  // and retention gets a second "won" customer in March.
  const naive = conversionByEntryMonth(ORDER, [a, b], 'LEAD_NEW', 'DEAL_WON', months);
  assert.deepEqual(naive.map((m) => m.entered), [1, 0, 1], 'precondition: the unfolded read double counts');

  const chains = relationChains([b, a]);
  assert.equal(chains.length, 1, 'one journey');
  assert.deepEqual(chains[0].map((l) => l.id), ['a', 'b'], 'root first, whatever the input order');
  const merged = chains.map(mergeChainJourney);
  assert.equal(merged[0].startStatus, 'LEAD_NEW');
  assert.equal(merged[0].startedAt, ms('2026-01-05'), "the root's start, not the transfer date");

  const folded = conversionByEntryMonth(ORDER, merged, 'LEAD_NEW', 'DEAL_WON', months);
  assert.deepEqual(folded.map((m) => [m.entered, m.converted]), [[1, 1], [0, 0], [0, 0]]);
  const retention = retentionTriangle(ORDER, merged, months, [1], { now: new Date('2026-09-01'), wonKeys: ['DEAL_WON'] });
  assert.deepEqual(retention.map((c) => c.won), [0, 1, 0], 'won once, in the month it was won');
});

test('a chain whose successor keeps moving reads as one continuous journey', () => {
  // Transferred while still in trial; the SUCCESSOR records the win.
  const a = link('a', null, journey('LEAD_NEW', '2026-01-05', [['TRIAL_ACTIVE', '2026-01-20']]));
  const b = link('b', 'a', journey('TRIAL_ACTIVE', '2026-02-01', [['DEAL_WON', '2026-02-25']]));
  const c = link('c', null, journey('LEAD_NEW', '2026-01-07'));
  const chains = relationChains([a, b, c]);
  assert.equal(chains.length, 2);
  const merged = chains.map(mergeChainJourney);
  assert.deepEqual(merged[0].changes.map((x) => x.toStatus), ['TRIAL_ACTIVE', 'DEAL_WON']);
  const [jan] = conversionByEntryMonth(ORDER, merged, 'LEAD_NEW', 'DEAL_WON', ['2026-01']);
  assert.deepEqual([jan.entered, jan.converted], [2, 1]);
});

test('relationChains never drops a link: missing predecessor, branch, and a loop', () => {
  const orphan = link('x', 'gone', journey('DEAL_WON', '2026-03-01'));
  const root = link('r', null, journey('LEAD_NEW', '2026-01-01'));
  const k1 = link('k1', 'r', journey('LEAD_NEW', '2026-02-01'));
  const k2 = link('k2', 'r', journey('LEAD_NEW', '2026-02-02'));
  const loopA = link('la', 'lb', journey('LEAD_NEW', '2026-01-01'));
  const loopB = link('lb', 'la', journey('LEAD_NEW', '2026-01-01'));
  const chains = relationChains([orphan, root, k1, k2, loopA, loopB]);
  assert.deepEqual(
    chains.map((c) => c.map((l) => l.id)),
    [['x'], ['r', 'k1', 'k2'], ['la', 'lb']],
  );
  assert.equal(chains.flat().length, 6, 'every link exactly once');
});

const trialJourney = (startStatus, startedAt, changes, extra = {}) => ({
  ...journey(startStatus, startedAt, changes),
  trialStartedAt: extra.trialStartedAt ? ms(extra.trialStartedAt) : null,
  trialEndsAt: extra.trialEndsAt ? ms(extra.trialEndsAt) : null,
  sourceId: extra.sourceId ?? null,
});

test('trialStartOf: the recorded start wins, else the first ARRIVAL; skipping the stage is no trial', () => {
  const recorded = trialJourney('LEAD_NEW', '2026-01-01', [['TRIAL_ACTIVE', '2026-01-09']], { trialStartedAt: '2026-01-08' });
  assert.equal(trialStartOf(recorded, 'TRIAL_ACTIVE'), ms('2026-01-08'));
  const historyOnly = trialJourney('LEAD_NEW', '2026-01-01', [['TRIAL_ACTIVE', '2026-01-09']]);
  assert.equal(trialStartOf(historyOnly, 'TRIAL_ACTIVE'), ms('2026-01-09'));
  const createdInTrial = trialJourney('TRIAL_ACTIVE', '2026-01-04', []);
  assert.equal(trialStartOf(createdInTrial, 'TRIAL_ACTIVE'), ms('2026-01-04'));
  const skipped = trialJourney('LEAD_NEW', '2026-01-01', [['DEAL_PROPOSAL', '2026-01-09'], ['DEAL_WON', '2026-01-20']]);
  assert.equal(trialStartOf(skipped, 'TRIAL_ACTIVE'), null);
});

test('trial → paid is cohorted by trial start; a month is "—" until every trial in it has ended', () => {
  const now = new Date('2026-04-10T00:00:00Z');
  const journeys = [
    // March cohort: two trials, 30 days, both over by 2026-04-10? The second
    // runs to 2026-04-28 → March is immature.
    trialJourney('LEAD_NEW', '2026-02-20', [['TRIAL_ACTIVE', '2026-03-02'], ['DEAL_WON', '2026-03-20']], {
      trialStartedAt: '2026-03-02', trialEndsAt: '2026-04-01',
    }),
    trialJourney('LEAD_NEW', '2026-02-21', [['TRIAL_ACTIVE', '2026-03-29']], {
      trialStartedAt: '2026-03-29', trialEndsAt: '2026-04-28',
    }),
    // February cohort: ended trials, one paid after it EXPIRED (on-path, late).
    trialJourney('LEAD_NEW', '2026-01-10', [['TRIAL_ACTIVE', '2026-02-01'], ['TRIAL_EXPIRED', '2026-03-03'], ['DEAL_WON', '2026-03-15']], {
      trialStartedAt: '2026-02-01', trialEndsAt: '2026-03-03',
    }),
    trialJourney('LEAD_NEW', '2026-01-11', [['TRIAL_ACTIVE', '2026-02-03'], ['TRIAL_EXPIRED', '2026-03-05']], {
      trialStartedAt: '2026-02-03', trialEndsAt: '2026-03-05',
    }),
    trialJourney('LEAD_NEW', '2026-01-12', [['TRIAL_ACTIVE', '2026-02-05'], ['DEAL_LOST', '2026-02-20']], {
      trialStartedAt: '2026-02-05', trialEndsAt: '2026-03-07',
    }),
    // A lead that skipped the trial and won: not in any trial cohort.
    trialJourney('LEAD_NEW', '2026-02-01', [['DEAL_PROPOSAL', '2026-02-10'], ['DEAL_WON', '2026-02-20']]),
  ];
  const { months } = trialConversion(ORDER, journeys, 'TRIAL_ACTIVE', 'DEAL_WON', ['2026-02', '2026-03', '2026-04'], {
    now,
    trialDays: 30,
  });
  assert.deepEqual(months, [
    { month: '2026-02', started: 3, paid: 1, rate: 33, mature: true },
    { month: '2026-03', started: 2, paid: 1, rate: null, mature: false },
    // The month has not closed yet: immature even though empty.
    { month: '2026-04', started: 0, paid: 0, rate: null, mature: false },
  ]);
});

test('a trial with no recorded end matures after the tenant trial length', () => {
  const j = [trialJourney('LEAD_NEW', '2026-01-01', [['TRIAL_ACTIVE', '2026-01-31']])];
  const at = (iso) =>
    trialConversion(ORDER, j, 'TRIAL_ACTIVE', 'DEAL_WON', ['2026-01'], { now: new Date(iso), trialDays: 14 }).months[0].mature;
  assert.equal(at('2026-02-13T00:00:00Z'), false, '31 Jan + 14 days is 14 Feb');
  assert.equal(at('2026-02-14T00:00:00Z'), true);
});

test('trial → paid by source counts mature cohorts only, with an explicit "no source" row', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const t = (sourceId, start, won, extraMonths = 0) =>
    trialJourney('LEAD_NEW', '2026-01-01', [['TRIAL_ACTIVE', start], ...(won ? [['DEAL_WON', won]] : [])], {
      trialStartedAt: start,
      trialEndsAt: new Date(ms(start) + (30 + extraMonths * 30) * 86400000).toISOString(),
      sourceId,
    });
  const journeys = [
    t('src-a', '2026-02-02', '2026-02-20'),
    t('src-a', '2026-02-10', null),
    t('src-a', '2026-03-01', '2026-03-10'),
    t('src-b', '2026-03-04', null),
    t(null, '2026-02-15', '2026-03-01'),
    // Still running on `now` → its month (May) is immature and not counted.
    t('src-b', '2026-05-20', '2026-05-25'),
  ];
  const { bySource } = trialConversion(ORDER, journeys, 'TRIAL_ACTIVE', 'DEAL_WON', ['2026-02', '2026-03', '2026-04', '2026-05'], {
    now,
    trialDays: 30,
  });
  assert.deepEqual(bySource, [
    { sourceId: 'src-a', trials: 3, paid: 2, rate: 67 },
    { sourceId: null, trials: 1, paid: 1, rate: 100 },
    { sourceId: 'src-b', trials: 1, paid: 0, rate: 0 },
  ]);
});

test('trial → paid for a chain: a handover mid-trial is one trial and one paid customer', () => {
  const a = link('a', null, trialJourney('LEAD_NEW', '2026-01-05', [['TRIAL_ACTIVE', '2026-01-20']], {
    trialStartedAt: '2026-01-20', trialEndsAt: '2026-02-19',
  }));
  const b = link('b', 'a', trialJourney('TRIAL_ACTIVE', '2026-02-01', [['DEAL_WON', '2026-02-10']], {
    trialStartedAt: '2026-01-20', trialEndsAt: '2026-02-19',
  }));
  const opts = { now: new Date('2026-06-01T00:00:00Z'), trialDays: 30 };
  const months = ['2026-01', '2026-02'];
  // Unfolded: the successor's carried-over trial start AND its creation in
  // TRIAL_ACTIVE would make January read two trials.
  const naive = trialConversion(ORDER, [a, b], 'TRIAL_ACTIVE', 'DEAL_WON', months, opts);
  assert.equal(naive.months[0].started, 2, 'precondition: the unfolded read double counts');
  const merged = relationChains([a, b]).map((chain) => ({ ...mergeChainJourney(chain), trialStartedAt: chain[0].trialStartedAt, trialEndsAt: chain[0].trialEndsAt, sourceId: null }));
  const folded = trialConversion(ORDER, merged, 'TRIAL_ACTIVE', 'DEAL_WON', months, opts);
  assert.deepEqual(folded.months[0], { month: '2026-01', started: 1, paid: 1, rate: 100, mature: true });
});

test('trial → paid names no key: a tenant with renamed stages converts from its own keys', () => {
  const order = ['PROSPECT', 'PILOT', 'CUSTOMER'];
  const j = [trialJourney('PROSPECT', '2026-01-01', [['PILOT', '2026-01-05'], ['CUSTOMER', '2026-01-25']])];
  const { months } = trialConversion(order, j, 'PILOT', 'CUSTOMER', ['2026-01'], { now: new Date('2026-06-01'), trialDays: 30 });
  assert.deepEqual(months[0], { month: '2026-01', started: 1, paid: 1, rate: 100, mature: true });
});
