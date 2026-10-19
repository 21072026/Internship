// Unit tests for src/lib/sourceSignatureRule.ts — the request signature of a
// registered integration source (#2978): the recipe pinned by fixed vectors
// (the first one is the test vector published in
// docs/integrations/account-events.md § Security, so a sender can check its own
// implementation against the same numbers), the verdict order, the clock skew
// and the rotation overlap. The route half (raw body, sealed secrets, answers)
// is e2e/account-events-security.spec.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rule = await import('../../src/lib/sourceSignatureRule.ts');

// The published vector.
const SECRET = 'isig_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TS = '1760000000';
const BODY = '{"event_id":"evt-2026-10-14-0001","schema_version":1}';
const SIGNATURE = 'sha256=55450b33e47867c5cc4804f3c452ff5c781d1dc251b6c15196ab40bd09682df3';
const NOW = Number(TS) * 1000;

test('the published test vector', () => {
  assert.equal(rule.computeSignature(SECRET, TS, BODY), SIGNATURE);
  // Bytes and string are the same thing to the recipe.
  assert.equal(rule.computeSignature(SECRET, TS, new TextEncoder().encode(BODY)), SIGNATURE);
  assert.deepEqual(rule.verifySourceSignature({ secrets: [SECRET], timestamp: TS, signature: SIGNATURE, rawBody: BODY, nowMs: NOW }), {
    ok: true,
    secretIndex: 0,
  });
});

test('the docs carry the same vector', () => {
  const doc = readFileSync(new URL('../../docs/integrations/account-events.md', import.meta.url), 'utf8');
  for (const piece of [SECRET, TS, BODY, SIGNATURE.slice('sha256='.length)]) assert.ok(doc.includes(piece), `docs miss ${piece}`);
});

test('a second fixed vector: a batch dry run, signed over its exact bytes', () => {
  const body = '{"events":[],"dry_run":true}';
  assert.equal(rule.computeSignature(SECRET, TS, body), 'sha256=d996264ed3b902e9f1fdeb4b9cc57f26ccbabd87ceff4dc4b21cb5e0a3afb880');
});

test('the signed bytes are "<timestamp>." followed by the raw body', () => {
  assert.equal(rule.signedPayload(TS, BODY).toString('utf8'), `${TS}.${BODY}`);
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]); // a BOM is part of the bytes
  assert.deepEqual([...rule.signedPayload('1', bytes)], [0x31, 0x2e, 0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
});

const verify = (over) => rule.verifySourceSignature({ secrets: [SECRET], timestamp: TS, signature: SIGNATURE, rawBody: BODY, nowMs: NOW, ...over });

test('a tampered body, timestamp or signature is bad_signature', () => {
  assert.deepEqual(verify({ rawBody: BODY.replace('0001', '0002') }), { ok: false, code: 'bad_signature' });
  assert.deepEqual(verify({ rawBody: `${BODY} ` }), { ok: false, code: 'bad_signature' });
  assert.deepEqual(verify({ timestamp: '1760000001' }), { ok: false, code: 'bad_signature' });
  assert.deepEqual(verify({ signature: SIGNATURE.replace(/.$/, '4') }), { ok: false, code: 'bad_signature' });
  assert.deepEqual(verify({ secrets: ['isig_another'] }), { ok: false, code: 'bad_signature' });
});

test('missing or malformed headers are bad_signature', () => {
  for (const signature of [null, undefined, '', 'sha256=', SIGNATURE.slice('sha256='.length), `sha1=${SIGNATURE.slice(7)}`, `${SIGNATURE}00`, 'sha256=zz' + SIGNATURE.slice(9)]) {
    assert.deepEqual(verify({ signature }), { ok: false, code: 'bad_signature' }, String(signature));
  }
  for (const timestamp of [null, undefined, '', '1760000000.0', '-1760000000', '1.76e9', 'now', '1234567890123']) {
    assert.deepEqual(verify({ timestamp }), { ok: false, code: 'bad_signature' }, String(timestamp));
  }
  // Upper-case hex and surrounding whitespace are the same signature.
  assert.equal(verify({ signature: `sha256=${SIGNATURE.slice(7).toUpperCase()}` }).ok, true);
  assert.equal(verify({ signature: ` ${SIGNATURE} `, timestamp: ` ${TS} ` }).ok, true);
});

test('no live secret verifies nothing (fail closed)', () => {
  assert.deepEqual(verify({ secrets: [] }), { ok: false, code: 'bad_signature' });
});

test(`clock skew: |now − timestamp| ≤ ${rule.SIGNATURE_MAX_SKEW_SECONDS} s, both directions`, () => {
  assert.equal(rule.SIGNATURE_MAX_SKEW_SECONDS, 300);
  const at = (deltaS) => verify({ nowMs: NOW + deltaS * 1000 });
  assert.equal(at(300).ok, true);
  assert.equal(at(-300).ok, true);
  assert.equal(at(300.999).ok, true); // whole seconds: the server floors its own clock
  assert.deepEqual(at(301), { ok: false, code: 'stale_signature' });
  assert.deepEqual(at(-301), { ok: false, code: 'stale_signature' });
});

test('the signature is judged before the clock: a bad signature never says stale', () => {
  assert.deepEqual(verify({ nowMs: NOW + 3600_000, rawBody: `${BODY}x` }), { ok: false, code: 'bad_signature' });
});

test('rotation: the previous secret verifies inside its overlap, never after', () => {
  assert.equal(rule.SIGNING_SECRET_OVERLAP_MS, 24 * 60 * 60 * 1000);
  const rotatedAt = NOW;
  const until = rule.overlapUntil(rotatedAt);
  assert.equal(until.getTime(), rotatedAt + rule.SIGNING_SECRET_OVERLAP_MS);
  const stored = { current: 'isig_new', previous: SECRET, previousUntil: until };
  assert.deepEqual(rule.liveSecrets(stored, rotatedAt + 1000), ['isig_new', SECRET]);
  assert.deepEqual(rule.liveSecrets(stored, until.getTime()), ['isig_new']);
  assert.deepEqual(rule.liveSecrets({ current: null, previous: SECRET, previousUntil: until }, rotatedAt), [SECRET]);
  assert.deepEqual(rule.liveSecrets({ current: null, previous: null, previousUntil: null }, rotatedAt), []);
  // The old secret signs a request: index 1 inside the window.
  assert.deepEqual(
    rule.verifySourceSignature({ secrets: rule.liveSecrets(stored, NOW + 1000), timestamp: TS, signature: SIGNATURE, rawBody: BODY, nowMs: NOW }),
    { ok: true, secretIndex: 1 },
  );
  assert.deepEqual(
    rule.verifySourceSignature({ secrets: rule.liveSecrets(stored, until.getTime() + 1), timestamp: TS, signature: SIGNATURE, rawBody: BODY, nowMs: NOW }),
    { ok: false, code: 'bad_signature' },
  );
});

test('a generated secret is isig_ + 64 hex and never repeats', () => {
  const a = rule.generateSigningSecret();
  const b = rule.generateSigningSecret();
  assert.match(a, /^isig_[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
