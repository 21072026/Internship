// The scheduler tick (#1676): turn "it is 06:45" into exactly one queued job.
//
// Every 30 s each replica that runs the cron (CRON_SECRET set, CRON_ENABLED not
// 0) calls `schedulerTick()`. Only the holder of the 'scheduler' JobLease gets
// past the first line (`./lease`, CLAUDE.md § Single-owner background work —
// losing is quiet). For each 'queue' schedule in `./schedules` it then asks
// `./cronSlot` for the latest slot after the one it last enqueued, and:
//
//   • first sight of a schedule (no ScheduleState row): the latest slot becomes
//     the baseline and is enqueued only if it is on time — a deploy must not
//     fire every daily job the moment it boots;
//   • `catchUp: 'latest'`: the most recent missed slot is enqueued, once,
//     however many were missed;
//   • `catchUp: 'none'`: a slot later than ON_TIME_GRACE_MS is skipped.
//
// ENQUEUE, THEN ADVANCE. The job is enqueued under `idempotencyKey =
// "<key>:<slotISO>"` before ScheduleState moves. A tick that dies in between
// re-enqueues the same key next time, which the unique key turns into a no-op;
// the reverse order would lose the slot. That key is also what makes two
// schedulers on one database — a lease handover, a paused holder waking up —
// enqueue each slot once: the lease makes it rare, the key makes it harmless.
//
// The advance is one conditional write (`from` must still be the value read),
// so a stale ticker can never move a schedule backwards.
//
// Nothing here runs a job body — that is the worker's (`./worker`).

import { latestSlot, parseCron } from './cronSlot';
import { ON_TIME_GRACE_MS, type QueueSchedule } from './schedules';

export interface ScheduleStateStore {
  /** Last enqueued slot per key; a key with no row is absent from the map. */
  read(keys: readonly string[]): Promise<Map<string, Date | null>>;
  /**
   * Move `key` from `from` to `to` in ONE conditional write. `from === undefined`
   * means "no row yet" (insert; a lost insert race returns false). Returns
   * whether this caller's write applied.
   */
  advance(key: string, from: Date | null | undefined, to: Date): Promise<boolean>;
}

export type EnqueueFn = (s: QueueSchedule, slot: Date, idempotencyKey: string) => Promise<unknown>;

export interface SchedulerTickInput {
  now: Date;
  schedules: readonly QueueSchedule[];
  /** Is this replica the 'scheduler' lease holder? Takes or renews it. */
  holdsLease: () => Promise<boolean>;
  states: ScheduleStateStore;
  enqueue: EnqueueFn;
  onError?: (key: string, error: unknown) => void;
}

export interface SchedulerTickSummary {
  leader: boolean;
  enqueued: number;
  skippedMissed: number;
  baselined: number;
  failed: number;
}

export function slotKey(key: string, slot: Date): string {
  return `${key}:${slot.toISOString()}`;
}

export async function schedulerTick(input: SchedulerTickInput): Promise<SchedulerTickSummary> {
  const summary: SchedulerTickSummary = { leader: false, enqueued: 0, skippedMissed: 0, baselined: 0, failed: 0 };
  if (!(await input.holdsLease())) return summary;
  summary.leader = true;

  let states: Map<string, Date | null>;
  try {
    states = await input.states.read(input.schedules.map((s) => s.key));
  } catch (e) {
    input.onError?.('*', e);
    summary.failed = input.schedules.length;
    return summary;
  }

  for (const s of input.schedules) {
    try {
      const seen = states.has(s.key);
      const last = seen ? states.get(s.key) ?? null : undefined;
      const slot = latestSlot(parseCron(s.cron), input.now, last ?? null);
      if (!slot) continue;
      const onTime = input.now.getTime() - slot.getTime() <= ON_TIME_GRACE_MS;

      const due = seen ? s.catchUp === 'latest' || onTime : onTime;
      if (due) {
        await input.enqueue(s, slot, slotKey(s.key, slot));
        summary.enqueued += 1;
      } else if (seen) {
        summary.skippedMissed += 1;
      } else {
        summary.baselined += 1;
      }
      await input.states.advance(s.key, last, slot);
    } catch (e) {
      summary.failed += 1;
      input.onError?.(s.key, e);
    }
  }
  return summary;
}

/** In-memory ScheduleState, for the unit test (and two tickers sharing it). */
export function createMemoryScheduleStateStore(): ScheduleStateStore & { rows: Map<string, Date | null> } {
  const rows = new Map<string, Date | null>();
  return {
    rows,
    read: async (keys) => new Map(keys.filter((k) => rows.has(k)).map((k) => [k, rows.get(k) ?? null])),
    advance: async (key, from, to) => {
      if (from === undefined) {
        if (rows.has(key)) return false;
        rows.set(key, to);
        return true;
      }
      const cur = rows.get(key) ?? null;
      if (!rows.has(key) || (cur?.getTime() ?? null) !== (from?.getTime() ?? null)) return false;
      rows.set(key, to);
      return true;
    },
  };
}
