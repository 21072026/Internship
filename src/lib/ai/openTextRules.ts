// The rules around summarising free text across many rows (#2046) — pure, no
// provider, unit-tested (scripts/test/open-text-rules.test.mjs). The provider
// call is src/lib/ai/summarizeOpenText.ts; this file decides what may be sent
// and what may come back.
//
//   • WHAT LEAVES: each row's text with contact details masked (the survey
//     rules, src/lib/surveyTextRules.ts) and every known person's name masked,
//     under a short local label ("r1", "r2", …). Database ids never reach the
//     provider; the label is mapped back here.
//   • WHAT COMES BACK is verified, not trusted:
//       – a theme keeps only labels that were sent, and its `count` is the
//         number of those labels — never a number the model typed;
//       – sentiment is one of four buckets, anything else is `unclear`; a
//         theme's sentiment is the majority of its rows' buckets, and a tie is
//         `unclear` — no decimal anywhere, by design (#2046: a false precision
//         on someone's feedback is the black box we do not build);
//       – a quote survives only if it appears verbatim in the row it names.
//   • BELOW THE FLOOR nothing is sent and nothing is said except that there
//     were too few rows. The floor is the caller's: a survey's k-anonymity
//     floor (#1879) for anonymous answers, a small minimum for named rows.
//   • CAVEATS are codes the screen translates, not model prose: a model may
//     not write the disclaimer that qualifies its own output.

import { redactAnswerText, MAX_SUMMARY_INPUT_CHARS } from '@/lib/surveyTextRules';
import { redactForPrompt } from '@/lib/ai/redact';

// The survey masking first, then callModel's own pre-flight (#2026): applying
// it here too means the rows the quote check compares against are exactly
// what the model saw — the pre-flight is idempotent, so callModel's second
// pass changes nothing.
const maskRow = (text: string) => redactForPrompt(redactAnswerText(text));

export const SENTIMENTS = ['positive', 'neutral', 'negative', 'unclear'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export interface OpenTextItem {
  id: string;
  text: string;
}

export interface PreparedItem {
  label: string;
  id: string;
  text: string;
}

export type OpenTextCaveat =
  | { code: 'below_floor'; floor: number; available: number }
  | { code: 'truncated'; sent: number; available: number }
  | { code: 'names_masked' }
  | { code: 'quotes_dropped'; n: number };

export interface OpenTextTheme {
  label: string;
  count: number;
  exampleIds: string[];
  sentiment: Sentiment;
}

export interface OpenTextSummary {
  themes: OpenTextTheme[];
  overall: Record<Sentiment, number>;
  notableQuotes: { id: string; text: string }[];
  caveats: OpenTextCaveat[];
  sent: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Mask every known person's name: the full name, then each of its parts of
 * three letters or more (people write "Ayşe", not "Ayşe Yılmaz"). Unicode
 * letter boundaries, so "Ali" does not eat "Alignment".
 */
export function maskNames(text: string, names: string[]): string {
  const parts = new Set<string>();
  for (const n of names) {
    const full = n.trim();
    if (full.length >= 3) parts.add(full);
    for (const p of full.split(/\s+/)) if (p.length >= 3) parts.add(p);
  }
  // Longest first, so a full name is masked whole before its parts are.
  let out = text;
  for (const p of [...parts].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'giu'), '[name]');
  }
  return out;
}

/**
 * The rows as they are sent: contact details and names masked, trimmed, empty
 * ones dropped, capped in total length, each under a local label.
 */
export function prepareOpenText(
  items: OpenTextItem[],
  opts: { names?: string[]; maxChars?: number } = {},
): { prepared: PreparedItem[]; caveats: OpenTextCaveat[] } {
  const maxChars = opts.maxChars ?? MAX_SUMMARY_INPUT_CHARS;
  const names = opts.names ?? [];
  const prepared: PreparedItem[] = [];
  let used = 0;
  let masked = false;
  let available = 0;
  for (const item of items) {
    const redacted = maskRow(item.text).trim();
    if (!redacted) continue;
    available++;
    const text = names.length ? maskNames(redacted, names) : redacted;
    if (text !== redacted) masked = true;
    if (used + text.length > maxChars) continue;
    prepared.push({ label: `r${prepared.length + 1}`, id: item.id, text });
    used += text.length;
  }
  const caveats: OpenTextCaveat[] = [];
  if (prepared.length < available) caveats.push({ code: 'truncated', sent: prepared.length, available });
  if (masked) caveats.push({ code: 'names_masked' });
  return { prepared, caveats };
}

