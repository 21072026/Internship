// Per-test reliability history and report (#1610).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordsFromReport, summarize, markdown, parseHistory } from '../e2e-reliability.mjs';

// The shape Playwright's JSON reporter writes: nested suites, specs, tests, results.
const report = {
  suites: [
    {
      title: 'a.spec.ts',
      file: 'a.spec.ts',
      specs: [
        { title: 'steady', file: 'a.spec.ts', tags: ['@smoke'], tests: [{ status: 'expected', results: [{ duration: 100, retry: 0 }] }] },
        { title: 'shaky', file: 'a.spec.ts', tags: [], tests: [{ status: 'flaky', results: [{ duration: 50 }, { duration: 60 }] }] },
      ],
      suites: [
        {
          title: 'group',
          specs: [{ title: 'broken', file: 'a.spec.ts', tags: ['@quarantine'], tests: [{ status: 'unexpected', results: [{ duration: 5 }, { duration: 5 }] }] }],
        },
      ],
    },
  ],
};

test('a report flattens into one record per test, with status, retries and duration', () => {
  assert.deepEqual(recordsFromReport(report), [
    { id: 'a.spec.ts › steady', title: 'steady', status: 'pass', retries: 0, ms: 100 },
    { id: 'a.spec.ts › shaky', title: 'shaky', status: 'flaky', retries: 1, ms: 110 },
    { id: 'a.spec.ts › group › broken', title: 'group › broken', status: 'fail', retries: 1, ms: 10, q: 1 },
  ]);
  // A report from the non-gating quarantine step marks every test.
  assert.ok(recordsFromReport(report, { quarantined: true }).every((r) => r.q === 1));
  assert.deepEqual(recordsFromReport(null), []);
});

test('the summary ranks the least reliable first and ignores skips', () => {
  const run = (statuses) => ({ tests: Object.entries(statuses).map(([id, status]) => ({ id, status })) });
  const history = [
    run({ a: 'pass', b: 'flaky', c: 'fail' }),
    run({ a: 'pass', b: 'pass', c: 'skip' }),
    run({ a: 'pass', b: 'pass', c: 'fail' }),
  ];
  const s = summarize(history, { runs: 40 });
  assert.equal(s.runs, 3);
  assert.deepEqual(s.tests.map((t) => [t.id, t.runs, t.pass, t.flaky, t.fail]), [
    ['c', 2, 0, 0, 2],
    ['b', 3, 2, 1, 0],
    ['a', 3, 3, 0, 0],
  ]);
  // Only the last N runs count.
  assert.deepEqual(summarize(history, { runs: 1 }).tests.find((t) => t.id === 'b').passRate, 1);
});

test('the table shows imperfect tests only, marks quarantine and escapes pipes', () => {
  const s = summarize([{ tests: [{ id: 'x | y', status: 'flaky', q: 1 }, { id: 'ok', status: 'pass' }] }]);
  const md = markdown(s);
  assert.match(md, /last 1 scheduled run\)/);
  assert.match(md, /\| `Q` `x \\\| y` \| 1 \| 0 \| 1 \| 0 \| 0% \|/);
  assert.doesNotMatch(md, /`ok`/);
  assert.match(markdown(summarize([{ tests: [{ id: 'ok', status: 'pass' }] }])), /Every test passed on its first try/);
  assert.match(markdown(summarize([])), /No history yet/);
});

test('a corrupt history line is skipped, not fatal', () => {
  assert.equal(parseHistory('{"tests":[]}\nnot json\n\n{"tests":[]}\n').length, 2);
});
