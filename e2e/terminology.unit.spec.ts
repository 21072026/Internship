import { test, expect } from '@playwright/test';
import { getDictionary } from '../src/i18n/dictionaries';
import { locales } from '../src/i18n/config';
import {
  applyTerminology,
  applyTerminologyMemo,
  parseTerminology,
  serializeTerminology,
  swapTerms,
  type Terminology,
} from '../src/lib/terminology';

// The terminology layer (#1629) — the rule alone, no browser and no database.
// A stored terminology becomes replaced whole strings over the dictionary; with
// nothing stored the dictionary is the very same object.

const COACH = { one: 'coach', many: 'coaches', oneCap: 'Coach', manyCap: 'Coaches' };
const STUDENT = { one: 'student', many: 'students', oneCap: 'Student', manyCap: 'Students' };

function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => strings(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => strings(n, out));
  return out;
}

test('nothing stored: every locale returns the dictionary itself, byte-identical', { tag: '@smoke' }, () => {
  for (const locale of locales) {
    const dict = getDictionary(locale);
    const before = JSON.stringify(dict);
    for (const terms of [undefined, null, {}, parseTerminology(''), { [locale]: {} }] as (Terminology | null | undefined)[]) {
      expect(applyTerminology(dict, locale, terms)).toBe(dict);
      expect(applyTerminologyMemo('k', dict, locale, terms)).toBe(dict);
    }
    // Another locale's override does not touch this one.
    const other = locales.find((l) => l !== locale)!;
    expect(applyTerminology(dict, locale, { [other]: { mentor: COACH } })).toBe(dict);
    expect(JSON.stringify(dict)).toBe(before);
  }
});

test('an org override renames the nouns and keeps every interpolation token', { tag: '@smoke' }, () => {
  const dict = getDictionary('en');
  const out = applyTerminology(dict, 'en', { en: { mentor: COACH, mentee: STUDENT } });
  expect(out).not.toBe(dict);
  expect(out.nav.mentors).toBe('Coaches');
  expect(out.nav.mentorDirectory).toBe('Coaches');
  // The base is shared process state and is never mutated.
  expect(dict.nav.mentors).toBe('Mentors');
  // Tokens such as {mentor} / {mentorName} survive in every string.
  const tokens = (s: string) => (s.match(/\{[^{}]*\}/g) ?? []).join('|');
  const a = strings(dict);
  const b = strings(out);
  expect(b.length).toBe(a.length);
  for (let i = 0; i < a.length; i++) expect(tokens(b[i])).toBe(tokens(a[i]));
});

test('only whole words: paths, hosts, tokens, compounds and suffixes are left alone', { tag: '@smoke' }, () => {
  const en = { mentor: COACH };
  expect(swapTerms('Your mentor. Mentors, mentor-led.', 'en', en)).toBe('Your coach. Coaches, coach-led.');
  expect(swapTerms('/mentor/requests', 'en', en)).toBe('/mentor/requests');
  expect(swapTerms('mentor.example and mentor@x.test', 'en', en)).toBe('mentor.example and mentor@x.test');
  expect(swapTerms('{mentor} met {mentorName}', 'en', en)).toBe('{mentor} met {mentorName}');
  expect(swapTerms('mentoring mentor_id', 'en', en)).toBe('mentoring mentor_id');
  // Programme and program are both the one form.
  expect(swapTerms('This programme, our program.', 'en', { program: { one: 'track', many: 'tracks', oneCap: 'Track', manyCap: 'Tracks' } })).toBe(
    'This track, our track.',
  );

  // Turkish: the stored inflection is used, a suffixed default is never half-built.
  const tr = { mentor: { one: 'koç', many: 'koçlar', oneCap: 'Koç', manyCap: 'Koçlar' } };
  expect(swapTerms('Mentorlar ve mentor', 'tr', tr)).toBe('Koçlar ve koç');
  expect(swapTerms("Mentor'un notu, mentorun mesajı, mentorluk", 'tr', tr)).toBe("Mentor'un notu, mentorun mesajı, mentorluk");

  // German: capitalised nouns, compounds untouched.
  const de = { mentor: { one: 'Coach', many: 'Coaches', oneCap: 'Coach', manyCap: 'Coaches' } };
  expect(swapTerms('Der Mentor und die Mentoren; Mentorenzeit', 'de', de)).toBe('Der Coach und die Coaches; Mentorenzeit');

  // A stored form containing `$&` prints as written.
  expect(swapTerms('mentor', 'en', { mentor: { ...COACH, one: 'a$&b' } })).toBe('a$&b');
});

test('a malformed or unknown stored value is dropped, never rendered, never thrown', { tag: '@smoke' }, () => {
  expect(parseTerminology('not json')).toEqual({});
  expect(parseTerminology('[1,2]')).toEqual({});
  expect(parseTerminology(42)).toEqual({});
  expect(parseTerminology(null)).toEqual({});
  const parsed = parseTerminology(
    JSON.stringify({
      en: {
        mentor: COACH,
        mentee: { one: 'student' }, // incomplete → dropped
        wizard: COACH, // unknown token → dropped
        cohort: { ...COACH, one: '{evil}' }, // braces would forge a token → dropped
        program: { ...COACH, one: 'x'.repeat(41) }, // too long → dropped
      },
      fr: { mentor: COACH }, // unknown locale → dropped
      de: 'nope',
    }),
  );
  expect(parsed).toEqual({ en: { mentor: COACH } });
  expect(serializeTerminology(parsed)).toBe(JSON.stringify({ en: { mentor: COACH } }));
  expect(serializeTerminology({})).toBe('');
  // Forms are trimmed.
  expect(parseTerminology({ en: { mentor: { ...COACH, one: '  coach ' } } }).en?.mentor?.one).toBe('coach');
});

test('the walk is memoised per base and terminology', { tag: '@smoke' }, () => {
  const dict = getDictionary('tr');
  const terms: Terminology = { tr: { mentee: { one: 'öğrenci', many: 'öğrenciler', oneCap: 'Öğrenci', manyCap: 'Öğrenciler' } } };
  const first = applyTerminologyMemo('INTERNSHIP\u0000x', dict, 'tr', terms);
  expect(first).not.toBe(dict);
  expect(applyTerminologyMemo('INTERNSHIP\u0000x', dict, 'tr', JSON.parse(JSON.stringify(terms)))).toBe(first);
});
