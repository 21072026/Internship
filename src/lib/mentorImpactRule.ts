// "Your impact" — a mentor's own, private, cumulative summary (light
// gamification, 2026-10). The rule, and only the rule.
//
// Dependency-free on purpose — no Prisma, no `@/` imports — so the unit test
// (scripts/test/mentor-impact.test.mjs) loads it under node's strip-only type
// stripping, the same reason src/lib/lastContactRule.ts and
// src/lib/relationHistory.ts are. The query that feeds it lives in
// src/lib/mentorImpact.ts.
//
// WHAT THIS IS NOT (the product rules, docs/research/competitive-analysis-2026-08.md
// §4.5 made points/badges/leaderboards a non-goal; this is the deliberately
// light version the maintainer asked for):
//   * no points, no XP, no badges, no streaks — four plain counts;
//   * never compared with another mentor: the input is ONE mentor's relations
//     and the output has no rank, no percentile, no average to sit above;
//   * nothing rewards LOGGING activity — the billing meter counts relations with
//     logged activity (docs/metering.md), so a number that went up per logged
//     call would nudge a customer's bill. Every count here is about where the
//     PEOPLE went, read from the pipeline, which a logged call does not move.
//
// THE FOUR NUMBERS
//   mentored          distinct people across every relation, any status.
//   active            distinct people with an ACTIVE relation right now.
//   reachedInternship distinct people who were EVER at an internship stage or
//                     anywhere past it on the path — null when the tenant's
//                     pipeline names no internship stage at all (we do not
//                     guess which of a renamed set "is" the internship).
//   reachedOutcome    distinct people who were EVER at one of the tenant's own
//                     finished stages (`outcomeStageKeysFrom().finished`, #1882).
//
// "Ever" is the point: a mentee who was hired and then moved on (or whose
// relation later went to an off-path stage) still counts as reached. The
// history is every stage the relation has been in — the current one, plus both
// ends of each recorded real move (the `fromStatus` of the first move is the
// stage the relation started on, which has no move INTO it).
//
// A HANDOVER IS NOT A VISIT (docs/mentor-transfer.md, #2289): a relation that
// continues a predecessor (`previousRelationId` set, `startsInherited` here)
// was created already standing on the predecessor's stage — `transferMentor`
// copies `pipelineStatus` over. That starting stage was reached under the
// previous mentor, so it is credited there and not here: for such a relation
// only the stages ENTERED by a real move on it count (each move's `toStatus`;
// the current stage is one of those exactly when a move led into it). Without
// this, a mentee handed over at "hired" would read "hired 1 of 1" on the new
// mentor's card on day one — the misattribution the transfer doc forbids.
//
// People, not relations: a person mentored twice by the same mentor (a closed
// relation and a later one) is one person, and reached a stage if any of their
// relations did.

/** The slice of a resolved stage this rule reads. */
export interface ImpactStage {
  key: string;
  order: number;
  isOffPath: boolean;
}

/** One of the mentor's relations, flattened. */
export interface ImpactRelation {
  menteeId: string;
  status: string;
  pipelineStatus: string;
  /** The relation's recorded real moves; order irrelevant. */
  moves: readonly { fromStatus: string; toStatus: string }[];
  /**
   * True when the relation continues a predecessor (a mentor handover): its
   * starting stage was inherited, not reached under this mentor.
   */
  startsInherited?: boolean;
}

export interface MentorImpact {
  mentored: number;
  active: number;
  reachedInternship: number | null;
  reachedOutcome: number;
}

/**
 * The tenant's "internship or beyond" stage keys, or null when its pipeline has
 * no internship stage.
 *
 * `internshipPhaseKeys` is the catalogue's internship phase — the caller passes
 * `PIPELINE_GROUPS`' `internship` group (src/lib/pipeline.ts) so that list has
 * exactly one definition. A key from that phase counts wherever the tenant put
 * it, off-path included: "dropped during the internship" means the person was
 * in one. Beyond those, every ON-PATH stage at or after the first on-path
 * internship stage counts too (job seeking, hired, a stage the tenant added
 * after the internship) — the person got through the internship to get there.
 * An off-path stage outside the phase ("found an internship elsewhere") does
 * not: that internship was not reached on this path.
 */
export function internshipOrBeyondKeys(
  stages: readonly ImpactStage[],
  internshipPhaseKeys: readonly string[],
): string[] | null {
  const phase = new Set(internshipPhaseKeys);
  const present = stages.filter((s) => phase.has(s.key));
  if (present.length === 0) return null;
  const byOrder = [...stages].sort((a, b) => a.order - b.order);
  const anchor = byOrder.find((s) => !s.isOffPath && phase.has(s.key));
  const keys = new Set(present.map((s) => s.key));
  if (anchor) {
    for (const s of byOrder) if (!s.isOffPath && s.order >= anchor.order) keys.add(s.key);
  }
  return byOrder.filter((s) => keys.has(s.key)).map((s) => s.key);
}

/** Every stage this relation reached under its own mentor. */
export function stagesVisited(
  relation: Pick<ImpactRelation, 'pipelineStatus' | 'moves' | 'startsInherited'>,
): Set<string> {
  const entered = relation.moves.map((m) => m.toStatus);
  if (relation.startsInherited) return new Set(entered);
  return new Set([relation.pipelineStatus, ...relation.moves.map((m) => m.fromStatus), ...entered]);
}

/** The four counts for one mentor's relations. */
export function computeMentorImpact(
  relations: readonly ImpactRelation[],
  rule: { finishedKeys: readonly string[]; internshipKeys: readonly string[] | null },
): MentorImpact {
  const finished = new Set(rule.finishedKeys);
  const internship = rule.internshipKeys ? new Set(rule.internshipKeys) : null;

  const mentored = new Set<string>();
  const active = new Set<string>();
  const reachedInternship = new Set<string>();
  const reachedOutcome = new Set<string>();

  for (const r of relations) {
    mentored.add(r.menteeId);
    if (r.status === 'ACTIVE') active.add(r.menteeId);
    const visited = stagesVisited(r);
    for (const key of visited) {
      if (finished.has(key)) reachedOutcome.add(r.menteeId);
      if (internship?.has(key)) reachedInternship.add(r.menteeId);
    }
  }

  return {
    mentored: mentored.size,
    active: active.size,
    reachedInternship: internship ? reachedInternship.size : null,
    reachedOutcome: reachedOutcome.size,
  };
}
