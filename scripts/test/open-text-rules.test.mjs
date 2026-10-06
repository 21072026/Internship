import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { prepareOpenText, parseOpenTextSummary, belowFloor, maskNames } = await import('../../src/lib/ai/openTextRules.ts');

const rows = [
  { id: 'ev_1', text: 'Ayşe Yılmaz struggles with Git rebases; mail ayse@example.com.' },
  { id: 'ev_2', text: 'Great progress on the API task, Ayşe was proactive.' },
  { id: 'ev_3', text: '   ' },
  { id: 'ev_4', text: 'Onboarding docs were outdated, lost two days.' },
];

test('names and contact details are masked, ids stay home, empties are dropped', () => {
  const { prepared, caveats } = prepareOpenText(rows, { names: ['Ayşe Yılmaz', 'Bo'] });
  assert.deepEqual(prepared.map((p) => p.label), ['r1', 'r2', 'r3']);
  assert.deepEqual(prepared.map((p) => p.id), ['ev_1', 'ev_2', 'ev_4']);
  assert.equal(prepared[0].text, '[name] struggles with Git rebases; mail [e-mail].');
  assert.equal(prepared[1].text, 'Great progress on the API task, [name] was proactive.');
  assert.ok(caveats.some((c) => c.code === 'names_masked'));
  // A two-letter name part is never masked on its own, and a name inside a word is not a name.
  assert.equal(maskNames('Bob and Ali on Alignment', ['Ali Bo']), 'Bob and [name] on Alignment');
});

test('below the floor the refusal is all there is', () => {
  assert.deepEqual(belowFloor(rows, 4), { code: 'below_floor', floor: 4, available: 3 });
  assert.equal(belowFloor(rows, 3), null);
});

test('the char cap drops rows and says so', () => {
  const { prepared, caveats } = prepareOpenText(rows, { maxChars: 60 });
  assert.equal(prepared.length, 1);
  assert.deepEqual(caveats.find((c) => c.code === 'truncated'), { code: 'truncated', sent: 1, available: 3 });
});

test('the reply is verified against what was sent, never trusted', () => {
  const { prepared } = prepareOpenText(rows, { names: ['Ayşe Yılmaz'] });
  const reply = JSON.stringify({
    themes: [
      { label: 'Tooling friction', ids: ['r1', 'r3', 'r9', 'r1'], sentiment: 'negative' },
      { label: 'Ghost theme', ids: ['r42'] },
      { label: 'Momentum', ids: ['r2'] },
    ],
    sentiment: { r1: 'negative', r2: 'positive', r3: 0.82 },
    quotes: [
      { id: 'r3', text: 'lost two days' },
      { id: 'r2', text: 'Ayşe was proactive' }, // the name was never sent
      { id: 'r1', text: 'something nobody wrote' },
      { id: 'r2', text: '[name] was proactive' },
    ],
  });
  const s = parseOpenTextSummary('Sure! ' + reply, prepared);
  // An unknown label is dropped, a duplicate counted once, and the count is ours.
  assert.deepEqual(s.themes.map((t) => [t.label, t.count, t.exampleIds]), [
    ['Tooling friction', 2, ['ev_1', 'ev_4']],
    ['Momentum', 1, ['ev_2']],
  ]);
  // A number is not a sentiment: r3 is unclear, so its theme ties → unclear.
  assert.deepEqual(s.overall, { positive: 1, neutral: 0, negative: 1, unclear: 1 });
  assert.equal(s.themes[0].sentiment, 'unclear');
  assert.equal(s.themes[1].sentiment, 'positive');
  assert.deepEqual(s.notableQuotes, [{ id: 'ev_4', text: 'lost two days' }, { id: 'ev_2', text: '[name] was proactive' }]);
  assert.deepEqual(s.caveats.at(-1), { code: 'quotes_dropped', n: 2 });
  assert.equal(parseOpenTextSummary('no json here', prepared), null);
  assert.equal(parseOpenTextSummary('{"themes": "nope"}', prepared), null);
});
