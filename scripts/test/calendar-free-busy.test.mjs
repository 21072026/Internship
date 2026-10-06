import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { scopeAllowsFreeBusy } = await import('../../src/lib/calendarFreeBusy.ts');

test('only a grant that includes a free/busy-capable scope is asked for busy hours', () => {
  assert.equal(scopeAllowsFreeBusy('https://www.googleapis.com/auth/calendar.events openid email'), false);
  assert.equal(scopeAllowsFreeBusy('https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy'), true);
  assert.equal(scopeAllowsFreeBusy('https://www.googleapis.com/auth/calendar.readonly'), true);
  assert.equal(scopeAllowsFreeBusy('https://www.googleapis.com/auth/calendar'), true);
  // A prefix is not a grant.
  assert.equal(scopeAllowsFreeBusy('https://www.googleapis.com/auth/calendar.freebusyx'), false);
  assert.equal(scopeAllowsFreeBusy(''), false);
  assert.equal(scopeAllowsFreeBusy(null), false);
});
