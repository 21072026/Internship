// Database observability (#1608): slow-query logging, the per-request query
// count, and the test-only per-model tally the N+1 report reads.
//
// Every Prisma operation passes through `observeQuery` once — the timing
// middleware is installed in `src/lib/prisma.ts`, next to the client it
// measures. This module decides what to do with the measurement and imports
// nothing server-only (no `node:async_hooks`, no Prisma), for the same reason
// `logger.ts` doesn't: the per-request half reaches the request context through
// the dependency-free seam in `requestId.ts`.
//
// NEVER THE PARAMS. A query's arguments carry e-mail addresses, names and
// message bodies (docs/DATA_ACCESS_POLICY.md). What is recorded is the model,
// the action and the duration — and, through the logger, the request id — and
// nothing a query was asked about.

import { logger } from './logger';
import { ambientCountQuery } from './requestId';

/** Response header carrying the request's query count, outside production. */
export const QUERY_COUNT_HEADER = 'x-db-queries';

/** The label a raw query (`$queryRaw`, `$executeRaw`) is counted under. */
export const RAW_QUERY_MODEL = '$raw';

/** Non-production default for the slow-query threshold, in milliseconds. */
export const DEFAULT_DEV_SLOW_QUERY_MS = 200;

/** Queries one request may issue before a warning is logged. */
export const DEFAULT_QUERY_CEILING = 50;

/**
 * The slow-query threshold, or `null` for off.
 *
 * Off in production until a threshold has been measured there — a guessed
 * number either floods the log or says nothing. `DB_SLOW_QUERY_MS` turns it on
 * anywhere; `0` turns it off explicitly. Outside production it defaults to
 * DEFAULT_DEV_SLOW_QUERY_MS so a developer sees the slow ones without asking.
 */
export function parseSlowQueryMs(raw: string | undefined, nodeEnv: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return nodeEnv === 'production' ? null : DEFAULT_DEV_SLOW_QUERY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** The per-request warning ceiling. Unparseable or non-positive falls back to the default. */
export function parseQueryCeiling(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUERY_CEILING;
}

/** The `n` models with the most queries, for a warning line: "Message×31, User×12". */
export function topModels(byModel: Map<string, number>, n = 3): string {
  return [...byModel.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([m, c]) => `${m}×${c}`)
    .join(', ');
}

const slowQueryMs = parseSlowQueryMs(process.env.DB_SLOW_QUERY_MS, process.env.NODE_ENV);

// ── Test-only tally ─────────────────────────────────────────────────────────
//
// The N+1 report (e2e/db-query-report.spec.ts) needs per-model counts for a
// whole PAGE — the server render plus every API call it makes — and a page
// render has no request context of ours to hang a counter on. Playwright runs
// one worker against one server, so a process-wide tally reset before the page
// and read after it is exact enough to report on. Switched on only by
// DB_QUERY_TALLY=1 (set by playwright.config.ts for the e2e server); everywhere
// else it costs one boolean check and its route answers 404.

const tallyEnabled = process.env.DB_QUERY_TALLY === '1';
const tally = new Map<string, number>();

export function queryTallyEnabled(): boolean {
  return tallyEnabled;
}

/** Per-model counts since the last reset, highest first. */
export function readQueryTally(): { total: number; byModel: { model: string; count: number }[] } {
  const byModel = [...tally.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  return { total: byModel.reduce((s, r) => s + r.count, 0), byModel };
}

export function resetQueryTally(): void {
  tally.clear();
}

/**
 * Record one finished Prisma operation. Called by the middleware in prisma.ts;
 * must never throw — a broken observer may not break a query.
 */
export function observeQuery(model: string | undefined, action: string, durationMs: number): void {
  try {
    const key = model ?? RAW_QUERY_MODEL;
    if (slowQueryMs !== null && durationMs >= slowQueryMs) {
      logger.warning('Slow database query', { model: key, action, durationMs: Math.round(durationMs), thresholdMs: slowQueryMs });
    }
    ambientCountQuery(key);
    if (tallyEnabled) tally.set(key, (tally.get(key) ?? 0) + 1);
  } catch {
    // Observability must never become the outage.
  }
}
