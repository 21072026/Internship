import crypto from 'node:crypto';

// Minimal DER / X.509 for the e2e harness — moved out of idp-mock.mjs (#1933)
// so a spec can mint a real, parseable certificate of a chosen lifetime: the
// SSO write path parses the certificate since #1933, so a placeholder string
// no longer saves, and the expiry badge and warning job need certificates that
// lapse on a chosen day. Generated at run time; nothing is committed.
//
// Node can generate an RSA key pair but cannot wrap the public half in a
// self-signed certificate, and IdPs hand out certificates, not bare public
// keys. Shelling out to `openssl` would make the harness depend on a binary
// that may not exist on a contributor's machine, and a certificate fixture on
// disk is the thing we are refusing to commit. So: ~60 lines of DER, verified
// by `new crypto.X509Certificate(pem)` at start-up, which throws if any of it
// is malformed.

function der(tag, body) {
  const len = body.length;
  let lenBytes;
  if (len < 0x80) {
    lenBytes = Buffer.from([len]);
  } else {
    const b = [];
    let n = len;
    while (n > 0) {
      b.unshift(n & 0xff);
      n >>>= 8;
    }
    lenBytes = Buffer.from([0x80 | b.length, ...b]);
  }
  return Buffer.concat([Buffer.from([tag]), lenBytes, body]);
}
const derSeq = (...parts) => der(0x30, Buffer.concat(parts));
const derSet = (...parts) => der(0x31, Buffer.concat(parts));
const derNull = () => der(0x05, Buffer.alloc(0));
const derUtf8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
const derBitString = (buf) => der(0x03, Buffer.concat([Buffer.from([0]), buf]));

function derOid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let rest = part >>> 7;
    while (rest > 0) {
      stack.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

export function derInt(value) {
  let b = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  // DER demands the MINIMAL two's-complement encoding, and the two rules below
  // are not symmetric decoration — getting either wrong produces a certificate
  // OpenSSL rejects outright with ERR_OSSL_ASN1_ILLEGAL_PADDING.
  //
  // 1. Strip redundant leading 0x00 bytes. A 0x00 is only legal when the byte
  //    after it has its high bit set (there to carry the sign). The serial here
  //    is `crypto.randomBytes(8)`, so roughly 1 run in 256 draws a first byte of
  //    0x00 followed by a byte under 0x80 — and *that* run died at import,
  //    before a single test body ran, taking the whole Playwright job with it.
  //    It read as an unrelated infrastructure flake precisely because it is rare
  //    and fires in the webServer rather than in a spec.
  // 2. Only then pad for the sign bit.
  let i = 0;
  while (i + 1 < b.length && b[i] === 0 && !(b[i + 1] & 0x80)) i += 1;
  if (i) b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // keep it positive
  return der(0x02, b);
}

function derUtcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s =
    `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(s, 'ascii'));
}

const OID_COMMON_NAME = '2.5.4.3';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const derName = (cn) => derSeq(derSet(derSeq(derOid(OID_COMMON_NAME), derUtf8(cn))));

// `serial` is injectable so a test can pin the byte patterns that used to break
// the encoder; production callers always let it be random.
// `validity` defaults to the stub IdP's one day; a negative `validDays` mints a
// certificate that has already expired.
export function selfSignedCertificate(publicKey, privateKey, commonName, serial = crypto.randomBytes(8), validity = {}) {
  const algorithm = derSeq(derOid(OID_SHA256_RSA), derNull());
  const now = Date.now();
  const notBefore = validity.notBefore ?? new Date(now - 60_000);
  const notAfter = validity.notAfter ?? new Date(now + 86_400_000);
  const tbs = derSeq(
    der(0xa0, derInt(2)), // [0] EXPLICIT version, v3
    derInt(serial),
    algorithm,
    derName(commonName), // issuer == subject (self-signed)
    derSeq(derUtcTime(notBefore), derUtcTime(notAfter)),
    derName(commonName),
    publicKey.export({ type: 'spki', format: 'der' })
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const body = derSeq(tbs, algorithm, derBitString(signature))
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}


let sharedKey;

/**
 * A fresh self-signed certificate valid for `validDays` days from now (an hour
 * of slack past the day, so "30 days" reads as 30 whole days left), or expired
 * `-validDays` days ago when negative. One RSA key per process, reused — key
 * generation is the slow part and the key never signs anything here.
 */
export function testCertificate(validDays = 365, commonName = 'e2e-test-idp') {
  sharedKey ??= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Date.now();
  const notAfter = new Date(now + validDays * 86_400_000 + 3_600_000);
  const notBefore = new Date(Math.min(now - 60_000, notAfter.getTime() - 86_400_000));
  const pem = selfSignedCertificate(sharedKey.publicKey, sharedKey.privateKey, commonName, undefined, { notBefore, notAfter });
  new crypto.X509Certificate(pem); // throws if the DER is wrong
  return pem;
}

/** SAML 2.0 IdP metadata carrying `certificate`, as an IdP export looks. */
export function idpMetadataXml({ entityId, ssoUrl, sloUrl, certificate }) {
  const body = certificate.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
${sloUrl ? `    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sloUrl}"/>\n` : ''}    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${ssoUrl}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>
`;
}
