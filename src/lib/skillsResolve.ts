// The DB-side half of the canonical skill taxonomy (#1815, epic #1810).
//
// Every later consumer — the picker's suggest route (#1818), the backfill
// (#1819), the curation screen (#1817), the SQL skill filters (#1820) and
// adjacency-aware scoring (#1821) — resolves a typed skill through THIS file
// instead of comparing strings. The rules it applies (merge chains, adjacency
// walks, labels, keys) are pure in `src/lib/skillTaxonomyRule.ts`; the fold is
// `skillKey()` from `src/lib/skills.ts`, the same one that decides whether two
// free-text skills are duplicates.
//
// Every query names its `orgId` explicitly. The three org-anchored models are
// registered in TENANT_MODELS, but the middleware is dormant unless
// `MT_ENFORCE_ISOLATION` is on, and several callers (backfill, cron alerts)
// run with no tenant context bound at all.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { skillKey } from '@/lib/skills';
import { SKILL_SEED, buildSkillIndex } from '@/lib/skillSeed';
import {
  DEFAULT_EDGE_WEIGHT,
  DEFAULT_EXPANSION_DEPTH,
  MAX_EXPANSION_DEPTH,
  MAX_SKILL_KEY_LENGTH,
  expandAdjacency,
  followMerges,
  skillKeyFromFolded,
  skillLabel,
} from '@/lib/skillTaxonomyRule';
import type { SkillEdgeRow, WeightedSkill } from '@/lib/skillTaxonomyRule';

export interface ResolvedSkill {
  id: string;
  key: string;
  labelEn: string;
  labelTr: string;
  labelDe: string;
  category: string | null;
  status: string;
}

const SKILL_SELECT = {
  id: true,
  key: true,
  labelEn: true,
  labelTr: true,
  labelDe: true,
  category: true,
  status: true,
  mergedIntoId: true,
} as const;

type SkillRow = ResolvedSkill & { mergedIntoId: string | null };

/** A merge chain longer than this is data damage, not a real history. */
const MAX_MERGE_HOPS = 16;

export interface ResolveOptions {
  /** Also return a RETIRED skill (the curation screen wants it; matching does not). */
  includeRetired?: boolean;
}

function strip(row: SkillRow): ResolvedSkill {
  const { mergedIntoId: _merged, ...rest } = row;
  return rest;
}

/**
 * Follow merges for a batch of rows, loading each next hop in one query, and
 * return id → the row the chain ends at.
 */
async function landMerges(orgId: string, rows: readonly SkillRow[]): Promise<Map<string, SkillRow>> {
  const byId = new Map<string, SkillRow>(rows.map((row) => [row.id, row]));
  const mergedInto = new Map<string, string | null>(rows.map((row) => [row.id, row.mergedIntoId]));

  let pending = rows.map((row) => row.mergedIntoId).filter((id): id is string => !!id && !byId.has(id));
  for (let hop = 0; hop < MAX_MERGE_HOPS && pending.length > 0; hop++) {
    const next = await prisma.skill.findMany({
      where: { orgId, id: { in: [...new Set(pending)] } },
      select: SKILL_SELECT,
    });
    for (const row of next) {
      byId.set(row.id, row);
      mergedInto.set(row.id, row.mergedIntoId);
    }
    pending = next.map((row) => row.mergedIntoId).filter((id): id is string => !!id && !byId.has(id));
  }

  const landed = new Map<string, SkillRow>();
  for (const row of rows) {
    const end = byId.get(followMerges(row.id, mergedInto));
    if (end) landed.set(row.id, end);
  }
  return landed;
}

/**
 * Resolve many typed skills at once (one round-trip per lookup kind, not per
 * skill). Returns a map from each raw input to its canonical skill, or `null`
 * when nothing in the org's vocabulary matches — free text stays free text.
 *
 * Order of lookup for one input: a skill whose key IS the fold (or the key a
 * new skill of that name would get), then an alias with that fold; then the
 * merge chain is followed to the skill it ends at.
 */
