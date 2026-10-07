// Safeguarding detection — THE rule (#2056). Deliberately Prisma-free and
// client-safe: it is pure string work, unit-tested over an EN/TR/DE corpus in
// scripts/test/safeguarding.test.mjs, and the one place the question "does this
// message share a contact detail or hit a watch keyword?" is answered.
//
// The writer is `src/lib/safeguardingScan.ts` (one function, called from every
// message write path); the review queue is /admin/safeguarding; the retention
// rule that masks old bodies is the `message` entry in retentionEntries.ts.
// docs/safeguarding.md is the human-readable version of everything here.
//
// TWO PRODUCT DECISIONS, NOT PREFERENCES:
//   1. Detection NEVER blocks or holds a message. It flags and notifies; the
//      message is delivered regardless. A false positive that silently swallows
//      a mentee's message is worse than the risk it guards against.
//   2. FALSE POSITIVES ARE THE REAL FAILURE MODE. A queue that fills with dates,
//      prices and order numbers is a queue admins stop reading, and then it
//      protects nobody. Every pattern below errs towards missing a creative
//      obfuscation rather than flagging ordinary text, and every widening needs
//      a negative case in the corpus test next to it.

export type SafeguardingKind = 'CONTACT_DETAIL' | 'KEYWORD';

export interface ContactMatch {
  kind: 'email' | 'phone';
  /** The matched text exactly as written. */
  text: string;
  start: number;
  end: number;
}

export interface KeywordHit {
  /** The configured keyword that matched (as configured, trimmed). */
  keyword: string;
  start: number;
  end: number;
  /** A short window of the message around the hit, for the review queue. */
  context: string;
}

/** Limits on an org's watch list. Shared by the API validation and the parser. */
export const WATCH_KEYWORD_LIMITS = { maxKeywords: 100, maxLength: 60, minLength: 2 } as const;

/** Characters of context on each side of a hit. */
const CONTEXT_CHARS = 40;

// ── Contact details ─────────────────────────────────────────────────────────

/**
 * A plain address. The local part and the domain are the ordinary shapes; the
 * TLD must be letters, which is what keeps "v1.2@3.4" style version strings out.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g;

// The obfuscated address: "jane at example dot com", "jane [at] example [dot] de",
// "jane(at)example.de", "jane ät beispiel punkt de". Deliberately strict about
// the TLD — only the endings people in this product's three markets actually
// type — because "meet me at home dot" is English and a loose `\w{2,}` TLD
// would flag it. A bracketed separator is a strong signal by itself, so it may
// pair with a literal dot.
const AT_WORD = String.raw`(?:\s*[\[({<]\s*(?:at|ät|et)\s*[\])}>]\s*|\s+(?:at|ät)\s+)`;
const DOT_WORD = String.raw`(?:\s*[\[({<]\s*(?:dot|punkt|nokta)\s*[\])}>]\s*|\s+(?:dot|punkt|nokta)\s+|\.)`;
const OBFUSCATED_TLD = String.raw`(?:com(?:\.tr)?|de|net|org|edu(?:\.tr)?|tr|at|ch|eu|io|info|co(?:\.uk)?|uk|nl|me)`;
const OBFUSCATED_EMAIL_RE = new RegExp(
  String.raw`\b[A-Za-z0-9._%+-]{2,}${AT_WORD}[A-Za-z0-9-]{2,}(?:${DOT_WORD}[A-Za-z0-9-]{2,})*?${DOT_WORD}${OBFUSCATED_TLD}\b`,
  'gi',
);

/**
 * A run of digits with the separators people put in phone numbers. Collected
 * loosely here and then judged by `isPhoneLike`, which is where the false
 * positives are actually decided.
 */
