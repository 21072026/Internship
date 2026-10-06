// The rules around summarising survey free text (#1910) — pure, no provider,
// unit-tested (scripts/test/survey-text-rules.test.mjs). The provider call is
// src/lib/surveyTextSummary.ts; this file decides what may be sent and what
// may come back.
//
//   • WHAT LEAVES: unattributed answer texts only, with e-mail addresses, phone
//     numbers and links masked first — a respondent may type their own contact
//     details into a free-text box, and the summary needs none of them.
//   • WHAT COMES BACK: themes, and quotes that appear VERBATIM in the answers
//     sent. A quote the model "remembers" but no answer contains is dropped —
//     the summary may only say what the answers say.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Seven or more digits, allowing the separators people type in a number.
const PHONE = /\+?\d[\d\s()./-]{5,}\d/g;

export const MAX_SUMMARY_INPUT_CHARS = 24_000;

/** Mask what identifies a person directly; keep everything else as typed. */
export function redactAnswerText(text: string): string {
  return text.replace(EMAIL, '[e-mail]').replace(URL_RE, '[link]').replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 7 ? '[phone]' : m));
}

/** The answers as they are sent: redacted, trimmed, empty ones dropped, capped in total length. */
export function prepareAnswerTexts(texts: string[], maxChars = MAX_SUMMARY_INPUT_CHARS): string[] {
  const out: string[] = [];
  let used = 0;
  for (const raw of texts) {
    const t = redactAnswerText(raw).trim();
    if (!t) continue;
    if (used + t.length > maxChars) break;
    out.push(t);
    used += t.length;
  }
  return out;
}

export interface SummaryTheme {
  theme: string;
  quotes: string[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Parse the model's JSON and keep only what the answers support: at most
 * `maxThemes` themes, each with at most three quotes, every quote found
 * verbatim (whitespace and case aside) in one of the answers sent. Returns
 * null when the reply is not the JSON asked for.
 */
export function parseSummary(reply: string, sent: string[], maxThemes = 6): SummaryTheme[] | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const themes = (parsed as { themes?: unknown })?.themes;
  if (!Array.isArray(themes)) return null;
  const corpus = sent.map(norm);
  const out: SummaryTheme[] = [];
  for (const item of themes) {
    const theme = typeof (item as SummaryTheme)?.theme === 'string' ? (item as SummaryTheme).theme.trim().slice(0, 200) : '';
    if (!theme) continue;
    const quotes = (Array.isArray((item as SummaryTheme).quotes) ? (item as SummaryTheme).quotes : [])
      .filter((q): q is string => typeof q === 'string')
      .map((q) => q.trim().replace(/^["“„«]|["”»]$/g, '').trim())
      .filter((q) => q.length >= 3 && corpus.some((a) => a.includes(norm(q))))
      .slice(0, 3);
    out.push({ theme, quotes });
    if (out.length >= maxThemes) break;
  }
  return out;
}