export async function resolveMany(
  orgId: string,
  raws: readonly string[],
  options: ResolveOptions = {},
): Promise<Map<string, ResolvedSkill | null>> {
  const out = new Map<string, ResolvedSkill | null>();
  const foldOf = new Map<string, string>();
  for (const raw of raws) {
    const folded = skillKey(raw);
    out.set(raw, null);
    if (folded) foldOf.set(raw, folded);
  }
  if (foldOf.size === 0) return out;

  const folds = [...new Set(foldOf.values())];
  const keys = [...new Set(folds.flatMap((f) => [f, skillKeyFromFolded(f)]))];

  const [direct, aliases] = await Promise.all([
    prisma.skill.findMany({ where: { orgId, key: { in: keys } }, select: SKILL_SELECT }),
    prisma.skillAlias.findMany({
      where: { orgId, key: { in: folds } },
      select: { key: true, skill: { select: SKILL_SELECT } },
    }),
  ]);
  const byKey = new Map(direct.map((row) => [row.key, row]));
  const byAlias = new Map(aliases.map((row) => [row.key, row.skill]));

  const hits = new Map<string, SkillRow>();
  for (const [raw, folded] of foldOf) {
    const row = byKey.get(folded) ?? byKey.get(skillKeyFromFolded(folded)) ?? byAlias.get(folded);
    if (row) hits.set(raw, row);
  }

  const landed = await landMerges(orgId, [...hits.values()]);
  for (const [raw, row] of hits) {
    const end = landed.get(row.id) ?? row;
    if (end.status !== 'ACTIVE' && !options.includeRetired) continue;
    out.set(raw, strip(end));
  }
  return out;
}

/** Resolve one typed skill ("ReactJS" → the org's React row), or `null`. */
export async function resolveSkill(
  orgId: string,
  raw: string,
  options: ResolveOptions = {},
): Promise<ResolvedSkill | null> {
  return (await resolveMany(orgId, [raw], options)).get(raw) ?? null;
}

/**
 * The skills near `skillIds`: every origin at weight 1, neighbours up to
 * `depth` hops away at the product of edge weights (see `expandAdjacency`).
 * Neighbours that are retired or merged away are dropped — a match must never
 * be explained by a skill the org has withdrawn — but an origin is always kept.
 */
