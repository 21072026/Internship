// The admin door of canMessage() stays inside the admin's own tenant
// (src/lib/messageAdminRule.ts): org A's admin cannot open a chat with org B's
// user, nor B's user with A's admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { adminDoorOpens } = await import('../../src/lib/messageAdminRule.ts');

const DEFAULT = 'org-default';
const side = (role, orgId) => ({ role, orgId });

test('an admin reaches anyone in their own tenant, in both directions', () => {
  assert.equal(adminDoorOpens(side('ADMIN', 'org-a'), side('MENTEE', 'org-a'), DEFAULT), true);
  assert.equal(adminDoorOpens(side('MENTOR', 'org-a'), side('ADMIN', 'org-a'), DEFAULT), true);
});

test('another tenant is always no, whichever side is the admin', () => {
  assert.equal(adminDoorOpens(side('ADMIN', 'org-a'), side('MENTEE', 'org-b'), DEFAULT), false);
  assert.equal(adminDoorOpens(side('MENTEE', 'org-b'), side('ADMIN', 'org-a'), DEFAULT), false);
  assert.equal(adminDoorOpens(side('ADMIN', 'org-a'), side('ADMIN', 'org-b'), DEFAULT), false);
});

test('an org-less account is the default org, never "anything goes"', () => {
  assert.equal(adminDoorOpens(side('ADMIN', null), side('MENTEE', DEFAULT), DEFAULT), true);
  assert.equal(adminDoorOpens(side('ADMIN', null), side('MENTEE', 'org-b'), DEFAULT), false);
  assert.equal(adminDoorOpens(side('ADMIN', 'org-b'), side('MENTEE', null), DEFAULT), false);
});

test('no admin in the pair: this door stays shut (the other rules decide)', () => {
  assert.equal(adminDoorOpens(side('MENTOR', 'org-a'), side('MENTEE', 'org-a'), DEFAULT), false);
});
