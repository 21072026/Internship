// Per-tenant terminology (#1629, story #1627): "mentor" → "coach", "mentee" →
// "student", per organization (and per programme), per locale.
//
// THE MECHANISM IS THE OVERLAY'S (decision on #1629, option 1). There is no
// `{{mentor}}` placeholder in the base dictionary and no second layer next to
// src/i18n/verticalOverlays.ts: a stored terminology is turned into replaced
// WHOLE STRINGS — the resolved dictionary with each catalogued default noun form
// swapped for the stored form — and applied after the vertical overlay, at the
// same choke points (getServerDictionary(), the root layout's client payload,
// emailDictionary()). So useT() call sites change nowhere, and with nothing
// stored the dictionary is returned as the same object, byte-identical.
//
// THE CATALOGUE IS CLOSED. Five tokens, each with four forms per locale
// (`one`, `many`, `oneCap`, `manyCap`); a new token is a code change. The stored
// JSON is admin input: parseTerminology() drops an unknown locale, an unknown
// token and a token missing a form, and never throws.
//
// INFLECTION IS STORED, NEVER BUILT. A swap is an exact whole-word match on a
// catalogued default form. Turkish suffixes (`mentorun`, `mentora`,
// `Mentee'ler` when not catalogued) and German compounds (`Mentorenzeit`) do
// not match, so they keep the default word — never a half-built one such as
// "Coach'un". German articles belong to the surrounding sentence; a stored noun
// of another gender reads with the base article (the admin screen says so).
//
// WHAT IS NEVER TOUCHED: interpolation tokens (`{mentor}`, `{mentorName}`),
// paths (`/mentor/...`), hosts (`mentor.example`) and addresses — a form
// next to `{`, `}`, `/`, `@`, `_` or glued to a dot and a letter is not a word.
//
// Scope: INTERNSHIP only. The defaults are internship words; a MARKETING
// tenant's nouns already come from its vertical overlay, so its stored value
// is ignored (applyTerminology is not called for it).
//
// Client-safe: no imports beyond zod and the locale list. The settings read
// lives in terminology.server.ts.

import { z } from 'zod';
import { locales, type Locale } from '@/i18n/config';

export const TERM_TOKENS = ['mentor', 'mentee', 'program', 'cohort', 'mentorship'] as const;
export type TermToken = (typeof TERM_TOKENS)[number];

export const TERM_FORMS = ['one', 'many', 'oneCap', 'manyCap'] as const;
export type TermForm = (typeof TERM_FORMS)[number];

/** The four stored forms of one token. */
export type TermForms = Record<TermForm, string>;
/** One locale's overrides: only the tokens an admin set. */
export type LocaleTerms = Partial<Record<TermToken, TermForms>>;
/** The stored setting value: per locale. */
export type Terminology = Partial<Record<Locale, LocaleTerms>>;

// The words the dictionary uses today. A form may have several spellings
// (EN writes both "program" and "programme"); every one of them is replaced.
type Defaults = Record<TermToken, Record<TermForm, readonly string[]>>;

export const TERM_DEFAULTS: Record<Locale, Defaults> = {
  en: {
    mentor: { one: ['mentor'], many: ['mentors'], oneCap: ['Mentor'], manyCap: ['Mentors'] },
    mentee: { one: ['mentee'], many: ['mentees'], oneCap: ['Mentee'], manyCap: ['Mentees'] },
    program: {
      one: ['program', 'programme'],
      many: ['programs', 'programmes'],
      oneCap: ['Program', 'Programme'],
      manyCap: ['Programs', 'Programmes'],
    },
    cohort: { one: ['cohort'], many: ['cohorts'], oneCap: ['Cohort'], manyCap: ['Cohorts'] },
    mentorship: { one: ['mentorship'], many: ['mentorships'], oneCap: ['Mentorship'], manyCap: ['Mentorships'] },
  },
  tr: {
    mentor: { one: ['mentor'], many: ['mentorlar'], oneCap: ['Mentor'], manyCap: ['Mentorlar'] },
    mentee: { one: ['mentee'], many: ['menteeler', "mentee'ler"], oneCap: ['Mentee'], manyCap: ['Menteeler', "Mentee'ler"] },
    program: { one: ['program'], many: ['programlar'], oneCap: ['Program'], manyCap: ['Programlar'] },
    cohort: { one: ['kohort'], many: ['kohortlar'], oneCap: ['Kohort'], manyCap: ['Kohortlar'] },
    mentorship: { one: ['mentorluk'], many: ['mentorluklar'], oneCap: ['Mentorluk'], manyCap: ['Mentorluklar'] },
  },
  de: {
    // German capitalises every noun: `one` and `oneCap` share a spelling, and
    // the capitalised stored form wins for it.
    mentor: { one: ['Mentor'], many: ['Mentoren'], oneCap: ['Mentor'], manyCap: ['Mentoren'] },
    mentee: { one: ['Mentee'], many: ['Mentees'], oneCap: ['Mentee'], manyCap: ['Mentees'] },
    program: { one: ['Programm'], many: ['Programme'], oneCap: ['Programm'], manyCap: ['Programme'] },
    cohort: { one: ['Kohorte'], many: ['Kohorten'], oneCap: ['Kohorte'], manyCap: ['Kohorten'] },
    mentorship: {
      one: ['Mentoring', 'Mentorschaft'],
      many: ['Mentorings', 'Mentorschaften'],
      oneCap: ['Mentoring', 'Mentorschaft'],
      manyCap: ['Mentorings', 'Mentorschaften'],
    },
  },
};

export const TERM_FORM_MAX = 40;

