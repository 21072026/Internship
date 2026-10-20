// The skill-taxonomy rules the deploy-time backfill needs, in plain ESM (#1819).
//
// WHY A SECOND COPY EXISTS
//   `src/lib/skillTaxonomyRule.ts`, `src/lib/skillSeed.ts` (`buildSkillIndex`)
//   and `src/lib/skillsResolve.ts` are the source of truth. The backfill next to
//   this file runs as `node prisma/*.mjs` in the image (Node 20: no type
//   stripping, no `@/` alias), so it cannot import them — the same split
//   `skill-split.mjs` lives with. The starter vocabulary itself comes in as
//   `prisma/skill-seed.json`, generated from `skillSeed.ts` by
//   `npm run skills:seed-json`.
//
//   `scripts/test/skill-taxonomy-mirror.test.mjs` pins every piece to its
//   original: the JSON to SKILL_SEED, the seed plan to `buildSkillIndex`, the key
//   derivation and the merge walk to `skillTaxonomyRule.ts`. Change one, change
//   the other, in the same commit.
//
// Free of imports, so the test loads it without a database.

export const MAX_SKILL_KEY_LENGTH = 64;
export const DEFAULT_EDGE_WEIGHT = 0.5;

/** Mirror of `skillKeyFromFolded()` in skillTaxonomyRule.ts. */
export function skillKeyFromFolded(folded) {
  return folded.trim().replace(/\s+/g, '-').slice(0, MAX_SKILL_KEY_LENGTH);
}

/** Mirror of `followMerges()` in skillTaxonomyRule.ts. */
export function followMerges(id, mergedInto) {
  const seen = new Set([id]);
  let current = id;
  for (;;) {
    const next = mergedInto.get(current);
    if (!next || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/**
 * The rows `seedSkillTaxonomy()` writes, as plain data: skills, alias tokens
 * (first claimant wins, the key itself excluded) and undirected adjacency pairs
 * (smaller key first). Mirrors `buildSkillIndex` + `seedSkillTaxonomy`.
 */
export function buildSeedPlan(seed, fold) {
  const byKey = new Map();
  const tokens = new Map();
  for (const entry of seed) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    for (const token of [entry.key, entry.labelEn, entry.labelTr, entry.labelDe, ...entry.aliases]) {
      const folded = fold(token);
      if (folded && !tokens.has(folded)) tokens.set(folded, entry.key);
    }
  }
  const pairs = new Set();
  for (const entry of seed) {
    for (const other of entry.adjacent) {
      if (other === entry.key || !byKey.has(other)) continue;
      const [a, b] = entry.key < other ? [entry.key, other] : [other, entry.key];
      pairs.add(`${a}\u0000${b}`);
    }
  }
  return {
    skills: [...byKey.values()].map((e) => ({
      key: e.key, labelEn: e.labelEn, labelTr: e.labelTr, labelDe: e.labelDe, category: e.category,
    })),
    aliases: [...tokens]
      .filter(([token, key]) => token !== key && token.length <= MAX_SKILL_KEY_LENGTH)
      .map(([token, key]) => ({ token, key })),
    edges: [...pairs].sort().map((p) => {
      const [fromKey, toKey] = p.split('\u0000');
      return { fromKey, toKey };
    }),
  };
}

/**
 * An in-memory resolver over one org's rows, with the same lookup order as
 * `resolveMany()`: skill key = fold → skill key = derived key → alias → merge
 * chain → ACTIVE only. Returns the canonical skill id, or null.
 */
export function makeResolver({ skills, aliases }) {
  const byKey = new Map(skills.map((s) => [s.key, s]));
  const byId = new Map(skills.map((s) => [s.id, s]));
  const mergedInto = new Map(skills.map((s) => [s.id, s.mergedIntoId ?? null]));
  const byAlias = new Map(aliases.map((a) => [a.key, a.skillId]));
  return (folded) => {
    if (!folded) return null;
    const hit = byKey.get(folded) ?? byKey.get(skillKeyFromFolded(folded)) ?? byId.get(byAlias.get(folded));
    if (!hit) return null;
    const end = byId.get(followMerges(hit.id, mergedInto)) ?? hit;
    return end.status === 'ACTIVE' ? end.id : null;
  };
}
