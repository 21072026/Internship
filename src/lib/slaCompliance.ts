// The stage-SLA compliance rate (#1723) — the rule, dependency-free so a unit
// test pins it (e2e/sla-compliance.unit.spec.ts).
//
// THE DEFINITION, which the UI prints next to the number:
//
//   Of the stage moves made in the period out of a stage that has a service
//   level, the share made before that service level elapsed — measured from
//   the moment the candidate entered the stage, in calendar days, against the
//   service levels configured today.
//
// The numerator and the denominator are always returned with the percentage;
// an unexplained 87% is a number nobody will defend to a sponsor.
//
// WHAT IS NOT COUNTED (the same populations the overdue list excludes):
//   · moves out of a stage whose clock is stopped (terminal / off-path) —
//     there was no deadline to meet;
//   · moves out of a stage with no service level;
//   · relations whose mentee is in the re-engagement pool — the caller drops
//     them before calling, as analytics/aging does.
//
// Stage entry follows the same history walk as computeStageAging()
// (src/lib/stageAging.ts): the first visit starts at the relation's
// startDate, every later one at the StatusChange that entered it.

const DAY = 24 * 60 * 60 * 1000;

export interface ComplianceRelation {
  startDate: Date;
  /** Ordered oldest → newest. */
  statusChanges: { fromStatus: string; toStatus: string; createdAt: Date }[];
}

export interface ComplianceStageRow {
  stageKey: string;
  met: number;
  total: number;
}

export interface ComplianceResult {
  met: number;
  total: number;
  /** Whole percent, or null when nothing was measured (never a fake 100%). */
  rate: number | null;
  byStage: ComplianceStageRow[];
}

export function computeSlaCompliance(
  relations: ComplianceRelation[],
  slaDays: ReadonlyMap<string, number>,
  window: { from: Date; to: Date },
  clockStopped: (stageKey: string) => boolean
): ComplianceResult {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const rows = new Map<string, ComplianceStageRow>();

  const count = (stage: string, enteredAt: number, leftAt: number) => {
    if (leftAt < from || leftAt >= to) return;
    const days = slaDays.get(stage);
    if (days == null || days <= 0 || clockStopped(stage)) return;
    let row = rows.get(stage);
    if (!row) {
      row = { stageKey: stage, met: 0, total: 0 };
      rows.set(stage, row);
    }
    row.total += 1;
    if (leftAt - enteredAt <= days * DAY) row.met += 1;
  };

  for (const r of relations) {
    const changes = r.statusChanges.filter((c) => c.fromStatus !== c.toStatus);
    if (changes.length === 0) continue;
    count(changes[0].fromStatus, r.startDate.getTime(), changes[0].createdAt.getTime());
    for (let i = 0; i < changes.length - 1; i++) {
      count(changes[i].toStatus, changes[i].createdAt.getTime(), changes[i + 1].createdAt.getTime());
    }
  }

  const byStage = Array.from(rows.values()).sort((a, b) => b.total - a.total);
  const met = byStage.reduce((n, r) => n + r.met, 0);
  const total = byStage.reduce((n, r) => n + r.total, 0);
  return { met, total, rate: total ? Math.round((met / total) * 100) : null, byStage };
}
