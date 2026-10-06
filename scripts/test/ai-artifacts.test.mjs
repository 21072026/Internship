import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { hashInput, TASK_TTL_MS } = await import('../../src/lib/ai/artifacts.ts');

test('the input hash ignores key order and changes with any value', () => {
  const a = hashInput({ position: 'Backend', skills: ['Java', 'SQL'], focus: '' });
  assert.equal(a, hashInput({ focus: '', skills: ['Java', 'SQL'], position: 'Backend' }));
  assert.notEqual(a, hashInput({ position: 'Backend', skills: ['SQL', 'Java'], focus: '' })); // list order is meaning
  assert.notEqual(a, hashInput({ position: 'Backend', skills: ['Java', 'SQL'], focus: 'system design' }));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('a task without a TTL is never answered from the cache', () => {
  assert.ok(TASK_TTL_MS.cv_feedback > 0);
  assert.equal(TASK_TTL_MS.cv_extract, undefined);
});
