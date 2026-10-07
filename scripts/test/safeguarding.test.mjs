// Safeguarding detection (#2056) — the corpus the rule is tuned against.
//
// False positives are the real failure mode: a queue full of dates, prices and
// order numbers is a queue nobody reads. So every POSITIVE group below has a
// NEGATIVE group next to it in the same language, and a change that widens a
// pattern has to keep both green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const {
  detectContactDetails,
  matchWatchKeywords,
  parseWatchKeywords,
  serializeWatchKeywords,
  scanMessageBody,
  maskContact,
  messageRetentionCutoff,
  MESSAGE_RETENTION_FLOOR_DAYS,
  WATCH_KEYWORD_LIMITS,
} = await import('../../src/lib/safeguarding.ts');

const kinds = (body) => detectContactDetails(body).map((m) => m.kind);

// ── Contact details: must flag ──────────────────────────────────────────────

const POSITIVE = {
  en: [
    ['Text me on +44 7700 900123 tonight', 'phone'],
    ['my number is 07700 900123', 'phone'],
    ['call (555) 123-4567 after class', 'phone'],
    ['write to jane.doe@example.com instead', 'email'],
    ['jane dot doe at example dot com', 'email'],
    ['reach me: jane [at] example [dot] com', 'email'],
    ['it is five five five one two three four five six seven', 'phone'],
    ['0044-7700-900-123 is my WhatsApp', 'phone'],
  ],
  tr: [
    ['Beni 0532 123 45 67 numarasından ara', 'phone'],
    ['numaram +90 532 123 45 67', 'phone'],
    ['numaram sıfır beş üç iki bir iki üç dört beş altı yedi', 'phone'],
    ['mail adresim ayse.yilmaz@ornek.com.tr', 'email'],
    ['ayse(at)ornek.com.tr adresine yaz', 'email'],
    ['0 5 3 2 1 2 3 4 5 6 7 yaz bana', 'phone'],
  ],
  de: [
    ['Ruf mich unter 0176 12345678 an', 'phone'],
    ['meine Nummer: +49 (0)176 1234 5678', 'phone'],
    ['schreib an max.mustermann@beispiel.de', 'email'],
    ['max ät beispiel punkt de', 'email'],
    ['null eins sieben sechs eins zwei drei vier fünf sechs', 'phone'],
    ['Festnetz 030/1234567', 'phone'],
  ],
};

for (const [lang, cases] of Object.entries(POSITIVE)) {
  test(`contact details are detected (${lang})`, () => {
    for (const [body, kind] of cases) {
      assert.ok(kinds(body).includes(kind), `expected ${kind} in: ${body} → ${JSON.stringify(detectContactDetails(body))}`);
    }
  });
}

// ── Contact details: must NOT flag ──────────────────────────────────────────

const NEGATIVE = {
  en: [
    'See you on 07.10.2026 at 14:30',
    'The meeting is 2026-10-07, room 101',
    'Salary range is $55,000 to $65,000 per year',
    'Order number 123456789 was shipped',
    'Version 1.2.3 fixed it, see v2.0.1',
    'I scored 95 out of 100 and ranked 3 of 40',
    'meet me at home dot five',
    'Office hours 9.30-11.00 on Mondays',
    'I had one or two questions about the role',
    'IBAN DE89 3704 0044 0532 0130 00 for the stipend',
  ],
  tr: [
    'Toplantı 07.10.2026 saat 14:30’da',
    'Maaş aralığı 45.000 TL ile 55.000 TL arası',
    'Bir iki soru sormak istiyorum',
    'Staj 3 ay sürecek, haftada 20 saat',
    'Başvuru numarası 2026-000123',
  ],
  de: [
    'Termin am 7.10.2026 um 9:30 Uhr',
    'Das Gehalt liegt bei 3.500 € brutto',
    'Ich habe ein, zwei Fragen zum Praktikum',
    'Raum 2.041 im zweiten Stock',
    'Rechnung INV-004912345 ist bezahlt',
  ],
};

