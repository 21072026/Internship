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

const { salesBookReadWhere, salesBookWriteAllowed, salesBookView } = await import('../../src/lib/salesBookRule.ts');

test('team view: everybody reads the whole org book (the caller ANDs the tenant); mine stays own', () => {
  assert.deepEqual(salesBookReadWhere({ userId: 'u1', dispatcher: false }, 'team'), {});
  assert.deepEqual(salesBookReadWhere({ userId: 'u1', dispatcher: false }, 'mine'), { mentorId: 'u1' });
  assert.deepEqual(salesBookReadWhere({ userId: 'u1', dispatcher: true }, 'mine'), {});
});

test('an unknown view is the default "mine", never the team', () => {
  assert.equal(salesBookView('everything'), 'mine');
  assert.equal(salesBookView(undefined), 'mine');
  assert.equal(salesBookView('team'), 'team');
});

test('writing: the owner, the dispatcher or an admin with relation.write — a colleague never', () => {
  const base = { userId: 'u1', ownerId: 'u2', dispatcher: false, adminWrite: false };
  assert.equal(salesBookWriteAllowed(base), false);
  assert.equal(salesBookWriteAllowed({ ...base, ownerId: 'u1' }), true);
  assert.equal(salesBookWriteAllowed({ ...base, dispatcher: true }), true);
  assert.equal(salesBookWriteAllowed({ ...base, adminWrite: true }), true);
});
