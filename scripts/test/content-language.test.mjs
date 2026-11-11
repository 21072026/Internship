// Unit tests for the language of user-written text (#3283, WCAG 3.1.2) —
// src/lib/contentLanguage.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The module's one rule is "no answer rather than a wrong one": a wrong `lang`
// makes a screen reader pronounce the text in the wrong voice. So this file
// pins both halves — sentences that must be recognised, and texts that must
// come back null (too short, mixed, names, links, shared words only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContentLanguage, contentLang } from '../../src/lib/contentLanguage.ts';

const RECOGNISED = {
  en: [
    'Thanks for the update, I will send you the documents by Friday.',
    'Could we move our meeting to next week? Tuesday works for me.',
    'Hi, I have a question about the internship and the next steps.',
    'Please have a look at my CV and let me know what you think.',
  ],
  tr: [
    'Merhaba, belgeleri bu hafta içinde göndereceğim.',
    'Görüşmeyi haftaya alabilir miyiz? Salı benim için uygun.',
    'Teşekkür ederim, çok yardımcı oldunuz.',
    'Staj başvurum hakkında bir sorum var.',
    'İyi günler, yarın saat onda müsait misiniz?',
  ],
  de: [
    'Danke für die schnelle Antwort, ich schicke Ihnen die Unterlagen morgen.',
    'Können wir das Treffen auf nächste Woche verschieben?',
    'Hallo, ich habe noch eine Frage zum Praktikum.',
    'Viele Grüße und bis bald.',
  ],
};

for (const [lang, texts] of Object.entries(RECOGNISED)) {
  for (const text of texts) {
    test(`recognised as ${lang}: ${text}`, () => {
      assert.equal(detectContentLanguage(text), lang);
    });
  }
}

const UNMARKED = [
  ['empty', ''],
  ['null', null],
  ['one word', 'Danke!'],
  ['two words', 'Thank you'],
  ['a name', 'Ayşe Gül Şahin'],
  ['a name in a short line', 'Mehmet Öztürk'],
  ['a link only', 'https://example.test/path?q=1'],
  ['an address', 'contact@example.test'],
  ['emoji and digits', '👍 👍 12:30 2026-11-11'],
  ['numbers and a link', 'See https://example.test 123 456'],
  ['mixed EN/DE evenly', 'Thanks and danke und the'],
  ['shared words only', 'in an so'],
  ['product names', 'Slack Teams Jira Zoom'],
];

for (const [label, text] of UNMARKED) {
  test(`no language for ${label}`, () => {
    assert.equal(detectContentLanguage(text), null);
  });
}

test('the Turkish dotted capital İ does not hide a Turkish word', () => {
  assert.equal(detectContentLanguage('İYİ GÜNLER, BU HAFTA GÖRÜŞME VAR MI?'), 'tr');
});

test('links and addresses do not count as words', () => {
  // Three English words would be enough; the link and address add none.
  assert.equal(detectContentLanguage('https://a.test/the/and/is x@y.test'), null);
});

test('contentLang prefers a known language and renders nothing when unsure', () => {
  assert.equal(contentLang('Danke!', 'de'), 'de');
  assert.equal(contentLang('Danke!'), undefined);
  assert.equal(contentLang('Merhaba, bu hafta görüşme için uygun musun?'), 'tr');
  assert.equal(contentLang(null), undefined);
});
