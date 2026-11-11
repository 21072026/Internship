/**
 * The semantic match rule's comparison (#2038, story #2019) — pure and
 * CLIENT-SAFE, so the same arithmetic scores on the server, in a rule-set
 * preview and in the audit record.
 *
 * Meaning enters the score through cached THEMES, not through a model call
 * per pair: each person's free text (bio, interests, target position, goals)
 * is digested by AI once into a short list of theme tokens (`ProfileDigest`),
 * and this file compares two such lists with plain, deterministic arithmetic.
 * A matching query therefore makes no provider call, is reproducible for the
 * audit record, and keeps working when the provider is down — a person
 * without a digest simply leaves the rule not applicable (adds 0 to everyone).
 *
 * The comparison, which a coordinator should be able to repeat by hand:
 *   - each of the MENTEE's themes the mentor shares exactly counts 1;
 *   - otherwise, a mentor theme sharing a significant word (≥ 4 letters, not a
 *     filler word) counts PARTIAL_CREDIT — "platform engineering" meets
 *     "platform team" halfway;
 *   - the ratio is the sum over the mentee's theme count, capped at 1 — the
 *     same "how much of what the mentee asked for" reading the `skills`
 *     dimension uses.
 */

export const MAX_THEMES = 20;
export const MAX_THEME_LENGTH = 60;
export const PARTIAL_CREDIT = 0.5;

const FILLER = new Set([
  'about', 'also', 'and', 'from', 'into', 'more', 'over', 'that', 'their', 'them', 'they', 'this', 'with', 'within', 'work', 'working',
  'und', 'oder', 'mit', 'eine', 'einer', 'für', 'ile', 'veya', 'için', 'olarak',
]);

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One theme as stored and compared: lower-case, letters/digits/spaces only, single-spaced. */
export function normalizeTheme(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_THEME_LENGTH)
    .trim();
}

/** A stored `themes` value read defensively: strings only, normalised, de-duplicated, bounded. */
export function normalizeThemes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = normalizeTheme(v);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_THEMES) break;
  }
  return out;
}

function significantWords(theme: string): string[] {
  return theme.split(' ').filter((w) => w.length >= 4 && !FILLER.has(w));
}

export interface SemanticAffinity {
  /** 0..1 */
  score: number;
  /** Mentee themes the mentor shares exactly. */
  sharedThemes: string[];
  /** Mentee themes met halfway, each with the mentor theme that met it. */
  relatedThemes: { theme: string; via: string }[];
}

export function semanticAffinity(menteeThemes: readonly string[], mentorThemes: readonly string[]): SemanticAffinity {
  const mentee = normalizeThemes(menteeThemes);
  const mentor = normalizeThemes(mentorThemes);
  const out: SemanticAffinity = { score: 0, sharedThemes: [], relatedThemes: [] };
  if (mentee.length === 0 || mentor.length === 0) return out;
  const exact = new Set(mentor);
  // Sorted once, so the theme that "meets halfway" does not depend on the
  // order a model happened to list them in.
  const mentorSorted = [...mentor].sort(byCode);
  let sum = 0;
  for (const theme of mentee) {
    if (exact.has(theme)) {
      out.sharedThemes.push(theme);
      sum += 1;
      continue;
    }
    const words = new Set(significantWords(theme));
    if (words.size === 0) continue;
    const via = mentorSorted.find((m) => significantWords(m).some((w) => words.has(w)));
    if (via) {
      out.relatedThemes.push({ theme, via });
      sum += PARTIAL_CREDIT;
    }
  }
  out.score = Math.min(1, Math.round((sum / mentee.length) * 1000) / 1000);
  return out;
}
