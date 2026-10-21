// The SLO redirect binding's query parser (#1952 follow-up). No Next, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRedirectBinding } from '../../src/lib/samlRedirectQuery.ts';

const enc = encodeURIComponent;

test('one of each: canonical order, decoded values', () => {
  const q = `?Signature=${enc('s+g/=')}&foo=1&SAMLRequest=${enc('a+b/c=')}&SigAlg=${enc('http://x#rsa-sha256')}&RelayState=rs`;
  const r = parseRedirectBinding(q);
  assert.equal(typeof r, 'object');
  assert.equal(r.message.SAMLRequest, 'a+b/c=');
  assert.equal(r.message.Signature, 's+g/=');
  assert.equal(r.message.RelayState, 'rs');
  assert.equal(r.canonicalQuery, `SAMLRequest=${enc('a+b/c=')}&RelayState=rs&SigAlg=${enc('http://x#rsa-sha256')}&Signature=${enc('s+g/=')}`);
});

test('a repeated binding parameter is refused, whichever one', () => {
  for (const key of ['SAMLRequest', 'SAMLResponse', 'RelayState', 'SigAlg', 'Signature']) {
    const base = key === 'SAMLResponse' ? 'SAMLResponse=a' : 'SAMLRequest=a';
    assert.equal(parseRedirectBinding(`${base}&${key}=b&${key}=c`), 'duplicate_param', key);
  }
  // An encoded name is the same name.
  assert.equal(parseRedirectBinding('SAMLRequest=a&SAML%52equest=b'), 'duplicate_param');
});

test('look-alike names are not ours, and do not count as the parameter', () => {
  const r = parseRedirectBinding('xSAMLRequest=evil&SAMLRequest=a&SigAlgX=1');
  assert.equal(r.message.SAMLRequest, 'a');
  assert.equal(r.canonicalQuery, 'SAMLRequest=a');
});

test('exactly one message, and a readable query', () => {
  assert.equal(parseRedirectBinding('RelayState=x'), 'no_message');
  assert.equal(parseRedirectBinding('SAMLRequest=a&SAMLResponse=b'), 'no_message');
  assert.equal(parseRedirectBinding('SAMLRequest=%E0%A4%A'), 'malformed');
});
