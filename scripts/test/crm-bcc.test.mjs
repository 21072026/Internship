// Unit tests for src/lib/crmBccRule.ts — BCC-to-CRM (#2809): finding the
// address, which recipients are the customer's, which funnel record gets the
// log, what the log holds, and who may log.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  CRM_BCC_SUBJECT_MAX,
  addressesIn,
  clipSubject,
  crmBccEnabledFor,
  crmBccNotes,
  crmBccPayload,
  customerAddresses,
  extractCrmBccToken,
  hasReplyToken,
  isCrmBccSender,
  mailDate,
  nextCrmBccVersion,
  parseCrmBccPayload,
  pickRelation,
} = await import('../../src/lib/crmBccRule.ts');

test('the crm+ token is found in any recipient header, not inside a longer local part', () => {
  assert.equal(extractCrmBccToken('Kunde <k@shop.de>, crm+org1~1.abc@in.example.com'), 'org1~1.abc');
  assert.equal(extractCrmBccToken('Delivered-To: <CRM+org1~2.ff@in.example.com>'), 'org1~2.ff');
  assert.equal(extractCrmBccToken('xcrm+org1~1.abc@in.example.com'), null);
  assert.equal(extractCrmBccToken('reply+rel.sig@in.example.com'), null);
  assert.equal(extractCrmBccToken(''), null);
});

test('a reply+ address is recognised, so the thread path keeps priority', () => {
  assert.equal(hasReplyToken('reply+rel~u.sig@in.example.com crm+o~1.s@in.example.com'), true);
  assert.equal(hasReplyToken('crm+o~1.s@in.example.com'), false);
  assert.equal(hasReplyToken('noreply+x@in.example.com'), false);
});

test('payload round-trips and refuses a missing or non-numeric version', () => {
  assert.deepEqual(parseCrmBccPayload(crmBccPayload('org1', '3')), { orgId: 'org1', version: '3' });
  assert.equal(parseCrmBccPayload('org1'), null);
  assert.equal(parseCrmBccPayload('~1'), null);
  assert.equal(parseCrmBccPayload('org1~'), null);
  assert.equal(parseCrmBccPayload('org1~0'), null);
  assert.equal(parseCrmBccPayload('org1~x'), null);
});

test('rotation bumps the version; a broken stored value restarts at 2', () => {
  assert.equal(nextCrmBccVersion('1'), '2');
  assert.equal(nextCrmBccVersion('41'), '42');
  assert.equal(nextCrmBccVersion(''), '2');
  assert.equal(nextCrmBccVersion('abc'), '2');
});

test('addresses are extracted lower-cased and de-duplicated', () => {
  assert.deepEqual(addressesIn('"Müller, Hans" <Hans@Shop.DE>, hans@shop.de; b@x.io'), ['hans@shop.de', 'b@x.io']);
  assert.deepEqual(addressesIn(null), []);
});

test('customer addresses: To + Cc minus our mailbox and the sender', () => {
  const got = customerAddresses({
    to: 'Kunde <k@shop.de>, crm+o~1.s@in.example.com, reply+r.s@other.io',
    cc: 'chef@shop.de, rep@vendor.de, box@in.example.com',
    from: 'Rep <Rep@Vendor.de>',
    inboundDomain: 'IN.example.com',
  });
  assert.deepEqual(got, ['k@shop.de', 'chef@shop.de']);
});

test('subject is collapsed and clipped; empty is null', () => {
  assert.equal(clipSubject('  Angebot \n  Q4  '), 'Angebot Q4');
  assert.equal(clipSubject('   '), null);
  assert.equal(clipSubject(undefined), null);
  const long = clipSubject('x'.repeat(500));
  assert.equal(long.length, CRM_BCC_SUBJECT_MAX);
  assert.ok(long.endsWith('…'));
});

test('mail date: the header unless missing, broken or more than a day ahead', () => {
  const now = new Date('2026-10-06T10:00:00Z');
  assert.equal(mailDate('Mon, 05 Oct 2026 09:00:00 +0200', now).toISOString(), '2026-10-05T07:00:00.000Z');
  assert.equal(mailDate(null, now), now);
  assert.equal(mailDate('not a date', now), now);
  assert.equal(mailDate('2026-10-09T10:00:00Z', now), now);
  assert.equal(mailDate('2026-10-06T20:00:00Z', now).toISOString(), '2026-10-06T20:00:00.000Z');
});

test('notes hold a fixed marker and the matched recipients — nothing else', () => {
  assert.equal(crmBccNotes(['a@x.de', 'b@x.de']), 'BCC → a@x.de, b@x.de');
});

test('the sender’s own active record wins; otherwise the account’s newest', () => {
  const d = (s) => new Date(s);
  const rels = [
    { id: 'old-mine', mentorId: 'me', createdAt: d('2026-01-01') },
    { id: 'new-other', mentorId: 'you', createdAt: d('2026-09-01') },
    { id: 'mid-mine', mentorId: 'me', createdAt: d('2026-05-01') },
  ];
  assert.equal(pickRelation(rels, 'me'), 'mid-mine');
  assert.equal(pickRelation(rels, 'stranger'), 'new-other');
  assert.equal(pickRelation([], 'me'), null);
});

test('only active admins and reps may log', () => {
  assert.equal(isCrmBccSender({ role: 'ADMIN', isActive: true }), true);
  assert.equal(isCrmBccSender({ role: 'MENTOR', isActive: true }), true);
  assert.equal(isCrmBccSender({ role: 'MENTOR', isActive: false }), false);
  assert.equal(isCrmBccSender({ role: 'MENTEE', isActive: true }), false);
  assert.equal(isCrmBccSender(null), false);
});

test('on by default for MARKETING only; an explicit choice wins either way', () => {
  assert.equal(crmBccEnabledFor('', 'MARKETING'), true);
  assert.equal(crmBccEnabledFor('', 'INTERNSHIP'), false);
  assert.equal(crmBccEnabledFor('true', 'INTERNSHIP'), true);
  assert.equal(crmBccEnabledFor('false', 'MARKETING'), false);
  assert.equal(crmBccEnabledFor('garbage', 'MARKETING'), true);
});
