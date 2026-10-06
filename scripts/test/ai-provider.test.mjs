import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { isRetryableProviderError, withRetries, CircuitBreaker, callProvider, ProviderUnavailable, safeParseModelJson, trackParseErrors, stripCodeFence, MAX_RETRIES } =
  await import('../../src/lib/ai/provider.ts');
const { z } = await import('zod');

const err = (props) => Object.assign(new Error(props.message ?? 'x'), props);

test('only rate limits, provider faults and network loss are retried', () => {
  assert.equal(isRetryableProviderError(err({ status: 429 })), true);
  assert.equal(isRetryableProviderError(err({ status: 503 })), true);
  assert.equal(isRetryableProviderError(err({ status: 400 })), false);
  assert.equal(isRetryableProviderError(err({ status: 401 })), false);
  assert.equal(isRetryableProviderError(err({ name: 'APIConnectionTimeoutError' })), true);
  assert.equal(isRetryableProviderError(err({ code: 'ECONNRESET' })), true);
  assert.equal(isRetryableProviderError(err({ message: 'invalid input' })), false);
});

test('retries at most twice, then gives up; a 4xx is never retried', async () => {
  let calls = 0;
  const sleeps = [];
  const opts = { sleep: async (ms) => void sleeps.push(ms), random: () => 1, now: () => 0 };
  await assert.rejects(withRetries(async () => { calls++; throw err({ status: 503 }); }, opts));
  assert.equal(calls, 1 + MAX_RETRIES);
  assert.deepEqual(sleeps, [500, 1000]); // exponential backoff
  calls = 0;
  await assert.rejects(withRetries(async () => { calls++; throw err({ status: 400 }); }, opts));
  assert.equal(calls, 1);
  // Succeeds on the second attempt.
  calls = 0;
  assert.equal(await withRetries(async () => { if (++calls < 2) throw err({ status: 429 }); return 'ok'; }, opts), 'ok');
});

test('no attempt starts that could not finish inside the budget', async () => {
  let calls = 0;
  let clock = 0;
  const opts = { sleep: async () => {}, random: () => 1, now: () => clock, deadlineMs: 1000 };
  await assert.rejects(withRetries(async () => { calls++; clock = 900; throw err({ status: 500 }); }, opts));
  assert.equal(calls, 1); // 900 elapsed + 500 backoff would pass the 1000 budget
});

test('the breaker opens after repeated failures, fails fast, then probes after the cool-down', async () => {
  let t = 0;
  const breaker = new CircuitBreaker({ threshold: 3, windowMs: 1000, coolDownMs: 5000, now: () => t });
  let network = 0;
  const failing = async () => { network++; throw err({ status: 400 }); }; // not retried: one network call each
  for (let i = 0; i < 3; i++) await assert.rejects(callProvider(failing, breaker));
  assert.equal(breaker.state(), 'open');
  await assert.rejects(callProvider(failing, breaker), ProviderUnavailable);
  assert.equal(network, 3); // the fourth made no call
  t = 5000;
  assert.equal(breaker.state(), 'half-open');
  assert.equal(await callProvider(async () => 'back', breaker), 'back');
  assert.equal(breaker.state(), 'closed');
});

test('a reply that is not the JSON asked for falls back and marks the call parse_error', async () => {
  const schema = z.object({ ranking: z.array(z.string()) });
  const fenced = '```json\n{"ranking":["a"]}\n```';
  assert.equal(stripCodeFence(fenced), '{"ranking":["a"]}');
  const ok = await trackParseErrors(async () => safeParseModelJson(fenced, schema, { ranking: [] }));
  assert.deepEqual(ok, { result: { ranking: ['a'] }, parseError: false });
  const bad = await trackParseErrors(async () => safeParseModelJson('Sorry, I cannot help.', schema, { ranking: [] }));
  assert.deepEqual(bad, { result: { ranking: [] }, parseError: true });
  const wrongShape = await trackParseErrors(async () => safeParseModelJson('{"ranking":"nope"}', schema, { ranking: [] }));
  assert.equal(wrongShape.parseError, true);
  // Outside a tracked call it still never throws.
  assert.deepEqual(safeParseModelJson(null, schema, { ranking: [] }), { ranking: [] });
});
