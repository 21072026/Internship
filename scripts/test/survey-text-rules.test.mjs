import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { redactAnswerText } = await import('../../src/lib/surveyTextRules.ts');

test('contact details are masked, everything else is kept as typed', () => {
  assert.equal(redactAnswerText('Write me at ada@example.com or +49 151 2345 6789'), 'Write me at [e-mail] or [phone]');
  assert.equal(redactAnswerText('See https://example.com/x and www.foo.de'), 'See [link] and [link]');
  // A year or a short count is not a phone number.
  assert.equal(redactAnswerText('In 2026 we met 12 times'), 'In 2026 we met 12 times');
});
