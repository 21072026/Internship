// The language of text people write (#3283, WCAG 3.1.2 Language of Parts).
//
// WHY THIS FILE EXISTS
//   The interface declares its language on <html>, but a message, a note or a
//   bio is written by a person, in whatever language they chose. A Turkish note
//   in an English session is read by a screen reader in the English voice
//   unless the element carries lang="tr". The language of such text is not
//   stored anywhere, so it is either KNOWN (an announcement translation the
//   admin filed under a locale) or DETECTED here.
//
// THE ONE RULE: NO ANSWER RATHER THAN A WRONG ONE
//   A wrong `lang` is worse than none: the screen reader then pronounces the
//   text with the wrong voice, which is exactly the harm the attribute exists
//   to prevent. So `detectContentLanguage()` answers only for the app's own
//   locales, only for text long enough to judge, and only when one language
//   clearly outweighs the others; everything else gets `null`, and `null`
//   renders no attribute at all (the element inherits the page's language,
//   which is today's behaviour). It never falls back to the author's or the
//   reader's interface language: a person with a Turkish interface often
//   writes in English or German (#3283).
//
// HOW IT JUDGES
//   Two kinds of evidence, both deliberately narrow:
//   * letters only one of the three languages uses — ğ ı ş ç for Turkish,
//     ß ä for German (ö and ü are shared by TR and DE, so they count for
//     neither);
//   * very common function words that do not exist, or mean nothing common,
//     in the other two (`the`, `ve`, `und` …). Words two of the languages
//     share (`in`, `an`, `so`, `was`, `die`/`da`/`de` …) are left out on purpose.
//   Then: at least MIN_WORDS words, a winning score of at least MIN_SCORE, and
//   at least DOMINANCE times the runner-up. Mixed-language text, a name, a
//   URL, an emoji or a one-word "Danke!" fall below the bar and stay unmarked.
//
// DEPENDENCY-FREE AND PURE
//   Runs identically on the server and in the browser and is unit-tested under
//   plain `node --test` (scripts/test/content-language.test.mjs) against a
//   corpus of sentences that must be recognised and texts that must not be.

import type { Locale } from '@/i18n/config';

const MIN_WORDS = 3;
const MIN_SCORE = 3;
const DOMINANCE = 3;
/** Long texts are judged on their opening; the evidence saturates quickly. */
const MAX_CHARS = 2000;

type Scored = 'en' | 'tr' | 'de';

const WORDS: Record<Scored, ReadonlySet<string>> = {
  en: new Set([
    'the', 'and', 'is', 'are', 'you', 'your', 'of', 'to', 'for', 'with', 'this', 'that', 'it', 'have', 'has',
    'be', 'will', 'not', 'on', 'at', 'we', 'can', 'my', 'our', 'they', 'from', 'would', 'could', 'should',
    'about', 'what', 'there', 'their', 'been', 'just', 'thanks', 'thank', 'please', 'hello', 'hi', 'yes',
    'if', 'or', 'but', 'me', 'he', 'she', 'how', 'when', 'next', 'week', 'meeting',
  ]),
  tr: new Set([
    've', 'bir', 'bu', 'için', 'ile', 'çok', 'ama', 'gibi', 'daha', 'ne', 'mi', 'mı', 'mu', 'mü', 'ben',
    'sen', 'biz', 'siz', 'onlar', 'var', 'yok', 'olarak', 'olan', 'şu', 'değil', 'merhaba', 'teşekkürler',
    'teşekkür', 'ederim', 'evet', 'hayır', 'nasıl', 'ki', 'her', 'sonra', 'kadar', 'bana', 'sana', 'benim',
    'senin', 'görüşme', 'hafta', 'haftaya', 'tamam', 'lütfen', 'şimdi', 'bugün', 'yarın', 'iyi', 'günler',
  ]),
  de: new Set([
    'der', 'und', 'ist', 'nicht', 'ich', 'sie', 'wir', 'ein', 'eine', 'einen', 'mit', 'für', 'auf', 'zu',
    'den', 'dem', 'des', 'auch', 'sich', 'von', 'bitte', 'danke', 'hallo', 'aber', 'oder', 'wie', 'sind',
    'haben', 'wird', 'noch', 'nach', 'bei', 'ihr', 'ihre', 'mein', 'meine', 'dein', 'deine', 'uns', 'euch',
    'schon', 'heute', 'morgen', 'woche', 'gerne', 'viele', 'grüße', 'gruß', 'das', 'dass', 'kann', 'können',
  ]),
};

/** Letters only one of the three languages writes. */
const LETTERS: Array<[RegExp, Scored]> = [
  [/[ğış]/g, 'tr'],
  [/ç/g, 'tr'],
  [/[ßä]/g, 'de'],
];

/**
 * The language of a piece of text people wrote, when it can be told with
 * confidence — otherwise `null` (see the header: no answer rather than a
 * wrong one). Only the app's own locales can come back.
 */
export function detectContentLanguage(text: string | null | undefined): Locale | null {
  if (!text) return null;
  // Strip what is not prose: links, addresses, mentions and digits say nothing
  // about the language and must not count as words.
  const prose = text
    .slice(0, MAX_CHARS)
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/[@#]\S+/g, ' ')
    // The dotted capital İ lower-cases to "i̇" (i + combining dot) outside a
    // Turkish locale; fold it to a plain i so the word lists still match.
    .replace(/İ/g, 'i')
    .toLowerCase();
  const words = prose.match(/[\p{L}]+/gu) ?? [];
  if (words.length < MIN_WORDS) return null;

  const score: Record<Scored, number> = { en: 0, tr: 0, de: 0 };
  for (const w of words) {
    for (const lang of Object.keys(WORDS) as Scored[]) {
      if (WORDS[lang].has(w)) score[lang] += 1;
    }
  }
  for (const [re, lang] of LETTERS) {
    // A letter is strong evidence, but a long name full of them is still one
    // name: cap its weight so it cannot outvote the sentence around it.
    const hits = prose.match(re)?.length ?? 0;
    score[lang] += Math.min(hits, 4);
  }

  const ranked = (Object.entries(score) as Array<[Scored, number]>).sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = ranked;
  if (top < MIN_SCORE) return null;
  if (second > 0 && top < second * DOMINANCE) return null;
  return best;
}

/**
 * The `lang` attribute for a piece of user-written text: the known language
 * when the caller has one (an announcement translation filed under a locale),
 * else the detected one, else `undefined` — which React renders as no
 * attribute at all, so the element keeps the page's language.
 *
 *   <p lang={contentLang(m.body)}>{m.body}</p>
 */
export function contentLang(text: string | null | undefined, known?: Locale | null): Locale | undefined {
  return known ?? detectContentLanguage(text) ?? undefined;
}
