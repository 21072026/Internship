// Time-in-stage aggregation for /api/admin/analytics/aging (#1427).
//
// Extracted from the route so the arithmetic can be unit-tested without a
// database (scripts/test/stage-aging.test.mjs) — and so the meaning of every
// returned number is written down in one place. The analytics card used to
// print `days.length` as "candidates", which contradicted the pipeline funnel
// on the same page: the funnel counts who SITS in a stage right now, this
// counts stage visits that have already ENDED. Both were right; the label was
// not.
//
// Deliberately dependency-free (no `@/` imports, no Prisma types) so a plain
// `node --experimental-strip-types` test can import it.

const DAY = 24 * 60 * 60 * 1000;

export type StageAgingRelation = {
  /** Distinct-candidate key. The mentee, not the relation: the same person may
   *  hold more than one relation and must not be counted twice. */
  menteeId: string;
  startDate: Date;
  /** Ordered oldest → newest. */
  statusChanges: { fromStatus: string; toStatus: string; createdAt: Date }[];
};

export type StageAgingRow = {
  pipelineStatus: string;
  /** Completed stage visits measured. A candidate who leaves a stage and later
   *  comes back contributes TWO visits; one who never left contributes none —
   *  which is exactly why this is not a candidate count. */
  visits: number;
  /** Distinct candidates behind those visits (`visits` ≥ `candidates`). Still
   *  not the funnel number: the funnel is "sitting there now", this is "has
   *  been through here and moved on". */
  candidates: number;
  avgDays: number;
  medianDays: number;
};

export type StageAgingResult = {
  rows: StageAgingRow[];
  /** Measurements discarded because the computed duration was ≤ 0 (out-of-order
   *  or same-instant StatusChange rows). Surfaced instead of dropped silently so
   *  the loss is visible in the payload; fixing the underlying rows is #894. */
  droppedNonPositive: number;
};

const median = (nums: number[]) => {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Average/median time actually spent per stage, from completed transitions.
 *
 * `inWindow(leftAt)` decides whether a visit counts: a stage counts only if it
 * was LEFT inside the selected date range.
 */
export function computeStageAging(
  relations: StageAgingRelation[],
  inWindow: (leftAt: number) => boolean = () => true
): StageAgingResult {
  const durations = new Map<string, number[]>();
  const menteesByStage = new Map<string, Set<string>>();
  let droppedNonPositive = 0;

  const pushDuration = (stage: string, ms: number, menteeId: string) => {
    if (ms <= 0) {
      droppedNonPositive += 1;
      return;
    }
    if (!durations.has(stage)) durations.set(stage, []);
    durations.get(stage)!.push(ms / DAY);
    if (!menteesByStage.has(stage)) menteesByStage.set(stage, new Set());
    menteesByStage.get(stage)!.add(menteeId);
  };

  for (const r of relations) {
    const changes = r.statusChanges;
    if (changes.length === 0) continue;
    // Initial stage: from relation start until the first recorded transition.
    const firstLeftAt = changes[0].createdAt.getTime();
    if (inWindow(firstLeftAt)) {
      pushDuration(changes[0].fromStatus, firstLeftAt - r.startDate.getTime(), r.menteeId);
    }
    // Each subsequent stage: entered at changes[i], left at changes[i+1].
    for (let i = 0; i < changes.length - 1; i++) {
      const leftAt = changes[i + 1].createdAt.getTime();
      if (inWindow(leftAt)) {
        pushDuration(changes[i].toStatus, leftAt - changes[i].createdAt.getTime(), r.menteeId);
      }
    }
  }

  const rows = Array.from(durations.entries())
    .map(([pipelineStatus, days]) => ({
      pipelineStatus,
      visits: days.length,
      candidates: menteesByStage.get(pipelineStatus)?.size ?? 0,
      avgDays: Math.round(days.reduce((s, d) => s + d, 0) / days.length),
      medianDays: Math.round(median(days)),
    }))
    .sort((a, b) => b.avgDays - a.avgDays);

  return { rows, droppedNonPositive };
}
