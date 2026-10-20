# Canonical skill taxonomy

Epic #1810. Skills used to be free text only (`User.skills`, `Requisition.requiredSkills`,
both JSON arrays); "React", "react" and "React.js" were three skills and nothing could
generalise "React" to "Frontend". The taxonomy is the vocabulary those strings resolve **to**.

## The pieces

| Piece | Where | Issue |
|---|---|---|
| How a typed list splits, the ONE fold (`skillKey()`), per-person caps | `src/lib/skills.ts` | #2314 |
| The curated starter vocabulary (EN/TR/DE labels, aliases, adjacency) | `src/lib/skillSeed.ts`, checked by `npm run check:skills` | #1816 |
| Tables `Skill`, `SkillAlias`, `SkillEdge`, `UserSkill`, `RequisitionSkill` | `prisma/schema.prisma` (next to `Tag`) | #1815 |
| Pure rules: caps, labels, new-skill keys, merge chain, adjacency walk | `src/lib/skillTaxonomyRule.ts` (unit test `scripts/test/skill-taxonomy.test.mjs`) | #1815 |
| DB resolver: `resolveSkill` / `resolveMany` / `expandAdjacent` / `seedSkillTaxonomy` | `src/lib/skillsResolve.ts` (e2e `e2e/skill-taxonomy.spec.ts`) | #1815 |

## Rules that carry weight

- **Additive, expand → backfill → contract.** The JSON columns keep being written exactly as
  before. They are retired only in a separate contract PR once every reader is on the tables.
- **One fold.** Keys and alias keys are `skillKey()` output (starter skills keep their seed key,
  which `check:skills` proves is a fixed point of the fold). Never compare skill strings any
  other way; resolve them.
- **Resolution order:** a `Skill` whose key is the fold (or the key a new skill of that name
  would get, `skillKeyFromFolded`) → a `SkillAlias` with that fold → follow `mergedIntoId` to
  the end of the chain. A `RETIRED` result reads as "no match" unless the caller asks for
  `includeRetired` (the curation screen does, matching does not).
- **Merging never deletes.** A merged skill keeps its row with `mergedIntoId` set, so every old
  reference still resolves. Both graph walks are cycle-safe on any data.
- **Adjacency:** `ADJACENT` edges are stored once and read both ways; `BROADER`/`NARROWER` are
  read from → to. `expandAdjacent()` returns origins at weight 1 and neighbours at the best
  product of edge weights (default one hop, at most three), dropping retired/merged neighbours.
  Starter edges get `DEFAULT_EDGE_WEIGHT` (0.5) — an unmeasured guess, tuned in curation.
- **Tenancy:** `Skill`, `SkillAlias`, `SkillEdge` carry `orgId` and are in `TENANT_MODELS`; the
  resolver also names `orgId` in every query, because backfills and crons run with no tenant
  bound. `UserSkill` / `RequisitionSkill` have no `orgId` — reached through scoped parents, like
  `UserTag`.
- **Seeding** (`seedSkillTaxonomy(orgId)`) only ever inserts what is missing, so it never undoes
  a curator's merge, retirement, relabel or reweighting, and it is safe to run concurrently.
