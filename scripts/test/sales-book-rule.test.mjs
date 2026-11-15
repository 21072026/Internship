// The sales surface is the viewer's own book (src/lib/salesBookRule.ts): the
// board and the lead page read this one answer, so every card listed opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { salesBookWhere } = await import('../../src/lib/salesBookRule.ts');

test('everyone but the dispatcher sees their own records only — an ADMIN included', () => {
  assert.deepEqual(salesBookWhere({ userId: 'u1', dispatcher: false }), { mentorId: 'u1' });
});

test('the dispatcher sees the tenant book (the caller ANDs the tenant)', () => {
  assert.deepEqual(salesBookWhere({ userId: 'u1', dispatcher: true }), {});
});
