// The privacy floor for aggregate reports (#1903). Pure — unit-tested in
// scripts/test/report-privacy-floor.test.mjs.
//
// THE RULE. In a report whose rows are groups of people, a group with fewer
// than `minCohort` members is not shown on its own: with three interns in a
// cohort, a "conversion" figure is three people's outcomes, and a works
// council will test exactly that breakdown first. The small groups are merged
// into ONE named bucket instead of being dropped, so the counts still add up
// to the total a reader can check elsewhere — silent omission would make the
// report wrong rather than private.
//
// What the bucket carries: the summed COUNT columns (each is a count of
// people, so the sum is meaningful), and nothing for ratios or averages
// (percent/date/averaged columns become null — an average over a merged
// bucket would be a new number nobody can interpret). And if the bucket
// itself is smaller than the floor — two groups of two — it is still emitted,
// with its count, because the members cannot be told apart inside it.
//
// Not configurable by design: there is no admin setting, query parameter or
// role that lowers the floor. A definition may RAISE it.

import type { ReportColumn } from './definitions';

export const SUPPRESSED_LABEL = '__suppressed__';

export type Row = Record<string, string | number | null>;

export interface FloorResult {
  rows: Row[];
  /** How many groups were merged into the bucket (0 = nothing suppressed). */
  suppressedGroups: number;
}

export function applyMinCohort(
  rows: Row[],
  opts: { columns: ReportColumn[]; sizeColumn: string; labelColumn: string; minCohort: number; summable?: string[] }
): FloorResult {
  const small = rows.filter((r) => Number(r[opts.sizeColumn] ?? 0) < opts.minCohort);
  if (small.length === 0) return { rows, suppressedGroups: 0 };
  const kept = rows.filter((r) => !small.includes(r));
  // Count columns are summed; everything else (ratios, averages, names) is not
  // meaningful for a merged group.
  const summable = new Set(opts.summable ?? opts.columns.filter((c) => c.type === 'number').map((c) => c.key));
  const bucket: Row = {};
  for (const c of opts.columns) {
    if (c.key === opts.labelColumn) bucket[c.key] = SUPPRESSED_LABEL;
    else if (summable.has(c.key)) bucket[c.key] = small.reduce((n, r) => n + Number(r[c.key] ?? 0), 0);
    else bucket[c.key] = null;
  }
  return { rows: [...kept, bucket], suppressedGroups: small.length };
}
