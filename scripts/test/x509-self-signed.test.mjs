// The SP signing certificate builder (#1952). No Next, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { selfSignedCertificate, derInt } from '../../src/lib/x509SelfSigned.ts';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

test('a certificate node can parse, for our public key, with the validity asked for', () => {
  const notBefore = new Date('2026-10-20T00:00:00Z');
  const notAfter = new Date('2036-10-20T00:00:00Z');
  const pem = selfSignedCertificate(publicKey, privateKey, 'sso-sp-acme', { notBefore, notAfter });
  const x = new crypto.X509Certificate(pem);
  assert.equal(x.subject, 'CN=sso-sp-acme');
  assert.equal(x.issuer, 'CN=sso-sp-acme');
  assert.equal(new Date(x.validFrom).toISOString(), notBefore.toISOString());
  assert.equal(new Date(x.validTo).toISOString(), notAfter.toISOString());
  assert.ok(x.publicKey.equals(publicKey));
  assert.ok(x.verify(publicKey), 'self-signed: verifies with its own key');
});

test('a validity reaching 2050 or later is encoded as GeneralizedTime, not a wrapped UTCTime', () => {
  const pem = selfSignedCertificate(publicKey, privateKey, 'far', {
    notBefore: new Date('2045-01-01T00:00:00Z'),
    notAfter: new Date('2055-06-01T12:00:00Z'),
  });
  assert.equal(new Date(new crypto.X509Certificate(pem).validTo).toISOString(), '2055-06-01T12:00:00.000Z');
});

test('serials that used to break DER (leading zero, high bit) still parse', () => {
  for (const serial of [Buffer.from([0x00, 0x12, 1, 2]), Buffer.from([0x80, 1]), Buffer.from([0, 0, 0x7f])]) {
    const pem = selfSignedCertificate(publicKey, privateKey, 'serial', {
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    }, serial);
    assert.doesNotThrow(() => new crypto.X509Certificate(pem));
  }
  assert.deepEqual([...derInt(Buffer.from([0x00, 0x12]))], [0x02, 0x01, 0x12]);
  assert.deepEqual([...derInt(Buffer.from([0x80]))], [0x02, 0x02, 0x00, 0x80]);
});