/** Rows that count toward a floor: non-empty after redaction. */
export function countUsable(items: OpenTextItem[]): number {
  return items.filter((i) => maskRow(i.text).trim()).length;
}

/** The refusal below the floor — the only thing said there. */
export function belowFloor(items: OpenTextItem[], floor: number): OpenTextCaveat | null {
  const available = countUsable(items);
  return available < floor ? { code: 'below_floor', floor, available } : null;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const asSentiment = (v: unknown): Sentiment => (SENTIMENTS as readonly string[]).includes(v as string) ? (v as Sentiment) : 'unclear';

function majority(buckets: Sentiment[]): Sentiment {
  const counts = new Map<Sentiment, number>();
  for (const b of buckets) counts.set(b, (counts.get(b) ?? 0) + 1);
  let best: Sentiment = 'unclear';
  let top = 0;
  let tie = false;
  for (const [s, n] of counts) {
    if (n > top) {
      best = s;
      top = n;
      tie = false;
    } else if (n === top) tie = true;
  }
  return tie ? 'unclear' : best;
}

/**
 * Parse the model's JSON and keep only what the rows support. Returns null when
 * the reply is not the JSON asked for. `caveats` from preparation are carried
 * through so one object says everything about how the summary was made.
 */
export function parseOpenTextSummary(
  reply: string,
  prepared: PreparedItem[],
  carried: OpenTextCaveat[] = [],
  limits: { maxThemes?: number; maxQuotes?: number } = {},
): OpenTextSummary | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const body = parsed as { themes?: unknown; sentiment?: unknown; quotes?: unknown };
  if (!Array.isArray(body?.themes)) return null;
  const byLabel = new Map(prepared.map((p) => [p.label, p]));

  // One bucket per row the model was shown; a row it did not classify is unclear.
  const raw = (body.sentiment && typeof body.sentiment === 'object' ? body.sentiment : {}) as Record<string, unknown>;
  const rowSentiment = new Map<string, Sentiment>(prepared.map((p) => [p.label, asSentiment(raw[p.label])]));
  const overall: Record<Sentiment, number> = { positive: 0, neutral: 0, negative: 0, unclear: 0 };
  for (const s of rowSentiment.values()) overall[s]++;

  const themes: OpenTextTheme[] = [];
  for (const t of body.themes as unknown[]) {
    const item = t as { label?: unknown; ids?: unknown };
    const label = typeof item?.label === 'string' ? item.label.trim().slice(0, 200) : '';
    if (!label) continue;
    const labels = [...new Set((Array.isArray(item.ids) ? item.ids : []).filter((x): x is string => typeof x === 'string' && byLabel.has(x)))];
    if (labels.length === 0) continue; // a theme no row stands behind is not a theme
    themes.push({
      label,
      count: labels.length,
      exampleIds: labels.map((l) => byLabel.get(l)!.id),
      sentiment: majority(labels.map((l) => rowSentiment.get(l) ?? 'unclear')),
    });
    if (themes.length >= (limits.maxThemes ?? 8)) break;
  }
  themes.sort((a, b) => b.count - a.count);

  const quotes: { id: string; text: string }[] = [];
  let dropped = 0;
  for (const q of Array.isArray(body.quotes) ? body.quotes : []) {
    const item = q as { id?: unknown; text?: unknown };
    const row = typeof item?.id === 'string' ? byLabel.get(item.id) : undefined;
    const text = typeof item?.text === 'string' ? item.text.trim().replace(/^["“„«]|["”»]$/g, '').trim() : '';
    // Verbatim in the row it names, as it was SENT — so a quote carries the
    // masks ("[name]"), never the name the mask replaced.
    if (!row || text.length < 3 || !norm(row.text).includes(norm(text))) {
      dropped++;
      continue;
    }
    if (quotes.length < (limits.maxQuotes ?? 5)) quotes.push({ id: row.id, text });
  }
  const caveats = [...carried];
  if (dropped > 0) caveats.push({ code: 'quotes_dropped', n: dropped });
  return { themes, overall, notableQuotes: quotes, caveats, sent: prepared.length };
}
