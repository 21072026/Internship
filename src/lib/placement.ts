// What counts as a PLACEMENT in a number (#1504, story #1502). Client-safe: no
// Prisma import, so the routes, the reports and the unit test read one rule.
//
// Two columns from #1503 decide it, on top of the tenant's own finished stage
// set (`outcomeStageKeys()`, src/lib/pipeline.ts — that part was unified by
// #1882 and is not repeated here):
//
//   · `kind` — only a PLACEMENT relation is in the hiring funnel. A COACHING
//     relation is mentoring with no placement goal: its stage means nothing to
//     a funnel, so it leaves BOTH sides of a placement rate (the hires and the
//     relations they are divided by) and the funnel distribution itself.
//   · `employmentAttribution` — a hire is ours only when it came THROUGH_US.
//     SELF_FOUND and ALREADY_EMPLOYED are honest outcomes, but not placements.
//     NULL ("not stated", every row from before the column) counts, so the
//     numbers of an org that never touched either column do not move.
//
// Every reader that counts placements goes through `countsAsPlacement()` (in
// memory) or `PLACEMENT_RELATION_WHERE` + `OUR_HIRE_WHERE` (in SQL); a reader
// that counts relations for a placement RATE uses `PLACEMENT_RELATION_WHERE`
// for its denominator.

import type { EmploymentAttribution, RelationKind } from './placementKind';

/** The attributions that are honest outcomes but not our placements. */
export const NOT_OUR_HIRE_ATTRIBUTIONS: readonly EmploymentAttribution[] = ['SELF_FOUND', 'ALREADY_EMPLOYED'];

/** Prisma `where` fragment: a relation in the hiring funnel. */
export const PLACEMENT_RELATION_WHERE = { kind: 'PLACEMENT' satisfies RelationKind } as const;

/** Prisma `where` fragment: a hire that is ours (attribution NULL or THROUGH_US). */
export const OUR_HIRE_WHERE = {
  OR: [{ employmentAttribution: null }, { employmentAttribution: { notIn: [...NOT_OUR_HIRE_ATTRIBUTIONS] } }],
};

/** Is this relation part of the hiring funnel at all? A NULL kind (never written) reads as PLACEMENT. */
export function isPlacementRelation(kind: string | null | undefined): boolean {
  return (kind ?? 'PLACEMENT') === 'PLACEMENT';
}

/** Is a hire with this attribution ours? NULL — not stated — is. */
export function isOurHire(attribution: string | null | undefined): boolean {
  return attribution == null || !(NOT_OUR_HIRE_ATTRIBUTIONS as readonly string[]).includes(attribution);
}

/**
 * Does this relation count as a placement? It must be in the funnel, sit on one
 * of the tenant's finished stages, and be ours.
 */
export function countsAsPlacement(
  relation: { kind?: string | null; employmentAttribution?: string | null; pipelineStatus: string },
  finishedStageKeys: ReadonlySet<string> | readonly string[],
): boolean {
  const finished = finishedStageKeys instanceof Set ? finishedStageKeys : new Set(finishedStageKeys as readonly string[]);
  return isPlacementRelation(relation.kind) && finished.has(relation.pipelineStatus) && isOurHire(relation.employmentAttribution);
}
