/**
 * Term normalisation for the match scorer (#1781). Client-safe, no I/O.
 *
 * Skills, interests and fields are free text — there is no taxonomy in this
 * tree, so nothing here pretends there is. Two terms match when they agree
 * after: the shared skill key (`skillKey`: trimmed, case- and accent-folded,
 * Turkish-aware), punctuation stripped, and one pass through the small alias
 * table below. The table is owned here and deliberately short: every entry is
 * a spelling of the SAME thing, never a broader category ("react" is not
 * "frontend") — a category mapping would make a React mentor a match for every
 * Vue mentee.
 */

import { skillKey } from '@/lib/skills';

/** Spelling → canonical spelling. Keys and values are already folded. */
const ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  ecmascript: 'javascript',
  ts: 'typescript',
  reactjs: 'react',
  'react js': 'react',
  vuejs: 'vue',
  'vue js': 'vue',
  nodejs: 'node',
  'node js': 'node',
  golang: 'go',
  k8s: 'kubernetes',
  postgres: 'postgresql',
  psql: 'postgresql',
  py: 'python',
  ml: 'machine learning',
  ux: 'ux design',
  ui: 'ui design',
  csharp: 'c#',
  cpp: 'c++',
};

/** The comparable form of one term. Empty string for a term with nothing left. */
export function normalizeTerm(value: string): string {
  const folded = skillKey(value)
    // Punctuation to spaces, keeping the two characters that carry meaning in
    // a skill name (c++, c#). ES2017 target: no \p{} escapes.
    .replace(/[^0-9a-z+#À-￿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[folded] ?? folded;
}

/** A Json column (or anything) as a list of non-empty strings. */
export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/** Unique normalised terms, first spelling kept for display. */
export function termMap(values: readonly string[], fold: (s: string) => string = normalizeTerm): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of values) {
    const k = fold(v);
    if (k && !out.has(k)) out.set(k, v.trim());
  }
  return out;
}

/** Words of a free-text field, normalised, for token overlap. */
export function tokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const words = text.split(/[\s,;/|]+/).map(normalizeTerm).filter((w) => w.length >= 2);
  return Array.from(new Set(words));
}

/** The pre-#1781 comparison, kept so the default rule set ranks exactly as before. */
export const lowercaseOnly = (s: string): string => s.toLowerCase();
