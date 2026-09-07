// THE retention mechanism for this product (#1678).
//
// Before this, exactly one table was ever pruned — the mail delivery ledger —
// and it was pruned by a line buried in the 09:00 reminder tick. Everything
// else grew forever, including two tables that hold personal data: ActivityLog
// (IP addresses and user agents) and PageView (per-user browsing history).
// Keeping personal data after it has stopped being useful is not a disk
// problem, it is a storage-limitation failure (GDPR Art. 5(1)(e)) — and the
// privacy notice already promises we keep data "no longer than necessary".
//
// This module is the registry and the runner. It holds NO Prisma import on
// purpose, for two reasons:
//   1. the policy — which table, which window, on whose authority — is then
//      readable in one file that a reviewer can hold in their head, and
//   2. it can be unit-tested without a database (e2e/retention-registry.unit.spec.ts),
//      which is the only way the "one entry throwing does not abort the rest"
//      rule ever gets exercised. A rule nothing tests is a rule that decays.
// The Prisma-bound entries live next door in `retentionEntries.ts`.
//
// AN ENTRY IS A FUNCTION, NOT A `{ table, dateField }` DESCRIPTOR. That is the
// one design decision everything else follows from. The tables queued behind
// this mechanism do not all delete: Notification (#1646) must never remove an
// unread row, Message (#2056) masks with `deletedForEveryoneAt` instead of
// deleting, and ActivityLog here keeps its evidence rows and strips only the
// network identifiers off them. A generic `deleteMany` descriptor can express
// none of those, so the registry does not offer one.
//
// ONE SCHEDULE. Every table that needs a window registers here; nothing in this
// product gets a second retention timer (see the scope boundary on #1678).

/** The `ActivityLog.action` written once per run, carrying the per-table counts. */
export const RETENTION_ACTIVITY_ACTION = 'retention.pruned';

/**
 * Rows one entry may touch per batch.
 *
 * The failure this defends against is the one that actually takes a product
 * down: a first run against a table that has grown unpruned for a year issues
 * ONE `DELETE ... WHERE createdAt < ?`, InnoDB takes row locks on every matched
 * row for the length of the statement, and every writer to that table queues
 * behind it. 500 keeps each statement short enough that nothing notices, and
 * large enough that the loop is not itself the cost.
 */
export const DEFAULT_RETENTION_BATCH_SIZE = 500;

/**
 * Rows one entry may touch per RUN, across all its batches.
 *
 * The batch size bounds each statement; this bounds the job. Without it the
 * first run after a year of growth still runs for as long as it takes to delete
 * everything, on a box that is also serving requests. With it, a 500k backlog
 * drains over ten nightly runs instead of one long morning, and the entry
 * reports `capped: true` so an operator can see it is still catching up rather
 * than guessing.
 */
export const DEFAULT_RETENTION_MAX_PER_RUN = 50_000;

export interface RetentionContext {
  /** The instant the run started; every cutoff is derived from this one clock. */
  now: Date;
  /** Rows older than this are out of window. */
  cutoff: Date;
  /** The window that produced `cutoff`, in days — for logs and messages. */
  retentionDays: number;
  /** Rows per statement. */
  batchSize: number;
  /** Rows this entry may still touch in this run. */
  budget: number;
}

export interface RetentionOutcome {
  /** Rows removed. */
  deleted: number;
  /** Rows kept but rewritten — the masking case (#2056) and the identifier strip below. */
  masked?: number;
  /** True when the entry hit its budget and there is more to do next run. */
  capped?: boolean;
  /**
   * One short operator-facing note, when the counts alone would mislead — it is
   * rendered into the audit line, so keep it to a handful of characters (the
   * whole line has 191 to share). "Every tenant has this window switched off"
   * and "it ran and found nothing" are both `deleted: 0`; the note is what
   * tells them apart a week later.
   */
  note?: string;
}

