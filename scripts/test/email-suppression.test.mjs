// Unit tests for the bounce/complaint suppression rules (#1692).
//
// Run: npm run test:email-suppression  (node --test --experimental-strip-types)
//
// Pinned without a database: the address normalisation (case/whitespace), the
// provider normalisers (Brevo, generic), the policy (hard bounce and complaint
// suppress at once, a soft bounce only at the threshold), the reason ranking,
// the credential check (fails closed in production) and where a secret may be
// presented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOFT_BOUNCE_THRESHOLD,
  MAX_EVENTS_PER_REQUEST,
  cleanReleaseReason,
  delistNeedsConfirmation,
  derivedEventId,
  normaliseWebhookBody,
  normalizeSuppressedAddress,
  presentedSecrets,
  reasonAfter,
  suppressedLogReason,
  suppressionFor,
  webhookCredentialOk,
} from '../../src/lib/emailSuppressionRule.ts';

const eq = (a, b) => a === b;
const headers = (h) => ({ get: (n) => h[n.toLowerCase()] ?? null });

test('an address is matched trimmed and lower-cased', () => {
  assert.equal(normalizeSuppressedAddress('  Dead.Box@Example.TEST \n'), 'dead.box@example.test');
  assert.equal(normalizeSuppressedAddress('a@b'), 'a@b');
  for (const bad of ['', '   ', 'no-at-sign', '@example.test', 'x@', 'a b@example.test', 42, null, 'x'.repeat(320) + '@e.test']) {
    assert.equal(normalizeSuppressedAddress(bad), null, String(bad));
  }
});

test('policy: hard bounce and complaint suppress at once, soft only at the threshold', () => {
  assert.equal(suppressionFor({ type: 'bounce', hard: true }, 0), 'HARD_BOUNCE');
  assert.equal(suppressionFor({ type: 'complaint', hard: false }, 0), 'COMPLAINT');
  assert.equal(suppressionFor({ type: 'bounce', hard: false }, 1), null);
  assert.equal(suppressionFor({ type: 'bounce', hard: false }, SOFT_BOUNCE_THRESHOLD - 1), null);
  assert.equal(suppressionFor({ type: 'bounce', hard: false }, SOFT_BOUNCE_THRESHOLD), 'SOFT_BOUNCE_REPEATED');
});

test('a stored reason only ever moves up', () => {
  assert.equal(reasonAfter(null, 'SOFT_BOUNCE_REPEATED'), 'SOFT_BOUNCE_REPEATED');
  assert.equal(reasonAfter('SOFT_BOUNCE_REPEATED', 'HARD_BOUNCE'), 'HARD_BOUNCE');
  assert.equal(reasonAfter('HARD_BOUNCE', 'COMPLAINT'), 'COMPLAINT');
  assert.equal(reasonAfter('COMPLAINT', 'HARD_BOUNCE'), 'COMPLAINT');
  assert.equal(reasonAfter('HARD_BOUNCE', 'SOFT_BOUNCE_REPEATED'), 'HARD_BOUNCE');
});

test('Brevo: the four address events are read, the rest ignored, the id is stable', () => {
  const body = [
    { event: 'hard_bounce', email: ' Gone@Example.TEST', 'message-id': '<m1@x>', ts_event: 1700000000, reason: '550 5.1.1 user unknown' },
    { event: 'soft_bounce', email: 'full@example.test', 'message-id': '<m2@x>', ts_event: 1700000001 },
    { event: 'spam', email: 'angry@example.test', 'message-id': '<m3@x>', ts_event: 1700000002 },
    { event: 'invalid_email', email: 'typo@example.test', 'message-id': '<m4@x>' },
    { event: 'delivered', email: 'ok@example.test' },
    { event: 'blocked', email: 'blocked@example.test' },
  ];
  const r = normaliseWebhookBody('brevo', body);
  assert.equal(r.ok, true);
  assert.equal(r.ignored, 2);
  assert.deepEqual(
    r.events.map((e) => [e.email, e.type, e.hard]),
    [
      ['gone@example.test', 'bounce', true],
      ['full@example.test', 'bounce', false],
      ['angry@example.test', 'complaint', true],
      ['typo@example.test', 'bounce', true],
    ],
  );
  assert.equal(r.events[0].detail, '550 5.1.1 user unknown');
  // The same event twice yields the same id (the idempotency key) …
  const again = normaliseWebhookBody('brevo', body[0]);
  assert.equal(again.events[0].eventId, r.events[0].eventId);
  // … and another message's event a different one.
  assert.notEqual(r.events[0].eventId, r.events[1].eventId);
  assert.match(r.events[0].eventId, /^sha256:[0-9a-f]{64}$/);
});