export async function expandAdjacent(
  orgId: string,
  skillIds: readonly string[],
  depth: number = DEFAULT_EXPANSION_DEPTH,
): Promise<WeightedSkill[]> {
  const origins = [...new Set(skillIds)];
  if (origins.length === 0) return [];
  const hops = Math.max(0, Math.min(MAX_EXPANSION_DEPTH, Math.floor(depth)));

  const edges: SkillEdgeRow[] = [];
  const seenEdges = new Set<string>();
  const visited = new Set<string>(origins);
  let frontier = origins;
  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const rows = await prisma.skillEdge.findMany({
      where: { orgId, OR: [{ fromSkillId: { in: frontier } }, { toSkillId: { in: frontier } }] },
      select: { id: true, fromSkillId: true, toSkillId: true, weight: true, kind: true },
    });
    const next: string[] = [];
    for (const row of rows) {
      if (seenEdges.has(row.id)) continue;
      seenEdges.add(row.id);
      edges.push(row);
      for (const id of [row.fromSkillId, row.toSkillId]) {
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  const expanded = expandAdjacency(origins, edges, hops);
  const neighbourIds = expanded.map((w) => w.skillId).filter((id) => !origins.includes(id));
  if (neighbourIds.length === 0) return expanded;

  const live = await prisma.skill.findMany({
    where: { orgId, id: { in: neighbourIds }, status: 'ACTIVE', mergedIntoId: null },
    select: { id: true },
  });
  const liveIds = new Set(live.map((row) => row.id));
  return expanded.filter((w) => origins.includes(w.skillId) || liveIds.has(w.skillId));
}

/**
 * Give an org the starter vocabulary (#1816): one Skill per seed entry, its
 * labels and spellings as aliases, its adjacency as ADJACENT edges at
 * `DEFAULT_EDGE_WEIGHT`. Idempotent and additive — it only ever INSERTs what is
 * missing (`skipDuplicates` on every natural key), so it never undoes a
 * curator's merge, retirement, relabel or reweighting, and two concurrent runs
 * cannot double anything. Returns how many rows of each kind it added.
 */
export async function seedSkillTaxonomy(
  orgId: string,
): Promise<{ skills: number; aliases: number; edges: number }> {
  const index = buildSkillIndex(skillKey, SKILL_SEED);

  const skills = await prisma.skill.createMany({
    data: SKILL_SEED.map((entry) => ({
      orgId,
      key: entry.key,
      labelEn: entry.labelEn,
      labelTr: entry.labelTr,
      labelDe: entry.labelDe,
      category: entry.category,
    })),
    skipDuplicates: true,
  });

  const rows = await prisma.skill.findMany({
    where: { orgId, key: { in: SKILL_SEED.map((e) => e.key) } },
    select: { id: true, key: true },
  });
  const idOf = new Map(rows.map((row) => [row.key, row.id]));

  // Every lookup token the in-memory index knows, minus the key itself (which
  // `resolveMany` matches directly). The index already settled any token two
  // entries claim — first claimant wins — so the alias rows agree with it.
  const aliasData: { orgId: string; skillId: string; key: string }[] = [];
  for (const [token, key] of index.tokens) {
    const skillId = idOf.get(key);
    if (!skillId || token === key || token.length > 64) continue;
    aliasData.push({ orgId, skillId, key: token });
  }
  const aliases = await prisma.skillAlias.createMany({ data: aliasData, skipDuplicates: true });

  // ADJACENT is undirected: store each pair once, smaller key first — and not
  // at all when a curator already linked the pair in either direction (the
  // unique key only sees one direction).
  const existing = await prisma.skillEdge.findMany({
    where: { orgId, fromSkillId: { in: [...idOf.values()] } },
    select: { fromSkillId: true, toSkillId: true },
  });
  const linked = new Set(existing.flatMap((e) => [`${e.fromSkillId}>${e.toSkillId}`, `${e.toSkillId}>${e.fromSkillId}`]));
  const edgeData: { orgId: string; fromSkillId: string; toSkillId: string; weight: number; kind: string }[] = [];
  for (const [key, neighbours] of index.adjacency) {
    for (const other of neighbours) {
      if (key >= other) continue;
      const fromSkillId = idOf.get(key);
      const toSkillId = idOf.get(other);
      if (!fromSkillId || !toSkillId || linked.has(`${fromSkillId}>${toSkillId}`)) continue;
      edgeData.push({ orgId, fromSkillId, toSkillId, weight: DEFAULT_EDGE_WEIGHT, kind: 'ADJACENT' });
    }
  }
  const edges = await prisma.skillEdge.createMany({ data: edgeData, skipDuplicates: true });

  return { skills: skills.count, aliases: aliases.count, edges: edges.count };
}

// ─── Suggest + dual-write (#1818) ────────────────────────────────────────────

/** Orgs this process has already seen with a vocabulary — skips the count query. */
const seededOrgs = new Set<string>();

/**
 * Make sure an org has its starter vocabulary before anything reads or writes
 * against it. An org created after the deploy's backfill would otherwise offer
 * an empty picker until the next deploy. Cheap after the first call.
 */
export async function ensureSkillTaxonomy(orgId: string): Promise<void> {
  if (seededOrgs.has(orgId)) return;
  const count = await prisma.skill.count({ where: { orgId } });
  if (count === 0) await seedSkillTaxonomy(orgId);
  seededOrgs.add(orgId);
}

export interface SkillSuggestion {
  id: string;
  key: string;
  label: string;
}

export const SUGGEST_DEFAULT_LIMIT = 8;
export const SUGGEST_MAX_LIMIT = 20;

/**
 * Autocomplete over an org's ACTIVE vocabulary: a label (any of the three) or
 * an alias that starts with what was typed, then labels that merely contain it.
 * Labels compare case-insensitively through the column collation; aliases by
 * the fold, so "ReactJS" and "yazilim" find their skills too.
 */
export async function suggestSkills(
  orgId: string,
  q: string,
  locale: string,
  limit: number = SUGGEST_DEFAULT_LIMIT,
): Promise<SkillSuggestion[]> {
  const typed = q.trim().slice(0, 60);
  const folded = skillKey(typed);
  if (!folded) return [];
  const take = Math.max(1, Math.min(SUGGEST_MAX_LIMIT, Math.floor(limit) || SUGGEST_DEFAULT_LIMIT));
  await ensureSkillTaxonomy(orgId);

  const live = { orgId, status: 'ACTIVE', mergedIntoId: null };
  const select = { id: true, key: true, labelEn: true, labelTr: true, labelDe: true } as const;
  const [byLabel, byAlias, byContains] = await Promise.all([
    prisma.skill.findMany({
      where: {
        ...live,
        OR: [
          { labelEn: { startsWith: typed } },
          { labelTr: { startsWith: typed } },
          { labelDe: { startsWith: typed } },
          { key: { startsWith: folded } },
        ],
      },
      select,
      take: SUGGEST_MAX_LIMIT,
    }),
    prisma.skillAlias.findMany({
      where: { orgId, key: { startsWith: folded }, skill: live },
      select: { skill: { select } },
      take: SUGGEST_MAX_LIMIT,
    }),
    prisma.skill.findMany({
      where: {
        ...live,
        OR: [{ labelEn: { contains: typed } }, { labelTr: { contains: typed } }, { labelDe: { contains: typed } }],
      },
      select,
      take: SUGGEST_MAX_LIMIT,
    }),
  ]);

  const out: SkillSuggestion[] = [];
  const seen = new Set<string>();
  const push = (rows: { id: string; key: string; labelEn: string; labelTr: string; labelDe: string }[]) => {
    const ranked = rows
      .map((row) => ({ row, label: skillLabel(row, locale) }))
      .sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label));
    for (const { row, label } of ranked) {
      if (seen.has(row.id) || out.length >= take) continue;
      seen.add(row.id);
      out.push({ id: row.id, key: row.key, label });
    }
  };
  push(byLabel);
  push(byAlias.map((a) => a.skill));
  push(byContains);
  return out;
}

