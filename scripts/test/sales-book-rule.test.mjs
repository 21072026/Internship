// The sales surface is the viewer's own book (src/lib/salesBookRule.ts): the
// board and the lead page read this one answer, so every card listed opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { salesBookWhere, canReadSalesTeamBook, salesTeamReadWhere, parseSalesTeamBookSetting } = await import('../../src/lib/salesBookRule.ts');

test('everyone but the dispatcher sees their own records only — an ADMIN included', () => {
  assert.deepEqual(salesBookWhere({ userId: 'u1', dispatcher: false }), { mentorId: 'u1' });
});

test('the dispatcher sees the tenant book (the caller ANDs the tenant)', () => {
  assert.deepEqual(salesBookWhere({ userId: 'u1', dispatcher: true }), {});
});

// The team read (2026-11-15): read-only, never the write scope above.
test('a rep reads the team book only while the org setting is on', () => {
  assert.equal(canReadSalesTeamBook({ teamSetting: true, role: 'MENTOR', dispatcher: false }), true);
  assert.equal(canReadSalesTeamBook({ teamSetting: false, role: 'MENTOR', dispatcher: false }), false);
});

test('an admin and the dispatcher read it whatever the setting; a lead or a customer never', () => {
  assert.equal(canReadSalesTeamBook({ teamSetting: false, role: 'ADMIN', dispatcher: false }), true);
  assert.equal(canReadSalesTeamBook({ teamSetting: false, role: 'MENTOR', dispatcher: true }), true);
  for (const role of ['MENTEE', 'COMPANY', 'SOURCE']) {
    assert.equal(canReadSalesTeamBook({ teamSetting: true, role, dispatcher: false }), false, role);
  }
});

test('the team read narrows to the tenant or to nothing — never more', () => {
  assert.deepEqual(salesTeamReadWhere(true), {});
  assert.equal(salesTeamReadWhere(false), null);
});

test('the setting is on unless explicitly off', () => {
  assert.equal(parseSalesTeamBookSetting(undefined), true);
  assert.equal(parseSalesTeamBookSetting(''), true);
  assert.equal(parseSalesTeamBookSetting('true'), true);
  assert.equal(parseSalesTeamBookSetting('false'), false);
});

test('the write scope did not move: a rep still owns only their own records', () => {
  assert.deepEqual(salesBookWhere({ userId: 'u1', dispatcher: false }), { mentorId: 'u1' });
});

// The write rule: owner, dispatcher, admin — never the team read.
test('only the owner, the dispatcher or an admin with relation.write may work a record', async () => {
  const { salesBookWriteAllowed } = await import('../../src/lib/salesBookRule.ts');
  const base = { userId: 'u1', ownerId: 'u2', dispatcher: false, adminWrite: false };
  assert.equal(salesBookWriteAllowed(base), false);
  assert.equal(salesBookWriteAllowed({ ...base, ownerId: 'u1' }), true);
  assert.equal(salesBookWriteAllowed({ ...base, dispatcher: true }), true);
  assert.equal(salesBookWriteAllowed({ ...base, adminWrite: true }), true);
});
