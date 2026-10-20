// The pure half of the canonical skill taxonomy (#1815, epic #1810).
//
// `src/lib/skills.ts` decides how a typed list becomes separate skills and
// what "the same skill" means (`skillKey()`, the ONE fold). This module is the
// next step: the rules for the `Skill` / `SkillAlias` / `SkillEdge` rows those
// skills resolve to — caps, labels, the key a new skill is stored under, and
// the two graph walks (merge chain, adjacency expansion) that must terminate on
// any data an admin can produce.
//
// The DB-touching half is `src/lib/skillsResolve.ts`; it loads rows and hands
// them to the functions here, so the rules are unit-tested without a database
// (`scripts/test/skill-taxonomy.test.mjs`).
//
// DEPENDENCY-FREE ON PURPOSE
//   Same reason as `skills.ts` and `skillSeed.ts`: the unit test loads this file
//   under Node's type stripping, which resolves no `@/` alias and no
//   extensionless relative import. It is also client-safe — a picker may import
//   `skillLabel` — so it must never import Prisma.

export type SkillLocale = 'en' | 'tr' | 'de';

/** The status vocabulary of `Skill.status`. */
export const SKILL_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/**
 * The kinds of `SkillEdge.kind`. ADJACENT is undirected (stored once, read both
 * ways); BROADER / NARROWER are read from → to only.
 */
export const SKILL_EDGE_KINDS = ['ADJACENT', 'BROADER', 'NARROWER'] as const;
export type SkillEdgeKind = (typeof SKILL_EDGE_KINDS)[number];

/** Where a `UserSkill` row came from (`UserSkill.source`). */
export const USER_SKILL_SOURCES = ['SELF', 'ADMIN', 'BACKFILL', 'CV', 'IMPORT'] as const;
export type UserSkillSource = (typeof USER_SKILL_SOURCES)[number];

/**
 * Caps. The per-PERSON cap is not here: it is `SKILL_LIMITS.maxSkills` in
 * `skills.ts`, the one the free-text list already enforces, and a second number
 * for the same thing would drift.
 */
/** Canonical skills one org may hold. The starter vocabulary is ~100. */
export const MAX_SKILLS_PER_ORG = 2000;
/** `Skill.key` / `SkillAlias.key` column width (`@db.VarChar(64)`). */
export const MAX_SKILL_KEY_LENGTH = 64;
/** `Skill.label*` column width (`@db.VarChar(60)`) — same as `SKILL_LIMITS.maxSkillLength`. */
export const MAX_SKILL_LABEL_LENGTH = 60;
/** Weight a starter-vocabulary adjacency gets: unmeasured, so "half as good". */
export const DEFAULT_EDGE_WEIGHT = 0.5;
/** How many hops `expandAdjacency` walks by default: direct neighbours only. */
export const DEFAULT_EXPANSION_DEPTH = 1;
/** Hard ceiling, whatever a caller asks for: past three hops everything is adjacent. */
export const MAX_EXPANSION_DEPTH = 3;

/**
 * Is this (already `normalizeSkillName`d) string acceptable as a canonical
 * label? Non-empty, within the column, and carrying at least one letter or
 * digit — "C#", ".NET" and "R" are skills, "—" and "..." are not.
 */
export function isValidSkillLabel(label: string): boolean {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SKILL_LABEL_LENGTH) return false;
  // Any character that changes under case mapping is a letter; plus digits.
  // (No \p{L}: `target` is ES2017, where a Unicode property escape is a
  // compile error — same trick as `skills.ts`.)
  for (const ch of trimmed) {
    if (/[0-9]/.test(ch) || ch.toLowerCase() !== ch.toUpperCase()) return true;
  }
  return false;
}

/**
 * The key a NEW org-made skill is stored under, from its folded name
 * (`skillKey(label)`). Whitespace becomes a hyphen; the characters that make
 * "C#", "C++" and ".NET" distinct terms are kept. Starter skills keep their seed
 * key ("react"), which `check:skills` already proves is a fixed point of the fold.
 */
