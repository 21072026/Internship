import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roleHome, roleSection } from './roleHome.ts';

// The app keeps its own copy of the web's role → dashboard rule; this keeps the
// two from drifting apart.
test('roleHome matches the web rule for every role', () => {
  const web = readFileSync(new URL('../../../../src/lib/roleHome.ts', import.meta.url), 'utf8');
  for (const [role, path] of [['ADMIN', '/admin'], ['MENTOR', '/mentor'], ['COMPANY', '/company'], ['SOURCE', '/source']]) {
    assert.ok(web.includes(`role === '${role}') return '${path}'`), `web rule for ${role} moved`);
    assert.equal(roleHome(role), path);
  }
  assert.ok(web.includes("return '/portal'"));
  assert.equal(roleHome('MENTEE'), '/portal');
});

test('role sections exist for the MVP roles only', () => {
  assert.equal(roleSection('MENTEE', 'calendar'), '/portal/calendar');
  assert.equal(roleSection('MENTOR', 'profile'), '/mentor/profile');
  assert.equal(roleSection('ADMIN', 'calendar'), null);
});
