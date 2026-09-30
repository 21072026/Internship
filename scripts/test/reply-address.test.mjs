// Unit tests for the reply-by-email domain rule (#2217).
// Run: node --test --experimental-strip-types scripts/test/reply-address.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboundEmailDomain } from '../../src/lib/inboundDomain.ts';

// The old default, `crm.ersah.in`, outlived its mailbox: an environment without
// the variable minted a Reply-To nobody reads. Unset now means "no Reply-To".
test('no inbound domain configured → null, never a guessed default', () => {
  assert.equal(inboundEmailDomain({}), null);
  assert.notEqual(inboundEmailDomain({}), 'crm.ersah.in');
});

test('a blank or whitespace domain counts as unset', () => {
  assert.equal(inboundEmailDomain({ INBOUND_EMAIL_DOMAIN: '' }), null);
  assert.equal(inboundEmailDomain({ INBOUND_EMAIL_DOMAIN: '   ' }), null);
});

test('a configured domain is used as given, trimmed', () => {
  assert.equal(inboundEmailDomain({ INBOUND_EMAIL_DOMAIN: ' reply.example.test ' }), 'reply.example.test');
});

test('reads process.env by default', () => {
  const before = process.env.INBOUND_EMAIL_DOMAIN;
  try {
    process.env.INBOUND_EMAIL_DOMAIN = 'from-env.example.test';
    assert.equal(inboundEmailDomain(), 'from-env.example.test');
    delete process.env.INBOUND_EMAIL_DOMAIN;
    assert.equal(inboundEmailDomain(), null);
  } finally {
    if (before === undefined) delete process.env.INBOUND_EMAIL_DOMAIN;
    else process.env.INBOUND_EMAIL_DOMAIN = before;
  }
});