export function skillKeyFromFolded(folded: string): string {
  return folded.trim().replace(/\s+/g, '-').slice(0, MAX_SKILL_KEY_LENGTH);
}

export interface SkillLabels {
  labelEn: string;
  labelTr: string;
  labelDe: string;
}

/** The label to show in `locale`, falling back to English for an empty one. */
export function skillLabel(skill: SkillLabels, locale: string): string {
  const own = locale === 'tr' ? skill.labelTr : locale === 'de' ? skill.labelDe : skill.labelEn;
  return own && own.trim() ? own : skill.labelEn;
}

/**
 * Follow `mergedIntoId` to the skill a merged one now lives in. Cycle-safe: an
 * admin can only merge into a live skill, but rows are rows, and a loop must
 * not hang a request. On a cycle the walk stops at the last skill not yet seen.
 *
 * `mergedInto` maps a skill id to its `mergedIntoId` (or null / absent).
 */
export function followMerges(
  id: string,
  mergedInto: ReadonlyMap<string, string | null>,
): string {
  const seen = new Set<string>([id]);
  let current = id;
  for (;;) {
    const next = mergedInto.get(current);
    if (!next || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

export interface SkillEdgeRow {
  fromSkillId: string;
  toSkillId: string;
  weight: number;
  kind: string;
}

export interface WeightedSkill {
  skillId: string;
  /** 1 for an origin skill; the product of edge weights along the best path otherwise. */
  weight: number;
}

/** Clamp a stored weight into (0, 1]; a non-number reads as the default. */
export function clampEdgeWeight(weight: number): number {
  if (!Number.isFinite(weight)) return DEFAULT_EDGE_WEIGHT;
  return Math.min(1, Math.max(0, weight));
}

/**
 * Expand a set of skills along the adjacency graph.
 *
 * Every origin comes back at weight 1. A neighbour reached in `depth` hops or
 * fewer comes back at the best (highest) product of edge weights over any path
 * — never above 1, and never above an origin. ADJACENT edges are walked both
 * ways; BROADER / NARROWER only from → to. Terminates on any edge set: a skill
 * is only re-queued when a strictly better weight is found, and the depth is
 * bounded. Zero-weight edges are ignored. Output is sorted by weight
 * descending, then id, so a caller gets a stable order.
 */
export function expandAdjacency(
  origins: readonly string[],
  edges: readonly SkillEdgeRow[],
  depth: number = DEFAULT_EXPANSION_DEPTH,
): WeightedSkill[] {
  const maxDepth = Math.max(0, Math.min(MAX_EXPANSION_DEPTH, Math.floor(depth)));

  const out = new Map<string, number>();
  for (const id of origins) out.set(id, 1);
  if (maxDepth === 0 || out.size === 0) return sortWeighted(out);

  const neighbours = new Map<string, { to: string; weight: number }[]>();
  const link = (from: string, to: string, weight: number) => {
    if (from === to || weight <= 0) return;
    const list = neighbours.get(from) ?? [];
    list.push({ to, weight });
    neighbours.set(from, list);
  };
  for (const edge of edges) {
    const weight = clampEdgeWeight(edge.weight);
    link(edge.fromSkillId, edge.toSkillId, weight);
    if (edge.kind === 'ADJACENT') link(edge.toSkillId, edge.fromSkillId, weight);
  }

  let frontier = new Map(out);
  for (let hop = 0; hop < maxDepth && frontier.size > 0; hop++) {
    const next = new Map<string, number>();
    for (const [id, weight] of frontier) {
      for (const { to, weight: edgeWeight } of neighbours.get(id) ?? []) {
        const candidate = weight * edgeWeight;
        if (candidate > (out.get(to) ?? 0)) {
          out.set(to, candidate);
          next.set(to, candidate);
        }
      }
    }
    frontier = next;
  }
  return sortWeighted(out);
}

function sortWeighted(weights: ReadonlyMap<string, number>): WeightedSkill[] {
  return [...weights]
    .map(([skillId, weight]) => ({ skillId, weight }))
    .sort((a, b) => b.weight - a.weight || (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
}