test('generic: id + email + type, a complaint is always hard', () => {
  const r = normaliseWebhookBody('generic', { events: [
    { id: 'e1', email: 'A@Example.test', type: 'bounce', hard: true, detail: 'no such user' },
    { id: 'e2', email: 'b@example.test', type: 'complaint' },
    { id: 'e3', email: 'c@example.test', type: 'bounce' },
    { id: 'e4', email: 'd@example.test', type: 'delivered' },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.ignored, 1);
  assert.deepEqual(r.events.map((e) => [e.eventId, e.email, e.type, e.hard]), [
    ['e1', 'a@example.test', 'bounce', true],
    ['e2', 'b@example.test', 'complaint', true],
    ['e3', 'c@example.test', 'bounce', false],
  ]);
});

test('a malformed body is refused whole', () => {
  assert.deepEqual(normaliseWebhookBody('generic', null), { ok: false, error: 'invalid_payload' });
  assert.deepEqual(normaliseWebhookBody('generic', []), { ok: false, error: 'invalid_payload' });
  assert.deepEqual(normaliseWebhookBody('generic', 'x'), { ok: false, error: 'invalid_payload' });
  assert.deepEqual(normaliseWebhookBody('generic', [{ id: 'e1', email: 'nope', type: 'bounce' }]), { ok: false, error: 'invalid_payload' });
  assert.deepEqual(normaliseWebhookBody('generic', [{ email: 'a@b.test', type: 'bounce' }]), { ok: false, error: 'invalid_payload' });
  assert.deepEqual(normaliseWebhookBody('brevo', [{ email: 'a@b.test' }]), { ok: false, error: 'invalid_payload' });
  assert.deepEqual(normaliseWebhookBody('brevo', [{ event: 'hard_bounce', email: 'nope' }]), { ok: false, error: 'invalid_payload' });
  assert.deepEqual(normaliseWebhookBody('generic', [1]), { ok: false, error: 'invalid_payload' });
  const many = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, (_, i) => ({ id: `e${i}`, email: 'a@b.test', type: 'bounce' }));
  assert.deepEqual(normaliseWebhookBody('generic', many), { ok: false, error: 'too_many_events' });
});

test('the credential check fails closed in production', () => {
  assert.equal(webhookCredentialOk({ expected: undefined, presented: [], production: true }, eq), false);
  assert.equal(webhookCredentialOk({ expected: undefined, presented: [], production: false }, eq), true);
  assert.equal(webhookCredentialOk({ expected: 's3cret', presented: [], production: false }, eq), false);
  assert.equal(webhookCredentialOk({ expected: 's3cret', presented: ['wrong', 's3cret'], production: true }, eq), true);
  assert.equal(webhookCredentialOk({ expected: 's3cret', presented: [''], production: true }, eq), false);
});

test('a secret may arrive as our header, a bearer token or a Basic password', () => {
  assert.deepEqual(presentedSecrets(headers({ 'x-webhook-secret': 'h' })), ['h']);
  assert.deepEqual(presentedSecrets(headers({ authorization: 'Bearer tok' })), ['tok']);
  const basic = 'Basic ' + Buffer.from('brevo:pw:with:colons').toString('base64');
  assert.deepEqual(presentedSecrets(headers({ authorization: basic })), ['pw:with:colons']);
  assert.deepEqual(presentedSecrets(headers({ authorization: 'Digest abc' })), []);
  assert.deepEqual(presentedSecrets(headers({})), []);
});

test('the small helpers', () => {
  assert.equal(suppressedLogReason('HARD_BOUNCE'), 'Suppressed: HARD_BOUNCE');
  assert.equal(delistNeedsConfirmation('COMPLAINT'), true);
  assert.equal(delistNeedsConfirmation('HARD_BOUNCE'), false);
  assert.equal(cleanReleaseReason('  mailbox fixed  '), 'mailbox fixed');
  assert.equal(cleanReleaseReason('no'), null);
  assert.equal(cleanReleaseReason('x'.repeat(501)), null);
  assert.equal(cleanReleaseReason(7), null);
  assert.equal(derivedEventId(['a', null]), derivedEventId(['a', '']));
  assert.notEqual(derivedEventId(['ab', 'c']), derivedEventId(['a', 'bc']));
});