export interface RetentionEntry {
  /** Stable identifier, also the label in the run summary. Registering the same key twice replaces it. */
  key: string;
  /**
   * The `SETTING_DEFAULTS` key holding this window, when an operator may change
   * it. Omitted for a window that is a product decision rather than a knob.
   */
  settingKey?: string;
  /** Window in days, used when no setting is configured or the setting is unparseable. */
  defaultDays: number;
  /**
   * WHY this window and not another. Required, and not decoration: a retention
   * period nobody can justify is the one that gets argued about in the middle
   * of a data-protection request. Keep it to one or two sentences.
   */
  reason: string;
  /** Do the work for one run. Must respect `ctx.budget` and `ctx.batchSize`. */
  run: (ctx: RetentionContext) => Promise<RetentionOutcome>;
}

export interface RetentionEntryResult {
  key: string;
  retentionDays: number;
  cutoff: Date;
  deleted: number;
  masked: number;
  capped: boolean;
  note?: string;
  /** Sanitised message when this entry threw. The other entries still ran. */
  error?: string;
}

export interface RetentionRunResult {
  startedAt: Date;
  durationMs: number;
  results: RetentionEntryResult[];
  deleted: number;
  masked: number;
  /** Entries that threw. A non-empty list is the thing to alert on. */
  failed: string[];
}

const registry = new Map<string, RetentionEntry>();

/**
 * Add (or replace) one table's rule.
 *
 * Keyed and idempotent: a module re-evaluated by the dev server, or registered
 * from both the cron bootstrap and a test, leaves one entry rather than two —
 * a duplicated entry would double-count in the summary and halve nothing.
 */
export function registerRetention(entry: RetentionEntry): void {
  registry.set(entry.key, entry);
}

/** Every registered rule, in registration order. */
export function listRetentionEntries(): RetentionEntry[] {
  return [...registry.values()];
}

/** Test seam. Never called by the app. */
export function clearRetentionRegistry(): void {
  registry.clear();
}

export interface BatchPruneOptions {
  /** Ids of up to `take` rows that are out of window, oldest first. */
  selectIds: (take: number) => Promise<string[]>;
  /** Delete (or rewrite) exactly these rows; returns how many it touched. */
  handleBatch: (ids: string[]) => Promise<number>;
  batchSize?: number;
  budget?: number;
}

/**
 * The shared batched sweep every entry uses — select a bounded set of ids, act
 * on exactly those ids, repeat until the table is clean or the budget is spent.
 *
 * Selecting ids first and deleting by primary key (rather than re-stating the
 * date predicate in the DELETE) is what keeps each statement's lock set equal
 * to the rows it actually removes, and it makes the loop terminate on a table
 * that is being written to while the sweep runs.
 *
 * The `handled === 0` guard is not paranoia: an entry whose `handleBatch` no
 * longer matches what `selectIds` returned (a row deleted concurrently, a
 * mis-typed filter) would otherwise select the same ids forever.
 */
export async function pruneInBatches(
  opts: BatchPruneOptions
): Promise<{ processed: number; capped: boolean }> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE);
  const budget = Math.max(0, opts.budget ?? DEFAULT_RETENTION_MAX_PER_RUN);

  let processed = 0;
  while (processed < budget) {
    const take = Math.min(batchSize, budget - processed);
    const ids = await opts.selectIds(take);
    if (ids.length === 0) return { processed, capped: false };

    const handled = await opts.handleBatch(ids);
    if (handled === 0) return { processed, capped: false };
    processed += handled;

    // A short page means the table ran out of out-of-window rows.
    if (ids.length < take) return { processed, capped: false };
  }
  return { processed, capped: true };
}

export interface RetentionRunOptions {
  /** Defaults to the registry. Passed explicitly by tests and by a targeted re-run. */
  entries?: RetentionEntry[];
  now?: Date;
  batchSize?: number;
  maxPerRun?: number;
  /**
   * Window lookup, normally the settings accessor. Returning null (or an
   * unusable value) falls back to the entry's `defaultDays`, so a corrupted
   * setting row can never widen a window to zero and empty a table.
   */
  resolveDays?: (entry: RetentionEntry) => Promise<number | null> | number | null;
}

