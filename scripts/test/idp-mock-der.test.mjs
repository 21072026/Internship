// Regression guard for the stub IdP's hand-rolled DER encoder (#2251).
//
// `selfSignedCertificate` builds the certificate byte by byte rather than pull
// in a certificate library, and a DER INTEGER has to be the MINIMAL
// two's-complement encoding. The serial is `crypto.randomBytes(8)`, so roughly
// one run in 256 drew a leading 0x00 followed by a byte under 0x80 — a
// redundant pad byte, which OpenSSL rejects with ERR_OSSL_ASN1_ILLEGAL_PADDING.
// That threw inside `new crypto.X509Certificate(...)` at import time, so the
// Playwright webServer never came up and the whole job failed with no test
// having run. Rare, and in the harness rather than in a spec, which is exactly
// why it read as an unrelated infrastructure flake.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.IDP_MOCK_NO_LISTEN = '1';
const { derInt, selfSignedCertificate } = await import('../../e2e/support/idp-mock.mjs');

test('a serial with a redundant leading zero is minimised', () => {
  // The exact byte pattern that took CI down: 0x00 then a byte under 0x80.
  const out = derInt(Buffer.from([0x00, 0x42, 0x99, 0x01, 0x02, 0x03, 0x04, 0x05]));
  assert.equal(out[0], 0x02, 'tag is INTEGER');
  assert.equal(out[1], 7, 'one byte shorter than the input');
  assert.equal(out[2], 0x42, 'the pad byte is gone');
});

test('several redundant leading zeros are all stripped', () => {
  assert.deepEqual([...derInt(Buffer.from([0x00, 0x00, 0x00, 0x7f]))], [0x02, 0x01, 0x7f]);
});

test('a zero that CARRIES the sign is kept', () => {
  assert.deepEqual([...derInt(Buffer.from([0x00, 0x80, 0x01]))], [0x02, 0x03, 0x00, 0x80, 0x01]);
});

test('a high bit still gets its sign pad', () => {
  assert.deepEqual([...derInt(Buffer.from([0xff, 0x01]))], [0x02, 0x03, 0x00, 0xff, 0x01]);
});

test('an all-zero serial encodes as a single zero byte', () => {
  assert.deepEqual([...derInt(Buffer.alloc(8))], [0x02, 0x01, 0x00]);
});

test('an already-minimal serial is untouched', () => {
  assert.deepEqual([...derInt(Buffer.from([0x42, 0x99]))], [0x02, 0x02, 0x42, 0x99]);
});

test('every serial shape produces a certificate OpenSSL will parse', () => {
  // The property that actually matters. One RSA key, many serials — keygen is
  // the slow part, the encoding is not.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const serial of [
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]), // the failing shape
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]),
    Buffer.alloc(8),
    Buffer.alloc(8, 0xff),
    Buffer.from([0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  ]) {
    const pem = selfSignedCertificate(publicKey, privateKey, 'e2e-der-test', serial);
    new crypto.X509Certificate(pem); // throws on a malformed DER
  }
});
