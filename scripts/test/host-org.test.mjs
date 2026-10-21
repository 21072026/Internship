import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost, normalizeRootDomain, slugUnderRootDomain } from '../../src/lib/hostOrgRule.ts';

// Host → tenant, the pure half (#1661). Every hostname is a reserved example
// name (RFC 2606).

test('normalizeHost: first proxy entry, lowercase, port and trailing dot dropped; junk refused', () => {
  assert.equal(normalizeHost(' Careers.Acme.Example:443 , evil.example'), 'careers.acme.example');
  assert.equal(normalizeHost('careers.acme.example.'), 'careers.acme.example');
  assert.equal(normalizeHost('localhost:3000'), 'localhost');
  for (const bad of [null, undefined, '', ':443', '*.acme.example', 'user@acme.example', 'acme.example/path', 'a b.example', '-acme.example']) {
    assert.equal(normalizeHost(bad), null, String(bad));
  }
});

test('normalizeRootDomain: at least two labels, or nothing', () => {
  assert.equal(normalizeRootDomain('CRM.Example.COM'), 'crm.example.com');
  assert.equal(normalizeRootDomain('com'), null);
  assert.equal(normalizeRootDomain(''), null);
  assert.equal(normalizeRootDomain(undefined), null);
});

test('slugUnderRootDomain: exactly one label below the root, a valid slug, and only while the root is set', () => {
  const root = 'crm.example.com';
  assert.equal(slugUnderRootDomain('acme.crm.example.com', root), 'acme');
  assert.equal(slugUnderRootDomain('acme-gmbh.crm.example.com', root), 'acme-gmbh');
  // Not one label down, or not under the root at all.
  assert.equal(slugUnderRootDomain('a.b.crm.example.com', root), null);
  assert.equal(slugUnderRootDomain('crm.example.com', root), null);
  assert.equal(slugUnderRootDomain('acme.crm.example.com.evil.test', root), null);
  assert.equal(slugUnderRootDomain('acmecrm.example.com', root), null);
  // The product's own host with no root configured is nobody.
  assert.equal(slugUnderRootDomain('acme.crm.example.com', null), null);
  assert.equal(slugUnderRootDomain(null, root), null);
  // A label orgSlug.ts could never produce.
  assert.equal(slugUnderRootDomain('-acme.crm.example.com', root), null);
  assert.equal(slugUnderRootDomain(`${'a'.repeat(61)}.crm.example.com`, root), null);
});