// A form is a word or a short phrase. Braces would forge an interpolation
// token, angle brackets markup; control characters have no business in copy.
const formSchema = z
  .string()
  .trim()
  .min(1)
  .max(TERM_FORM_MAX)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[{}<>\u0000-\u001f\u007f]/.test(s));

const formsSchema = z.object({ one: formSchema, many: formSchema, oneCap: formSchema, manyCap: formSchema });

/**
 * Parse a stored (or submitted) terminology. Accepts the JSON string or the
 * object; drops what the catalogue does not know or a token that is not
 * complete; never throws. `{}` when nothing survives.
 */
export function parseTerminology(input: unknown): Terminology {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (input.trim() === '') return {};
    try {
      raw = JSON.parse(input);
    } catch {
      return {};
    }
  }
  if (!isRecord(raw)) return {};
  const out: Terminology = {};
  for (const locale of locales) {
    const perLocale = raw[locale];
    if (!isRecord(perLocale)) continue;
    const terms: LocaleTerms = {};
    for (const token of TERM_TOKENS) {
      const parsed = formsSchema.safeParse(perLocale[token]);
      if (parsed.success) terms[token] = parsed.data;
    }
    if (Object.keys(terms).length > 0) out[locale] = terms;
  }
  return out;
}

/** The canonical stored string of a terminology ('' when empty). */
export function serializeTerminology(terms: Terminology): string {
  const clean = parseTerminology(terms);
  return Object.keys(clean).length === 0 ? '' : JSON.stringify(clean);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// default spelling → stored form, for one locale. Only the pairs that change
// anything; the capitalised forms are listed last so they win a shared
// spelling (German).
function replacements(locale: Locale, terms: LocaleTerms | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!terms) return map;
  const order: TermForm[] = ['one', 'many', 'oneCap', 'manyCap'];
  for (const token of TERM_TOKENS) {
    const stored = terms[token];
    if (!stored) continue;
    for (const form of order) {
      for (const spelling of TERM_DEFAULTS[locale][token][form]) {
        if (stored[form] !== spelling) map.set(spelling, stored[form]);
        else map.delete(spelling);
      }
    }
  }
  return map;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word match, longest spelling first. Not a word: anything glued to a
// letter, digit or `_`; inside `{…}`; part of a path or an address; or the
// start of a host (`mentor.example`). Turkish also refuses a form followed by
// an apostrophe suffix — `Mentor'un` must not become `Coach'un`.
function matcher(locale: Locale, spellings: string[]): RegExp {
  const alternation = [...spellings].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const suffix = locale === 'tr' ? "|['’]\\p{L}" : '';
  return new RegExp(
    `(?<![\\p{L}\\p{N}_{/@.\\-])(?:${alternation})(?![\\p{L}\\p{N}_}/@]|\\.[\\p{L}\\p{N}]${suffix})`,
    'gu',
  );
}

/** Swap the catalogued nouns in one string. Exported for the unit spec. */
export function swapTerms(text: string, locale: Locale, terms: LocaleTerms | undefined): string {
  const map = replacements(locale, terms);
  if (map.size === 0) return text;
  return text.replace(matcher(locale, [...map.keys()]), (m) => map.get(m) ?? m);
}

function walk(node: unknown, swap: (s: string) => string): unknown {
  if (typeof node === 'string') return swap(node);
  if (Array.isArray(node)) return node.map((n) => walk(n, swap));
  if (isRecord(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, swap);
    return out;
  }
  return node;
}

/**
 * The dictionary with the stored nouns swapped in. Nothing stored for this
 * locale → the SAME object (the byte-identical guarantee). Returns a new tree
 * otherwise; the base is shared process state and is never mutated.
 */
export function applyTerminology<T extends object>(dict: T, locale: Locale, terms: Terminology | null | undefined): T {
  const map = replacements(locale, terms?.[locale]);
  if (map.size === 0) return dict;
  const re = matcher(locale, [...map.keys()]);
  return walk(dict, (s) => s.replace(re, (m) => map.get(m) ?? m)) as T;
}

// One walk per (base dictionary, locale, terminology): the first request of an
// org pays it, every later one reads the result. Keyed by the caller's
// description of its base (locale + vertical + product name) and the canonical
// terminology string. Bounded — an evicted entry is merely rebuilt.
const MEMO_MAX = 64;
const memo = new Map<string, unknown>();

/** applyTerminology(), memoised under `baseKey` (what the caller's base dictionary was built from). */
export function applyTerminologyMemo<T extends object>(
  baseKey: string,
  dict: T,
  locale: Locale,
  terms: Terminology | null | undefined,
): T {
  const localeTerms = terms?.[locale];
  if (!localeTerms || Object.keys(localeTerms).length === 0) return dict;
  const key = `${baseKey}\u0000${locale}\u0000${JSON.stringify(localeTerms)}`;
  const hit = memo.get(key);
  if (hit) return hit as T;
  const out = applyTerminology(dict, locale, terms);
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(key, out);
  return out;
}

// One sentence per locale written in the catalogue's DEFAULT words, for the
// admin card's live preview (#1631): swapTerms() over it shows what a draft
// does before it is saved. Code, not dictionary copy, on purpose — a dictionary
// string would already carry the org's saved terms and the preview would swap
// nothing.
export const TERM_PREVIEW_SAMPLE: Record<Locale, string> = {
  en: 'Each mentor meets their mentees every week; the cohort follows one programme, and every mentorship starts with a goal.',
  tr: 'Her mentor menteeler ile her hafta görüşür; kohort tek bir program izler ve her mentorluk bir hedefle başlar.',
  de: 'Jeder Mentor trifft seine Mentees jede Woche; die Kohorte folgt einem Programm, und jedes Mentoring beginnt mit einem Ziel.',
};
