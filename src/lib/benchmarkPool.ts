// The cross-program benchmark's arithmetic (#542), pure so its anonymity
// floors can be unit-tested (scripts/test/benchmark-pool.test.mjs). The route
// (src/app/api/admin/analytics/benchmark/route.ts) folds the groupBy into one
// `BenchmarkAgg` per program and asks this module what may leave.
//
// TWO FLOORS, each against a different kind of re-identification:
//   • MIN_RELATIONS — a program with fewer relations never enters the pool, so
//     no aggregate can be traced back to a person.
//   • MIN_OTHER_PROGRAMS (#1575) — no platform figure (average or percentile)
//     is returned unless at least this many programs OTHER than the viewer's
//     qualify. An average over one other program IS that program's exact rate;
//     over two, it sits a subtraction away from either. And the viewer's own
//     program is never in the pool it is compared against, or a small pool
//     would let `mine` be subtracted back out of the average.

export const MIN_RELATIONS = 5;
export const MIN_OTHER_PROGRAMS = 3;

export interface BenchmarkAgg {
  total: number;
  hired: number;
  dropped: number;
}

export interface BenchmarkFigures {
  you: { conversion: number; dropRate: number; total: number; hired: number } | null;
  avgConversion: number | null;
  avgDropRate: number | null;
  /** Qualifying programs other than the viewer's. */
  poolSize: number;
  percentile: number | null;
}

export const conversionOf = (a: BenchmarkAgg) => (a.total > 0 ? Math.round((a.hired / a.total) * 100) : 0);
export const dropRateOf = (a: BenchmarkAgg) => (a.total > 0 ? Math.round((a.dropped / a.total) * 100) : 0);

export function benchmarkFigures(byProgram: ReadonlyMap<string, BenchmarkAgg>, myKey: string): BenchmarkFigures {
  const mine = byProgram.get(myKey) ?? null;
  const pool = [...byProgram.entries()]
    .filter(([key, a]) => key !== myKey && a.total >= MIN_RELATIONS)
    .map(([, a]) => a);
  const poolSize = pool.length;
  const open = poolSize >= MIN_OTHER_PROGRAMS;
  const avg = (fn: (a: BenchmarkAgg) => number) =>
    open ? Math.round(pool.reduce((s, a) => s + fn(a), 0) / poolSize) : null;

  let percentile: number | null = null;
  if (mine && open) {
    const myConv = conversionOf(mine);
    percentile = Math.round((pool.filter((a) => conversionOf(a) <= myConv).length / poolSize) * 100);
  }

  return {
    you: mine ? { conversion: conversionOf(mine), dropRate: dropRateOf(mine), total: mine.total, hired: mine.hired } : null,
    avgConversion: avg(conversionOf),
    avgDropRate: avg(dropRateOf),
    poolSize,
    percentile,
  };
}
