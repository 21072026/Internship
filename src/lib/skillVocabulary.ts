/**
 * The app-facing side of the starter skill vocabulary (#1816).
 *
 * `skillSeed.ts` is the data and is dependency-free so a plain Node script can
 * load it (see its header). This file is the two-line wrapper that binds it to
 * the ONE fold this codebase has — `skillKey()` from `src/lib/skills.ts`, the
 * same Turkish-aware fold that decides whether two free-text skills are
 * duplicates — and exposes the lookups a caller actually wants.
 *
 * The index is built once per process: it is ~100 entries and a few hundred
 * tokens, derived from a module-level constant, so there is nothing to
 * invalidate.
 *
 * SCOPE. Nothing reads this yet, on purpose. Rewiring the skill filters and the
 * matcher onto the vocabulary is #1819/#1820, and the `Skill`/`UserSkill` rows
 * are #1815. This module exists so those can be written against a stable,
 * validated vocabulary instead of inventing one on the way past.
 */

import type { Locale } from '@/i18n/config';
import { skillKey } from '@/lib/skills';
import {
  SKILL_SEED,
  buildSkillIndex,
  resolveSeedEntry,
  resolveSeedKey,
  seedNeighbours,
  skillSeedLabel,
} from '@/lib/skillSeed';
import type { SkillEntry, SkillIndex } from '@/lib/skillSeed';

export type { SkillEntry, SkillCategory, SkillCategoryMeta } from '@/lib/skillSeed';
export { SKILL_SEED, SKILL_CATEGORIES } from '@/lib/skillSeed';

/** The starter vocabulary, indexed by key, by lookup token and by adjacency. */
export const SKILL_INDEX: SkillIndex = buildSkillIndex(skillKey, SKILL_SEED);

/** The canonical key behind anything a user typed ("ReactJS" → "react"), or `null`. */
export function resolveSkillKey(raw: string): string | null {
  return resolveSeedKey(SKILL_INDEX, raw);
}

/** The vocabulary entry behind anything a user typed, or `null` if it is free text. */
export function resolveSkill(raw: string): SkillEntry | null {
  return resolveSeedEntry(SKILL_INDEX, raw);
}

/** One entry by its exact key. */
export function skillByKey(key: string): SkillEntry | null {
  return SKILL_INDEX.byKey.get(key) ?? null;
}

/** The near-neighbours of a skill, as entries; empty for an unknown key. */
export function skillNeighbours(key: string): readonly SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const neighbour of seedNeighbours(SKILL_INDEX, key)) {
    const entry = SKILL_INDEX.byKey.get(neighbour);
    if (entry) out.push(entry);
  }
  return out;
}

/** The label to show for an entry in the reader's locale. */
export function skillLabel(entry: SkillEntry, locale: Locale): string {
  return skillSeedLabel(entry, locale);
}
