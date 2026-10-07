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
  crmBccInboundNotes,
  crmBccNotes,
  crmBccPayload,
  customerAddresses,
  extractCrmBccToken,
  hasReplyToken,
  isCrmBccSender,
  mailDate,
  nextCrmBccVersion,
  parseCrmBccPayload,
  isForwardSubject,
  parseForwardedDate,
  parseForwardedHeaders,
  pickRelation,
  stripForwardPrefix,
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

// ── Forwarded customer replies (#2815) — a corpus of real client formats ──

const FORWARDS = {
  gmail: {
    subject: 'Fwd: Re: Angebot Q4',
    text: 'FYI\n\n---------- Forwarded message ---------\nFrom: Hans Kunde <hans@shop.de>\nDate: Mon, Oct 5, 2026 at 9:00 AM\nSubject: Re: Angebot Q4\nTo: Rep <rep@vendor.de>\n\nPasst, bitte Vertrag schicken.',
    want: { email: 'hans@shop.de', subject: 'Re: Angebot Q4', dateParses: true },
  },
  outlookDe: {
    subject: 'WG: Angebot Q4',
    text: 'Siehe unten\r\n\r\n________________________________\r\nVon: Hans Kunde <hans@shop.de>\r\nGesendet: Montag, 5. Oktober 2026 09:00\r\nAn: Rep <rep@vendor.de>\r\nBetreff: AW: Angebot Q4\r\n\r\nPasst.',
    want: { email: 'hans@shop.de', subject: 'AW: Angebot Q4', dateParses: false },
  },
  outlookEnBold: {
    subject: 'FW: Offer',
    text: '\n*From:* Hans Kunde [mailto:hans@shop.de]\n*Sent:* Monday, October 5, 2026 9:00 AM\n*To:* rep@vendor.de\n*Subject:* RE: Offer\n\nok',
    want: { email: 'hans@shop.de', subject: 'RE: Offer', dateParses: true },
  },
  appleMail: {
    subject: 'Fwd: Offer',
    text: 'Begin forwarded message:\n\n> From: Hans Kunde <hans@shop.de>\n> Subject: Re: Offer\n> Date: 5 October 2026 at 09:00:00 CEST\n> To: rep@vendor.de\n\n> ok',
    want: { email: 'hans@shop.de', subject: 'Re: Offer', dateParses: false },
  },
  outlookTr: {
    subject: 'İLT: Teklif',
    text: '-----Orijinal İleti-----\nKimden: Hans Kunde <hans@shop.de>\nGönderildi: 5 Ekim 2026 Pazartesi 09:00\nKime: rep@vendor.de\nKonu: YNT: Teklif\n\ntamam',
    want: { email: 'hans@shop.de', subject: 'YNT: Teklif', dateParses: false },
  },
};

for (const [name, f] of Object.entries(FORWARDS)) {
  test(`forwarded header block is read: ${name}`, () => {
    const got = parseForwardedHeaders(f.text, f.subject);
    assert.ok(got, 'a forward was found');
    assert.equal(addressesIn(got.from)[0], f.want.email);
    assert.equal(got.subject, f.want.subject);
    assert.equal(parseForwardedDate(got.date) !== null, f.want.dateParses);
  });
}

test('a plain mail, or a quoted From: in an ordinary reply, is not a forward', () => {
  assert.equal(parseForwardedHeaders('Hallo,\nwie besprochen.\nGruß', 'Angebot'), null);
  assert.equal(parseForwardedHeaders('From: hans@shop.de\nhi', 'Angebot'), null);
  assert.equal(parseForwardedHeaders('', 'Fwd: x'), null);
  assert.equal(parseForwardedHeaders('---------- Forwarded message ---------\nFrom: nobody\n', 'Fwd: x'), null);
});

test('forward subjects and their prefixes', () => {
  for (const s of ['Fwd: x', 'FW: x', 'WG: x', 'İlt: x', 'ilt: x', 'TR: x']) assert.equal(isForwardSubject(s), true, s);
  assert.equal(isForwardSubject('Re: x'), false);
  assert.equal(isForwardSubject('Forwarding plan'), false);
  assert.equal(stripForwardPrefix('Fwd: Re: WG: AW: Angebot'), 'Angebot');
  assert.equal(stripForwardPrefix(null), '');
});

test('Gmail\'s "at" date form parses; nonsense does not', () => {
  assert.equal(parseForwardedDate('Mon, Oct 5, 2026 at 9:00 AM').getFullYear(), 2026);
  assert.equal(parseForwardedDate('gestern'), null);
  assert.equal(parseForwardedDate(null), null);
});

test('inbound notes name the customer only', () => {
  assert.equal(crmBccInboundNotes('hans@shop.de'), 'BCC ← hans@shop.de');
});
