import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { redactAnswerText, prepareAnswerTexts, parseSummary } = await import('../../src/lib/surveyTextRules.ts');

test('contact details are masked, everything else is kept as typed', () => {
  assert.equal(redactAnswerText('Write me at ada@example.com or +49 151 2345 6789'), 'Write me at [e-mail] or [phone]');
  assert.equal(redactAnswerText('See https://example.com/x and www.foo.de'), 'See [link] and [link]');
  // A year or a short count is not a phone number.
  assert.equal(redactAnswerText('In 2026 we met 12 times'), 'In 2026 we met 12 times');
});

test('answers are trimmed, empties dropped and the total capped', () => {
  assert.deepEqual(prepareAnswerTexts(['  a  ', '', '   ', 'bb']), ['a', 'bb']);
  assert.deepEqual(prepareAnswerTexts(['aaaa', 'bbbb', 'cccc'], 9), ['aaaa', 'bbbb']);
});

test('a quote survives only when an answer contains it verbatim', () => {
  const sent = ['The weekly check-ins kept me on track.', 'More feedback on my CV, please'];
  const reply = 'Here you go: {"themes":[{"theme":"Structure","quotes":["“The weekly check-ins kept me on track.”","Our mentor Ali was amazing"]},{"theme":"CV help","quotes":["more  feedback on my cv"]}]}';
  assert.deepEqual(parseSummary(reply, sent), [
    { theme: 'Structure', quotes: ['The weekly check-ins kept me on track.'] },
    { theme: 'CV help', quotes: ['more  feedback on my cv'] },
  ]);
});

test('a reply that is not the JSON asked for is null, not a guess', () => {
  assert.equal(parseSummary('I cannot do that.', ['x']), null);
  assert.equal(parseSummary('{"themes": "nope"}', ['x']), null);
  assert.equal(parseSummary('{broken', ['x']), null);
});
