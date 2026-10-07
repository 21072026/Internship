// The /admin/ai console's arithmetic (#2030) — pure, client-safe, unit-tested
// in scripts/test/ai-console.test.mjs. The queries are src/lib/ai/console.ts;
// this folds what they return into the rows the screen shows.
//
// Aggregation happens in SQL (a groupBy per month, two indexed lookups per
// task for the latency percentiles) — a month of 50 000 calls never becomes
// 50 000 objects. What arrives here is already one row per (task, outcome).

export type AiOutcome = 'ok' | 'parse_error' | 'provider_error';

/** One `groupBy({ by: ['scope', 'outcome'] })` row, flattened. */
export interface UsageGroup {
  scope: string;
  outcome: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface TaskUsage {
  task: string;
  calls: number;
  ok: number;
  parseErrors: number;
  providerErrors: number;
  inputTokens: number;
  outputTokens: number;
  /** Summed list price in micro-dollars, over the calls whose model is priced. */
  costMicros: number;
  /** Answered calls with no price (the model is not in the rate table) — the spend is a floor when this is > 0. */
  unpricedCalls: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

export type UsageTotals = Omit<TaskUsage, 'task' | 'p50LatencyMs' | 'p95LatencyMs'>;

const empty = (task: string): TaskUsage => ({
  task, calls: 0, ok: 0, parseErrors: 0, providerErrors: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, unpricedCalls: 0, p50LatencyMs: null, p95LatencyMs: null,
});

/**
 * Nearest-rank percentile: the 0-based index of the p-th percentile among n
 * values sorted ascending (p in (0, 1]). null when there are none.
 */
export function percentileIndex(n: number, p: number): number | null {
  if (!Number.isInteger(n) || n <= 0) return null;
  return Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
}

/** Rows per task, most-called first, plus the month's totals. */
export function foldUsage(
  groups: UsageGroup[],
  unpriced: Record<string, number>,
  latency: Record<string, { p50: number | null; p95: number | null }> = {},
): { tasks: TaskUsage[]; totals: UsageTotals } {
  const byTask = new Map<string, TaskUsage>();
  for (const g of groups) {
    const row = byTask.get(g.scope) ?? empty(g.scope);
    row.calls += g.calls;
    if (g.outcome === 'parse_error') row.parseErrors += g.calls;
    else if (g.outcome === 'provider_error') row.providerErrors += g.calls;
    else row.ok += g.calls;
    row.inputTokens += g.inputTokens;
    row.outputTokens += g.outputTokens;
    row.costMicros += g.costMicros;
    byTask.set(g.scope, row);
  }
  for (const [task, n] of Object.entries(unpriced)) {
    const row = byTask.get(task);
    if (row) row.unpricedCalls = n;
  }
  for (const [task, l] of Object.entries(latency)) {
    const row = byTask.get(task);
    if (row) {
      row.p50LatencyMs = l.p50;
      row.p95LatencyMs = l.p95;
    }
  }
  const tasks = [...byTask.values()].sort((a, b) => b.calls - a.calls || a.task.localeCompare(b.task));
  const totals = tasks.reduce<UsageTotals>(
    (t, r) => ({
      calls: t.calls + r.calls,
      ok: t.ok + r.ok,
      parseErrors: t.parseErrors + r.parseErrors,
      providerErrors: t.providerErrors + r.providerErrors,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      costMicros: t.costMicros + r.costMicros,
      unpricedCalls: t.unpricedCalls + r.unpricedCalls,
    }),
    { calls: 0, ok: 0, parseErrors: 0, providerErrors: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, unpricedCalls: 0 },
  );
  return { tasks, totals };
}

/** Success rate as a whole percent; null with no calls. A parse_error is an answered call, not a success. */
export function successRate(r: Pick<TaskUsage, 'calls' | 'ok'>): number | null {
  return r.calls > 0 ? Math.round((r.ok / r.calls) * 100) : null;
}

/** Micro-dollars as "$12.34" — or "<$0.01" for a non-zero spend that rounds to nothing. */
export function formatUsd(micros: number): string {
  if (micros > 0 && micros < 5_000) return '<$0.01';
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** The last `count` periods ending at `current`, newest first — the month selector. */
export function recentPeriods(current: string, count = 12): string[] {
  const [y, m] = current.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