function coerceDays(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Run every registered entry once.
 *
 * ONE ENTRY THROWING MUST NOT ABORT THE RUN. A retention job that stops at the
 * first error is a job that silently stops pruning the other four tables the
 * day one of them develops a problem — and nobody notices, because the symptom
 * is rows quietly not disappearing. Each entry is caught, recorded and
 * reported; the caller decides what to do about a non-empty `failed`.
 *
 * Entries run in sequence rather than in parallel. They compete for the same
 * MySQL box and the whole point of the batching is to keep the load small and
 * predictable; five concurrent delete loops would undo it.
 */
export async function runRetention(options: RetentionRunOptions = {}): Promise<RetentionRunResult> {
  const entries = options.entries ?? listRetentionEntries();
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const maxPerRun = options.maxPerRun ?? DEFAULT_RETENTION_MAX_PER_RUN;
  const startedAt = now;
  const started = Date.now();
  const results: RetentionEntryResult[] = [];

  for (const entry of entries) {
    let retentionDays = entry.defaultDays;
    try {
      if (options.resolveDays) {
        retentionDays = coerceDays(await options.resolveDays(entry), entry.defaultDays);
      }
    } catch {
      retentionDays = entry.defaultDays;
    }
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

    try {
      const outcome = await entry.run({
        now,
        cutoff,
        retentionDays,
        batchSize,
        budget: maxPerRun,
      });
      results.push({
        key: entry.key,
        retentionDays,
        cutoff,
        deleted: outcome.deleted || 0,
        masked: outcome.masked || 0,
        capped: outcome.capped === true,
        note: outcome.note,
      });
    } catch (e) {
      results.push({
        key: entry.key,
        retentionDays,
        cutoff,
        deleted: 0,
        masked: 0,
        capped: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    startedAt,
    durationMs: Date.now() - started,
    results,
    deleted: results.reduce((sum, r) => sum + r.deleted, 0),
    masked: results.reduce((sum, r) => sum + r.masked, 0),
    failed: results.filter((r) => r.error).map((r) => r.key),
  };
}

/**
 * The run rendered as one short line.
 *
 * Bounded to 191 characters because that is what `ActivityLog.detail` holds:
 * the column is a bare `String?`, which MySQL makes `VARCHAR(191)`, and an
 * oversized value does not truncate — it throws P2000 and loses the whole audit
 * row (#1268). So the line is built to fit: silent tables are dropped, and
 * anything still over the limit is cut with an ellipsis rather than risked.
 *
 * An entry's `note` rides in parentheses after its counts, and a note is by
 * itself enough to make the entry non-silent. Some outcomes are not a number:
 * "every tenant keeps notifications forever" is `deleted: 0`, identical in the
 * audit row to "the table was already clean" unless the note reaches it — and
 * this row is the record an operator audits the sweep from.
 */
export function formatRetentionSummary(result: RetentionRunResult, maxLen = 191): string {
  const parts: string[] = [];
  for (const r of result.results) {
    if (r.error) {
      parts.push(`${r.key}=ERR`);
      continue;
    }
    if (!r.deleted && !r.masked && !r.capped && !r.note) continue;
    const masked = r.masked ? `/${r.masked}m` : '';
    const counts = `${r.deleted}${masked}${r.capped ? '+' : ''}`;
    parts.push(r.note ? `${r.key}=${counts}(${r.note})` : `${r.key}=${counts}`);
  }
  const body = parts.length > 0 ? parts.join(' ') : 'nothing to prune';
  const line = `${body} (${Math.round(result.durationMs / 100) / 10}s)`;
  return line.length <= maxLen ? line : `${line.slice(0, maxLen - 1)}…`;
}
