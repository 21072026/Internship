/**
 * Skill proficiency on the canonical row (#1822) — the pure half.
 *
 * `UserSkill.level` is a 1..5 rating keyed on the skill id, with the source
 * that set it (`levelSource`) and, once a mentor or an evaluation vouches for
 * it, who did (`verifiedById`/`verifiedAt`). Every actual change appends one
 * `UserSkillLevelChange` row; writing the same value again appends none.
 *
 * `src/lib/skillsResolve.ts` loads the rows and applies what these functions
 * decide, so the rules are unit-tested without a database
 * (`scripts/test/skill-level.test.mjs`). Dependency-free on purpose, same as
 * `skillTaxonomyRule.ts`: the test loads it under Node's type stripping.
 *
 * Two rules worth knowing before you change anything here:
 *   - A confirmation vouches for ONE value. When the value changes, the
 *     verification goes with it — a mentor who confirmed a 2 never confirmed
 *     the 5 the mentee typed afterwards.
 *   - The self-assessment record a profile save sends is authoritative for the
 *     skills the person still holds: a held skill absent from it is unrated.
 *     The profile form sends the full record on every save, so an absent key
 *     is a cleared rating, not a missing one. A save that sends no record at
 *     all touches no level.
 */

export const SKILL_LEVEL_MIN = 1;
export const SKILL_LEVEL_MAX = 5;

export const SKILL_LEVEL_SOURCES = ['SELF', 'MENTOR', 'EVALUATION'] as const;
export type SkillLevelSource = (typeof SKILL_LEVEL_SOURCES)[number];

export function isSkillLevel(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= SKILL_LEVEL_MIN && (value as number) <= SKILL_LEVEL_MAX;
}

/** The proficiency columns of one `UserSkill` row. */
export interface HeldLevel {
  userSkillId: string;
  skillId: string;
  level: number | null;
  levelSource: string | null;
  verifiedById: string | null;
  verifiedAt: Date | null;
}

export interface LevelChange {
  userSkillId: string;
  fromLevel: number | null;
  toLevel: number | null;
}

/**
 * What a self-assessment save changes: one entry per held row whose level
 * actually moves. `wanted` maps skill id → level; a held skill missing from it
 * becomes unrated. An out-of-range value is ignored (treated as absent), so a
 * malformed record can clear a rating but never write a 0 or a 9.
 */
export function planSelfLevelChanges(
  held: readonly HeldLevel[],
  wanted: ReadonlyMap<string, number>,
): LevelChange[] {
  const changes: LevelChange[] = [];
  for (const row of held) {
    const raw = wanted.get(row.skillId);
    const toLevel = isSkillLevel(raw) ? raw : null;
    if (toLevel !== row.level) changes.push({ userSkillId: row.userSkillId, fromLevel: row.level, toLevel });
  }
  return changes;
}

/** The columns a self-assessed change writes onto the row. */
export function selfLevelData(toLevel: number | null, now: Date) {
  return {
    level: toLevel,
    levelSource: toLevel === null ? null : ('SELF' as SkillLevelSource),
    verifiedById: null,
    verifiedAt: null,
    levelUpdatedAt: now,
  };
}

/**
 * Two rows of one person collapse into one when the curator merges the loser
 * skill into the target. Which proficiency survives: a verified level beats a
 * self-assessed one; otherwise the target's own rating stands; otherwise the
 * loser's. Returns the columns to write onto the target, or `null` when the
 * target already holds the winner — a merge must never lose a rating the
 * person had, nor overwrite a confirmation with a self-assessment.
 */
export function mergedLevel(
  target: Omit<HeldLevel, 'userSkillId' | 'skillId'>,
  loser: Omit<HeldLevel, 'userSkillId' | 'skillId'>,
): Omit<HeldLevel, 'userSkillId' | 'skillId'> | null {
  if (loser.level === null) return null;
  const targetVerified = target.level !== null && target.verifiedAt !== null;
  const loserVerified = loser.verifiedAt !== null;
  if (target.level === null || (loserVerified && !targetVerified)) {
    return {
      level: loser.level,
      levelSource: loser.levelSource,
      verifiedById: loser.verifiedById,
      verifiedAt: loser.verifiedAt,
    };
  }
  return null;
}

/**
 * A mentor (or an evaluation) vouching for a level. The confirmer may confirm
 * the value as it stands or correct it; either way the row ends up verified
 * by them, with the level they named. A history row is due only when the
 * value moves — re-confirming the same value refreshes the verification and
 * writes no change, so the history stays "what the level was", not "who
 * clicked".
 */
export function confirmLevelPlan(
  currentLevel: number | null,
  level: number,
  actorId: string,
  source: Exclude<SkillLevelSource, 'SELF'>,
  now: Date,
) {
  return {
    data: { level, levelSource: source, verifiedById: actorId, verifiedAt: now, levelUpdatedAt: now },
    change: currentLevel === level ? null : { fromLevel: currentLevel, toLevel: level },
  };
}

/**
 * Where a person started on a skill and where they are now — the mentee's
 * progression strip. `history` is the row's `UserSkillLevelChange` entries in
 * time order. The start is the level before the first change (or, when the
 * first change was the first rating, that rating); with no history the start
 * IS now. A strip compares two numbers, so an unrated skill returns null.
 */
export function skillProgression(
  history: readonly { fromLevel: number | null; toLevel: number | null }[],
  currentLevel: number | null,
): { start: number; now: number } | null {
  if (currentLevel === null) return null;
  const first = history.find((h) => h.fromLevel !== null || h.toLevel !== null);
  const start = first ? (first.fromLevel ?? first.toLevel) : currentLevel;
  return { start: start ?? currentLevel, now: currentLevel };
}
