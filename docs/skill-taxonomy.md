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
| Curation screen `/admin/skills` (vocabulary + review-queue tab) | `src/lib/skillCuration.ts`, `src/components/admin/SkillManager.tsx`, `/api/admin/skills/**` (e2e `e2e/skill-admin.spec.ts`) | #1817 |
| Autocomplete (`GET /api/skills/suggest`) + dual-write on every skill write path | `src/components/ui/SkillsField.tsx`, `syncUserSkills` / `syncRequisitionSkills` in `src/lib/skillsResolve.ts` (e2e `e2e/skill-picker.spec.ts`, `@smoke`) | #1818 |
| Backfill of the free text + unmapped-term queue | `prisma/backfill-skill-taxonomy.mjs`, `src/lib/skillQueue.ts`, `/api/admin/skills/unmapped` (e2e `e2e/skill-backfill.spec.ts`) | #1819 |

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

## The backfill and the review queue (#1819)

`node prisma/backfill-skill-taxonomy.mjs` — **dry run by default**; the deploy runs it with
`--apply` right after `backfill-skill-lists.mjs` (so it maps the re-split entries). `--org <id>`
scopes it to one organization. Per org it seeds the starter vocabulary (insert-missing), maps
each `User.skills` / `Requisition.requiredSkills` entry to `UserSkill` (`source = BACKFILL`) /
`RequisitionSkill`, and parks every unresolved term in `UnmappedSkillTerm`:

- `occurrences` is recomputed **absolutely** on every run (people + requisitions holding it), so
  running twice gives identical counts; a PENDING term nobody holds any more drops to 0.
- An admin's decision (`PROMOTED` / `ALIASED` / `DISCARDED`) is never overwritten by a run.
- `MentorApplication.expertise` is not mapped — an application is not a person yet; approval
  copies it into `User.skills`, which the next run maps. Users with a NULL `orgId` are skipped
  (`backfill-organization.mjs` runs earlier in the deploy) and counted in the output.

The deploy runs on Node 20 inside the image and cannot import TypeScript, so the backfill uses a
plain-ESM copy: `prisma/skill-taxonomy-lib.mjs`, the fold in `prisma/skill-split.mjs`, and
`prisma/skill-seed.json` (regenerate with `npm run skills:seed-json` whenever `skillSeed.ts`
changes). `scripts/test/skill-taxonomy-mirror.test.mjs` fails on any drift — change both sides
in one commit.

The queue: `GET /api/admin/skills/unmapped[?resolution=…]` (most frequent first) and
`POST /api/admin/skills/unmapped/[id]` with `{ action: 'promote' | 'alias' | 'discard', skillId?,
labelEn?, labelTr?, labelDe? }`. ADMIN only, org from the session, another org's term answers
404. Each decision is one guarded `updateMany` out of `PENDING` (a second decision answers 409);
promote and alias then link everybody whose free text carries the term (`linkFreeTextHolders`).

## Autocomplete and dual-write (#1818)

`SkillsField` — the one skills editor every form uses (#2314) — asks `GET /api/skills/suggest?q=`
while typing and offers the org's ACTIVE skills as an ARIA 1.2 combobox. Picking commits the
canonical **label**; the JSON list still holds strings. A term not in the vocabulary can still be
committed with Enter.

Whose vocabulary: signed in → the caller's org (any role; free core, never gated). Signed out → only
`?mentorId=` (a link `/api/apply` would accept → that mentor's org) or
`?context=mentor-application` (the default org, where `/api/mentor-applications` files it);
anything else answers an empty list. Signed-out calls are rate-limited per IP.

**Dual-write.** Every path that writes a skill list calls `syncUserSkills(userId, orgId, skills)`
or `syncRequisitionSkills(...)` after its own write: the `UserSkill` / `RequisitionSkill` rows are
made to equal what the JSON resolves to (missing created, stale removed); unresolved terms are
created as PENDING `UnmappedSkillTerm` rows. The sync never throws — a failed mirror is repaired
by the next deploy's backfill, which also covers the paths that do not sync yet (imports, roster
feed, SSO sync, duplicate merges). Inside a transaction that wrote the requisition, sync **after**
commit: the mirror's FK insert would wait on the transaction's own row lock.
`ensureSkillTaxonomy(orgId)` seeds an org created after the last deploy on first use.

## Curation (#1817)

`/admin/skills` — ADMIN only, in the page and in every route handler; org from the session; another
org's skill answers 404. The rules live in `src/lib/skillCuration.ts`:

- **A spelling is unique per org across keys and aliases.** Adding an alias, creating a skill or
  relabelling one to a spelling another skill owns answers `409 duplicate` — that is a merge, not a
  rename. A relabel keeps the key (keys are forever) and adds the new English label's fold as an
  alias so the label still resolves.
- **Merge** (`POST /api/admin/skills/[id]/merge { targetId }`, previewed by the GET twin) is one
  transaction, guarded on the loser's `mergedIntoId IS NULL`: `UserSkill` / `RequisitionSkill` rows
  move (a row that would duplicate the target's is dropped), aliases move, edges are re-pointed (a
  self-loop or an existing pair is dropped), and the loser stays as a RETIRED row with
  `mergedIntoId` — its key and every alias keep resolving to the target.
- **Retire** hides a skill from suggestions and resolution; nobody's row is removed, so reactivating
  restores it. A merged skill cannot be reactivated.
- **Edges** (`PUT …/edges`) replace a skill's neighbours: every edge leaving it plus every ADJACENT
  edge arriving at it; weights are clamped to 0..1, at most 50, no self-edge.
- `MAX_SKILLS_PER_ORG` is enforced on create; every mutation writes an activity row (`skill.*`).

## Skill filters in SQL (#1820)

`skillTermWhere(orgId, term)` (`src/lib/skillFilter.ts`) is the one "has skill X" filter for the
mentor directory, the admin candidate list and the company talent pool. A term matches a person when
a canonical skill they hold (`UserSkill` → `Skill`) carries it in a label or an alias, **or** their
free-text `User.skills` contains it case-insensitively (an id pre-query — `LIKE` over the JSON's text
in MySQL — so a prefix like "docke" and a term still in the review queue keep working). The result is
a `where`, so each route counts and pages one SQL set; nothing loads the pool into Node. The
directory's JavaScript branch remains only for `language` (still a JSON list) and `accepting`
(derived), and keeps reporting `partial` when its scan cap is reached. Topic and demo environments
run the taxonomy backfill after seeding so their people have `UserSkill` rows.

## Adjacency-weighted matching (#1821)

`skillOverlap(targetIds, holderIds, edges, minAdjacentWeight?)` (`src/lib/skillTaxonomyRule.ts`) is
the one scorer for "how well do these skills cover those" — each target counts once, 1 when the holder
has it, else the weight of the holder's best one-hop neighbour of it. Consumers: mentor suggestions
(mentee's skills covered by a mentor's; `MATCH_RULESET_VERSION = 'rules-v2'`), and requisition match
alerts through `requisitionSkillMatch()` (min(2, required) required skills covered, adjacency
≥ 0.5). The matching engine (#1781/#1787) must import it, never re-implement it. Inputs come from
`loadSkillEdges(orgId, ids)` (edges into retired/merged skills dropped) and labels from
`skillLabels(orgId, ids, locale)`. The adjacency is data: deleting the `SkillEdge` removes the credit.