/**
 * Dual-write (#1818): mirror a person's free-text `User.skills` onto `UserSkill`.
 * The JSON stays the source of truth until the contract PR, so the mirror is
 * exactly "what that list resolves to": missing rows are created, rows whose
 * skill left the list are removed. A term nothing resolves is parked in the
 * curation queue (`UnmappedSkillTerm`, PENDING) — never dropped. The next
 * deploy's backfill recomputes the queue's occurrence counts.
 *
 * Never throws: the person's save already happened, and a mirror that failed
 * is repaired by the next backfill. Callers just `await` it.
 */
export async function syncUserSkills(userId: string, orgId: string | null, skills: readonly string[]): Promise<void> {
  if (!orgId) return;
  try {
    const wanted = await resolveForSync(orgId, skills);
    const current = await prisma.userSkill.findMany({ where: { userId }, select: { skillId: true } });
    const have = new Set(current.map((r) => r.skillId));
    const stale = [...have].filter((id) => !wanted.has(id));
    if (stale.length > 0) await prisma.userSkill.deleteMany({ where: { userId, skillId: { in: stale } } });
    const fresh = [...wanted].filter((id) => !have.has(id));
    if (fresh.length > 0) {
      await prisma.userSkill.createMany({
        data: fresh.map((skillId) => ({ userId, skillId, source: 'SELF' })),
        skipDuplicates: true,
      });
    }
  } catch (err) {
    logger.warning('skills.sync_user_failed', { userId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Same as `syncUserSkills`, for a requisition's `requiredSkills`. */
export async function syncRequisitionSkills(requisitionId: string, orgId: string, skills: readonly string[]): Promise<void> {
  try {
    const wanted = await resolveForSync(orgId, skills);
    const current = await prisma.requisitionSkill.findMany({ where: { requisitionId }, select: { skillId: true } });
    const have = new Set(current.map((r) => r.skillId));
    const stale = [...have].filter((id) => !wanted.has(id));
    if (stale.length > 0) await prisma.requisitionSkill.deleteMany({ where: { requisitionId, skillId: { in: stale } } });
    const fresh = [...wanted].filter((id) => !have.has(id));
    if (fresh.length > 0) {
      await prisma.requisitionSkill.createMany({
        data: fresh.map((skillId) => ({ requisitionId, skillId, required: true })),
        skipDuplicates: true,
      });
    }
  } catch (err) {
    logger.warning('skills.sync_requisition_failed', { requisitionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Resolve a list for a mirror write; queue what does not resolve. */
async function resolveForSync(orgId: string, skills: readonly string[]): Promise<Set<string>> {
  await ensureSkillTaxonomy(orgId);
  const resolved = await resolveMany(orgId, skills);
  const wanted = new Set<string>();
  const unmapped = new Map<string, string>();
  for (const raw of skills) {
    const hit = resolved.get(raw);
    if (hit) wanted.add(hit.id);
    else {
      const key = skillKey(raw);
      if (key && key.length <= MAX_SKILL_KEY_LENGTH && !unmapped.has(key)) unmapped.set(key, raw.trim().slice(0, 60));
    }
  }
  if (unmapped.size > 0) {
    await prisma.unmappedSkillTerm.createMany({
      data: [...unmapped].map(([normalizedKey, term]) => ({ orgId, normalizedKey, term, occurrences: 1 })),
      skipDuplicates: true,
    });
  }
  return wanted;
}

// ─── Overlap inputs (#1821) ──────────────────────────────────────────────────

/**
 * The org's edges touching `skillIds` — exactly what `skillOverlap()` /
 * `requisitionSkillMatch()` need for one-hop adjacency from those skills.
 * Edges into a retired or merged skill are dropped: a match is never explained
 * by a skill the org has withdrawn.
 */
export async function loadSkillEdges(orgId: string, skillIds: readonly string[]): Promise<SkillEdgeRow[]> {
  const ids = [...new Set(skillIds)];
  if (ids.length === 0) return [];
  const live = { status: 'ACTIVE', mergedIntoId: null };
  return prisma.skillEdge.findMany({
    where: {
      orgId,
      OR: [{ fromSkillId: { in: ids } }, { toSkillId: { in: ids } }],
      from: live,
      to: live,
    },
    select: { fromSkillId: true, toSkillId: true, weight: true, kind: true },
  });
}

/** Display labels for skill ids, in `locale` (EN fallback). */
export async function skillLabels(orgId: string, skillIds: readonly string[], locale: string): Promise<Map<string, string>> {
  const ids = [...new Set(skillIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.skill.findMany({
    where: { orgId, id: { in: ids } },
    select: { id: true, labelEn: true, labelTr: true, labelDe: true },
  });
  return new Map(rows.map((r) => [r.id, skillLabel(r, locale)]));
}