const PHONE_CANDIDATE_RE = /(?:\+|\b00|\b0|\()?[\d(][\d\s().\/-]{5,22}\d/g;

/** Date shapes a phone candidate must not be: 07.10.2026, 2026-10-07, 7/10/26. */
const DATE_RE = /^(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/;
/** A time or a time range: 14:30, 9.30-11.00. */
const TIME_RANGE_RE = /^\d{1,2}[.:]\d{2}(?:\s*[-–]\s*\d{1,2}[.:]\d{2})?$/;

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Whether a digit run reads as a phone number rather than a date, an amount,
 * an IBAN fragment or an order number.
 *
 * The rule: 9–15 digits (E.164 tops out at 15; nothing shorter than 9 is a
 * reachable number with its area code in DE/TR/US), AND it LOOKS dialled — it
 * starts with `+`, `00` or a trunk `0`, or it is the US `(555) 123-4567` shape.
 * A bare `123456789` is an order number until proven otherwise; that is the
 * single biggest false-positive class and the reason for the second condition.
 */
export function isPhoneLike(raw: string, before = '', after = ''): boolean {
  const text = raw.trim();
  if (DATE_RE.test(text) || TIME_RANGE_RE.test(text)) return false;
  const digits = digitsOf(text);
  if (digits.length < 9 || digits.length > 15) return false;
  // Money: "€ 0 150 000" / "0150000 EUR" — a currency next to it is an amount.
  if (/[€$£₺]\s*$|\b(?:eur|euro|usd|try|tl|chf)\s*$/i.test(before) || /^\s*(?:[€$£₺]|eur\b|euro\b|usd\b|tl\b|try\b|chf\b)/i.test(after)) {
    return false;
  }
  // Part of a longer alphanumeric token (an IBAN "DE89 3704…", a reference "INV-0049…").
  if (/[A-Za-z][-_/#]?$/.test(before) || /^[-_/]?[A-Za-z]/.test(after)) return false;
  if (text.startsWith('+')) return true;
  if (text.startsWith('00') || text.startsWith('(0') || text.startsWith('0')) return true;
  return /^\(\d{3}\)\s?\d{3}[\s.-]?\d{4}$/.test(text);
}

// Spelled-out digits — "five five five, one two three…", "sıfır beş üç iki…",
// "null eins sieben sechs…". Seven in a row is the threshold: no ordinary
// sentence lists seven bare numerals, and a real number is at least that long.
const DIGIT_WORDS = [
  // EN
  'zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  // TR
  'sıfır', 'sifir', 'bir', 'iki', 'üç', 'uc', 'dört', 'dort', 'beş', 'bes', 'altı', 'alti', 'yedi', 'sekiz', 'dokuz',
  // DE
  'null', 'eins', 'zwei', 'zwo', 'drei', 'vier', 'fünf', 'fuenf', 'sechs', 'sieben', 'acht', 'neun',
];
const DIGIT_TOKEN = String.raw`(?:${DIGIT_WORDS.join('|')}|\d)`;
const SPELLED_NUMBER_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${DIGIT_TOKEN}(?:[\s,.-]+${DIGIT_TOKEN}){6,}(?![\p{L}\p{N}])`,
  'giu',
);

function mergeOverlapping(matches: ContactMatch[]): ContactMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ContactMatch[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) continue;
    out.push(m);
  }
  return out;
}

/**
 * Phone numbers and e-mail addresses in a message, with their spans.
 *
 * Tolerant of the obfuscations people actually use — spaced and dotted digits,
 * "at"/"dot" in three languages, bracketed separators, digits written as words —
 * and strict about everything that merely contains digits.
 */
export function detectContactDetails(body: string): ContactMatch[] {
  if (!body) return [];
  const found: ContactMatch[] = [];

  for (const m of body.matchAll(EMAIL_RE)) {
    found.push({ kind: 'email', text: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of body.matchAll(OBFUSCATED_EMAIL_RE)) {
    found.push({ kind: 'email', text: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of body.matchAll(PHONE_CANDIDATE_RE)) {
    // Trim separators the loose pattern may have swallowed at either end.
    const raw = m[0].replace(/[\s.\/-]+$/, '');
    const start = m.index!;
    const before = body.slice(Math.max(0, start - 6), start);
    const after = body.slice(start + raw.length, start + raw.length + 6);
    if (isPhoneLike(raw, before, after)) {
      found.push({ kind: 'phone', text: raw, start, end: start + raw.length });
    }
  }
  for (const m of body.matchAll(SPELLED_NUMBER_RE)) {
    // A run of bare digits only ("1 2 3 4 5 6 7") is the candidate regex's job,
    // where the dialled-shape rule applies; this pass is for runs with words.
    if (!/\p{L}/u.test(m[0])) continue;
    found.push({ kind: 'phone', text: m[0], start: m.index!, end: m.index! + m[0].length });
  }

  return mergeOverlapping(found);
}

// ── Watch keywords ──────────────────────────────────────────────────────────

/**
 * Fold a string for matching: lower case in a locale-neutral way, Turkish dotted
 * and dotless i and German ß collapsed, diacritics stripped. Returns the folded
 * string AND a map from folded index → original index, so a hit can be reported
 * at its position in the text the admin will read.
 */
function fold(input: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let ch = input[i];
    if (ch === 'İ' || ch === 'I' || ch === 'ı') ch = 'i';
    else if (ch === 'ß') ch = 'ss';
    else ch = ch.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    for (const c of ch) {
      text += c;
      map.push(i);
    }
  }
  map.push(input.length);
  return { text, map };
}

function foldPlain(s: string): string {
  return fold(s).text;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * Parse an org's watch list from its stored form (one per line; commas also
 * accepted). Trimmed, de-duplicated on the folded form, bounded by
 * WATCH_KEYWORD_LIMITS. Entries that are too short to be meaningful are dropped
 * rather than rejected — a two-letter keyword would flag half of every message.
 */
export function parseWatchKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const kw = part.trim().replace(/\s+/g, ' ');
    if (kw.length < WATCH_KEYWORD_LIMITS.minLength || kw.length > WATCH_KEYWORD_LIMITS.maxLength) continue;
    const key = foldPlain(kw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= WATCH_KEYWORD_LIMITS.maxKeywords) break;
  }
  return out;
}

/** The stored form of a watch list (what the setting holds). */
export function serializeWatchKeywords(keywords: string[]): string {
  return parseWatchKeywords(keywords.join('\n')).join('\n');
}

/** A window of `body` around [start, end), with ellipses where it was cut. */
export function contextAround(body: string, start: number, end: number, chars = CONTEXT_CHARS): string {
  const from = Math.max(0, start - chars);
  const to = Math.min(body.length, end + chars);
  const text = body.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${text}${to < body.length ? '…' : ''}`;
}

/**
 * Watch-keyword hits in a message, with context.
 *
 * Whole-word (or whole-phrase) matches only, case- and accent-insensitive, with
 * Turkish i/ı/İ and German ß folded — so "Treffen" matches "treffen" and
 * "TREFFEN", "kişisel" matches "KİŞİSEL", but "art" never matches "party". A
 * keyword may be a phrase ("meet alone"); internal whitespace matches any run of
 * whitespace.
 */
export function matchWatchKeywords(body: string, keywords: string[]): KeywordHit[] {
  if (!body || keywords.length === 0) return [];
  const { text, map } = fold(body);
  const hits: KeywordHit[] = [];
  for (const keyword of keywords) {
    const needle = foldPlain(keyword.trim());
    if (needle.length < WATCH_KEYWORD_LIMITS.minLength) continue;
    const pattern = needle
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    const re = new RegExp(pattern, 'g');
    for (const m of text.matchAll(re)) {
      const fs = m.index!;
      const fe = fs + m[0].length;
      if (isWordChar(text[fs - 1]) || isWordChar(text[fe])) continue;
      const start = map[fs];
      const end = map[fe];
      hits.push({ keyword: keyword.trim(), start, end, context: contextAround(body, start, end) });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

// ── What gets stored ────────────────────────────────────────────────────────

/**
 * The form a contact detail is stored in on the flag row: enough to recognise
 * it in the queue, not enough to dial it. The message body is the record; the
 * flag must not become a second, unmanaged copy of the number — the retention
 * sweep masks bodies, and a flag that kept the full number would outlive it.
 */
export function maskContact(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= 4) return '•'.repeat(compact.length);
  const keep = 2;
  const middle = compact.slice(keep, -keep).replace(/[^\s@.]/g, '•');
  return `${compact.slice(0, keep)}${middle}${compact.slice(-keep)}`.slice(0, 191);
}

export interface SafeguardingFinding {
  kind: SafeguardingKind;
  /** What the flag row stores: a masked contact detail, or the keyword. */
  matchedTerm: string;
  start: number;
  end: number;
  context: string;
}

export interface ScanOptions {
  keywords: string[];
  /**
   * Skip contact-detail detection. Set for messages that arrived BY E-MAIL:
   * every mail carries a signature with a phone number and an address, and the
   * channel itself already exchanged addresses — flagging them would bury the
   * queue in signatures. Keywords are still checked.
   */
  skipContactDetails?: boolean;
}

/**
 * Everything one message body should be flagged for — one finding per distinct
 * (kind, matchedTerm), the first occurrence's position and context kept.
 */
export function scanMessageBody(body: string, opts: ScanOptions): SafeguardingFinding[] {
  const out: SafeguardingFinding[] = [];
  const seen = new Set<string>();
  const push = (f: SafeguardingFinding) => {
    const key = `${f.kind}\u0000${f.matchedTerm}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  if (!opts.skipContactDetails) {
    for (const m of detectContactDetails(body)) {
      push({
        kind: 'CONTACT_DETAIL',
        matchedTerm: maskContact(m.text),
        start: m.start,
        end: m.end,
        context: contextAround(body, m.start, m.end),
      });
    }
  }
  for (const h of matchWatchKeywords(body, opts.keywords)) {
    push({ kind: 'KEYWORD', matchedTerm: h.keyword.slice(0, 191), start: h.start, end: h.end, context: h.context });
  }
  return out;
}

// ── Message retention (the masking rule) ────────────────────────────────────

/**
 * No retention window may be shorter than this. `messageRetentionDays` is typed
 * into a form; a "3" meant as three months must not mask yesterday's
 * conversation mid-thread. Same rail, and the same reasoning, as the
 * notification floor (src/lib/notificationRetention.ts).
 */
export const MESSAGE_RETENTION_FLOOR_DAYS = 30;

/**
 * The cutoff one org's window produces, or `null` for keep forever.
 *
 * `0`, negative or unparseable means keep forever — the default, and the
 * behaviour before #2056; the safe direction for a corrupted setting is to mask
 * less, never more. Anything positive is raised to the floor.
 */
export function messageRetentionCutoff(now: Date, retentionDays: number): Date | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  const days = Math.max(Math.floor(retentionDays), MESSAGE_RETENTION_FLOOR_DAYS);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
