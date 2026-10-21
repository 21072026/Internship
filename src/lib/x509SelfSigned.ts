// A self-signed X.509 certificate for a key pair we generate (#1952). Node can
// generate an RSA key pair but cannot wrap the public half in a certificate,
// and SAML metadata publishes certificates, not bare keys — so this is the
// ~60 lines of DER it takes, the same encoder the e2e stub IdP has used since
// #1936 (e2e/support/idp-mock.mjs, its INTEGER rule pinned by
// scripts/test/idp-mock-der.test.mjs). Verified by `new X509Certificate()` on
// every call, which throws if any byte of it is malformed.
//
// Server-only (node crypto). Dependency-free, so the unit runner loads it.

import { X509Certificate, randomBytes, sign, type KeyObject } from 'node:crypto';

function der(tag: number, body: Buffer): Buffer {
  const len = body.length;
  let lenBytes: Buffer;
  if (len < 0x80) {
    lenBytes = Buffer.from([len]);
  } else {
    const b: number[] = [];
    let n = len;
    while (n > 0) {
      b.unshift(n & 0xff);
      n >>>= 8;
    }
    lenBytes = Buffer.from([0x80 | b.length, ...b]);
  }
  return Buffer.concat([Buffer.from([tag]), lenBytes, body]);
}
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => der(0x31, Buffer.concat(parts));
const nul = () => der(0x05, Buffer.alloc(0));
const utf8 = (s: string) => der(0x0c, Buffer.from(s, 'utf8'));
const bitString = (buf: Buffer) => der(0x03, Buffer.concat([Buffer.from([0]), buf]));

function oid(dotted: string): Buffer {
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

// DER INTEGER: minimal two's complement — strip redundant leading zeros, THEN
// pad for the sign bit (the order matters, #2251).
export function derInt(value: Buffer | number): Buffer {
  let b = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  let i = 0;
  while (i + 1 < b.length && b[i] === 0 && !(b[i + 1] & 0x80)) i += 1;
  if (i) b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return der(0x02, b);
}

// UTCTime covers 1950–2049; a validity reaching 2050 or later is GeneralizedTime.
function time(date: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const rest = `${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  const year = date.getUTCFullYear();
  if (year >= 2050) return der(0x18, Buffer.from(`${year}${rest}`, 'ascii'));
  return der(0x17, Buffer.from(`${p(year % 100)}${rest}`, 'ascii'));
}

const OID_COMMON_NAME = '2.5.4.3';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const name = (cn: string) => seq(set(seq(oid(OID_COMMON_NAME), utf8(cn))));

/** A PEM certificate for an RSA key pair, issuer == subject == `commonName`. */
export function selfSignedCertificate(
  publicKey: KeyObject,
  privateKey: KeyObject,
  commonName: string,
  validity: { notBefore: Date; notAfter: Date },
  serial: Buffer = randomBytes(8),
): string {
  const algorithm = seq(oid(OID_SHA256_RSA), nul());
  const tbs = seq(
    der(0xa0, derInt(2)), // [0] EXPLICIT version, v3
    derInt(serial),
    algorithm,
    name(commonName),
    seq(time(validity.notBefore), time(validity.notAfter)),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const body = seq(tbs, algorithm, bitString(signature)).toString('base64').match(/.{1,64}/g)!.join('\n');
  const pem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(pem); // throws if the DER above is wrong
  return pem;
}
