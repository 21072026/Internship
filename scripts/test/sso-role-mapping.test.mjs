// IdP role mapping (#1940) — the pure rule. No Next, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, resolveRole, isMappableRole } from '../../src/lib/ssoRoleMapping.ts';

const GROUPS = 'groups';
const ROLE_URI = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';
const m = (claim, matchValue, role, priority = 0) => ({ claim, matchValue, role, priority });

test('a matching claim value grants its role; no match is null (the caller provisions MENTEE)', () => {
  const mappings = [m(GROUPS, 'crm-mentors', 'MENTOR')];
  assert.equal(resolveRole(mappings, { groups: ['staff', 'crm-mentors'] }), 'MENTOR');
  assert.equal(resolveRole(mappings, { groups: ['staff'] }), null);
  assert.equal(resolveRole(mappings, {}), null);
  assert.equal(resolveRole([], { groups: ['crm-mentors'] }), null);
});

test('values compare case-insensitively and trimmed; claim names match exactly', () => {
  const mappings = [m(ROLE_URI, 'Company-Contact', 'COMPANY')];
  assert.equal(resolveRole(mappings, { [ROLE_URI]: ['  company-contact '] }), 'COMPANY');
  assert.equal(resolveRole(mappings, { role: ['company-contact'] }), null);
});

test('the highest priority wins', () => {
  const mappings = [m(GROUPS, 'a', 'MENTOR', 1), m(GROUPS, 'b', 'COMPANY', 5)];
  assert.equal(resolveRole(mappings, { groups: ['a', 'b'] }), 'COMPANY');
});

test('a priority tie goes to the LESS privileged role, whatever the row order', () => {
  const tie = [m(GROUPS, 'a', 'MENTOR', 3), m(GROUPS, 'b', 'SOURCE', 3), m(GROUPS, 'c', 'COMPANY', 3)];
  assert.equal(resolveRole(tie, { groups: ['a', 'b', 'c'] }), 'SOURCE');
  assert.equal(resolveRole([...tie].reverse(), { groups: ['a', 'b', 'c'] }), 'SOURCE');
  assert.equal(resolveRole([m(GROUPS, 'a', 'MENTOR'), m(GROUPS, 'b', 'MENTEE')], { groups: ['a', 'b'] }), 'MENTEE');
});

test('ADMIN is never granted, even by a row that somehow holds it', () => {
  assert.equal(isMappableRole('ADMIN'), false);
  assert.equal(resolveRole([m(GROUPS, 'admins', 'ADMIN', 100)], { groups: ['admins'] }), null);
  assert.equal(resolveRole([m(GROUPS, 'admins', 'ADMIN', 100), m(GROUPS, 'staff', 'MENTOR')], { groups: ['admins', 'staff'] }), 'MENTOR');
  assert.equal(resolveRole([m(GROUPS, 'x', 'SUPERUSER')], { groups: ['x'] }), null);
});

test('extractClaims normalises a single string and an array alike, and drops non-strings', () => {
  const claims = extractClaims({
    groups: ['crm-mentors', ' staff ', '', 42],
    [ROLE_URI]: 'Company-Contact',
    email: 'a@b.c',
    issuer: { nested: true },
    empty: '   ',
    getAssertionXml: () => '<xml/>',
  });
  assert.deepEqual(claims.groups, ['crm-mentors', 'staff']);
  assert.deepEqual(claims[ROLE_URI], ['Company-Contact']);
  assert.deepEqual(claims.email, ['a@b.c']);
  assert.equal('issuer' in claims, false);
  assert.equal('empty' in claims, false);
  assert.equal('getAssertionXml' in claims, false);
  assert.deepEqual(extractClaims(null), {});
});