for (const [lang, cases] of Object.entries(NEGATIVE)) {
  test(`ordinary text is not flagged as a contact detail (${lang})`, () => {
    for (const body of cases) {
      assert.deepEqual(detectContactDetails(body), [], `false positive in: ${body}`);
    }
  });
}

test('spans point at the text as written', () => {
  const body = 'hi! call 0176 12345678 later';
  const [m] = detectContactDetails(body);
  assert.equal(body.slice(m.start, m.end), m.text);
  assert.equal(m.text, '0176 12345678');
});

// ── Watch keywords ──────────────────────────────────────────────────────────

test('keywords match whole words, case- and accent-insensitively, in three languages', () => {
  const kws = ['secret', 'kişisel', 'Treffen', 'meet alone'];
  assert.equal(matchWatchKeywords('Keep this a SECRET between us', kws).length, 1);
  assert.equal(matchWatchKeywords('KİŞİSEL bir şey soracağım', kws).length, 1);
  assert.equal(matchWatchKeywords('Lass uns privat treffen', kws).length, 1);
  assert.equal(matchWatchKeywords('we could meet   alone after', kws).length, 1);
  const [hit] = matchWatchKeywords('Keep this a SECRET between us', kws);
  assert.equal(hit.keyword, 'secret');
  assert.match(hit.context, /SECRET/);
});

test('keywords never match inside another word', () => {
  const kws = ['art', 'sex', 'treff'];
  assert.deepEqual(matchWatchKeywords('the party starts at six', kws), []);
  assert.deepEqual(matchWatchKeywords('Middlesex University', kws), []);
  assert.deepEqual(matchWatchKeywords('Treffpunkt ist der Haupteingang', kws), []);
});

test('the watch list parser trims, folds duplicates and enforces the limits', () => {
  const parsed = parseWatchKeywords('secret\n Secret \nkişisel, KİŞİSEL\na\n\n' + 'x'.repeat(61));
  assert.deepEqual(parsed, ['secret', 'kişisel']);
  const many = Array.from({ length: 150 }, (_, i) => `word${i}`).join('\n');
  assert.equal(parseWatchKeywords(many).length, WATCH_KEYWORD_LIMITS.maxKeywords);
  assert.equal(serializeWatchKeywords(['b', 'secret', 'secret']), 'secret');
});

// ── The scan and what it stores ─────────────────────────────────────────────

test('a scan stores a masked contact detail, never the number itself', () => {
  const findings = scanMessageBody('call 0176 12345678 or 0176 12345678', { keywords: [] });
  assert.equal(findings.length, 1, 'one finding per distinct term');
  assert.equal(findings[0].kind, 'CONTACT_DETAIL');
  assert.ok(!findings[0].matchedTerm.includes('12345678'));
  assert.equal(maskContact('0176 12345678'), '01•• ••••••78');
});

test('e-mail-channel messages skip contact details but still check keywords', () => {
  const body = 'Thanks!\n--\nJane Doe | +49 176 1234 5678 | jane@example.com\nlet us keep it secret';
  const findings = scanMessageBody(body, { keywords: ['secret'], skipContactDetails: true });
  assert.deepEqual(findings.map((f) => f.kind), ['KEYWORD']);
});

// ── Retention cutoff ────────────────────────────────────────────────────────

test('retention: 0 keeps forever, a short window is raised to the floor', () => {
  const now = new Date('2026-10-07T00:00:00Z');
  assert.equal(messageRetentionCutoff(now, 0), null);
  assert.equal(messageRetentionCutoff(now, -5), null);
  assert.equal(messageRetentionCutoff(now, Number.NaN), null);
  const floor = messageRetentionCutoff(now, 3);
  assert.equal(now.getTime() - floor.getTime(), MESSAGE_RETENTION_FLOOR_DAYS * 86_400_000);
  const year = messageRetentionCutoff(now, 365);
  assert.equal(now.getTime() - year.getTime(), 365 * 86_400_000);
});
