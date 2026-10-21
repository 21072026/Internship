import { test, expect } from '@playwright/test';
import { parseSamlRedirectQuery } from '@/lib/samlRedirectQuery';

// The SAML HTTP-Redirect reader (#1952 follow-up, src/lib/samlRedirectQuery.ts):
// the query node-saml verifies is rebuilt from exactly the tokens the message
// was decoded from, so a second, unsigned message can never ride along with a
// signed one. Browserless.

const REQ = 'SAMLRequest=fZJB%2Bw%3D%3D';
const RS = 'RelayState=rs%201';
const ALG = 'SigAlg=http%3A%2F%2Fwww.w3.org%2F2001%2F04%2Fxmldsig-more%23rsa-sha256';
const SIG = 'Signature=c2ln%2Bc2ln';

test('a well-formed query decodes the five binding keys and keeps their raw tokens in binding order', { tag: '@smoke' }, () => {
  const parsed = parseSamlRedirectQuery(`?${SIG}&${ALG}&utm=1&${RS}&${REQ}`);
  expect(parsed).toEqual({
    ok: true,
    msg: {
      SAMLRequest: 'fZJB+w==',
      RelayState: 'rs 1',
      SigAlg: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      Signature: 'c2ln+c2ln',
    },
    // Any other parameter is dropped: no signature ever covers it.
    signedQuery: `${REQ}&${RS}&${ALG}&${SIG}`,
  });
  // `+` is a space in a query (form encoding), the same as URLSearchParams.
  expect(parseSamlRedirectQuery('RelayState=a+b')).toMatchObject({ ok: true, msg: { RelayState: 'a b' } });
});

test('a repeated binding key is refused, whichever copy is signed', { tag: '@smoke' }, () => {
  for (const key of ['SAMLRequest', 'SAMLResponse', 'RelayState', 'SigAlg', 'Signature']) {
    const query = `${key}=a&${key}=b`;
    expect(parseSamlRedirectQuery(query), key).toEqual({ ok: false, reason: 'duplicate_key' });
  }
  // The shape of the attack: a signed message, then an unsigned one.
  expect(parseSamlRedirectQuery(`${REQ}&${ALG}&${SIG}&SAMLRequest=Zm9yZ2Vk`)).toEqual({ ok: false, reason: 'duplicate_key' });
});

test('a percent-encoded binding key is refused rather than read under its decoded name', { tag: '@smoke' }, () => {
  for (const key of ['SAMLReq%75est', 'SAML%52esponse', 'Relay%53tate', 'Sig%41lg', '%53ignature']) {
    expect(parseSamlRedirectQuery(`${REQ}&${key}=x`), key).toEqual({ ok: false, reason: 'encoded_key' });
  }
  // An encoded key that decodes to something unrelated is just another parameter.
  expect(parseSamlRedirectQuery(`${REQ}&ut%6D=1`)).toMatchObject({ ok: true, signedQuery: REQ });
});

test('a request and a response in one query, and a broken escape, are refused', { tag: '@smoke' }, () => {
  expect(parseSamlRedirectQuery(`${REQ}&SAMLResponse=eA%3D%3D`)).toEqual({ ok: false, reason: 'request_and_response' });
  expect(parseSamlRedirectQuery('SAMLRequest=%E0%A4%A')).toEqual({ ok: false, reason: 'malformed' });
  expect(parseSamlRedirectQuery('%E0%A4%A=1')).toEqual({ ok: false, reason: 'malformed' });
});

test('names are case-sensitive, as in the binding; an empty query parses to nothing', { tag: '@smoke' }, () => {
  expect(parseSamlRedirectQuery('samlrequest=x&SAMLRequest=y')).toEqual({ ok: true, msg: { SAMLRequest: 'y' }, signedQuery: 'SAMLRequest=y' });
  expect(parseSamlRedirectQuery('')).toEqual({ ok: true, msg: {}, signedQuery: '' });
  expect(parseSamlRedirectQuery('?&&')).toEqual({ ok: true, msg: {}, signedQuery: '' });
});
