// The operations console's verdicts (#1607) — pure, no Prisma, unit-tested in
// e2e/operations-rule.unit.spec.ts. `operationsConsole.ts` reads the rows; this
// module says what they mean.
//
// THE POINT OF THE PAGE is that a schedule which never ran is a visible ALARM,
// not an empty cell: "the scheduler never started" looks exactly like "nothing
// happened yet" unless something compares the rows against the cron. So every
// schedule row carries a list of alarm reasons, and an empty list is the only
// thing that reads as healthy.
//
// The reasons, in the order the page names them:
//   • never_enqueued   — no ScheduleState row: the scheduler tick has never
//                        enqueued this schedule (or never ran at all).
//   • scheduler_behind — the latest slot the cron names is older than the grace
//                        and the scheduler has not enqueued it: the lease holder
//                        stopped ticking.
//   • worker_behind    — the slot was enqueued long enough ago and no run has
//                        started since: the worker is not draining the queue.
//                        Only judged when the caller sees every run of the job
//                        (`runsVisible`) — an organization-scoped operator does
//                        not see the platform runs, and an absence it cannot see
//                        is not evidence.
//   • last_run_failed  — the newest finished run threw.
import { latestSlot, parseCron, floorMinute, matchesMinute, MAX_LOOKBACK_MS } from './cronSlot';

export type ScheduleAlarm = 'never_enqueued' | 'scheduler_behind' | 'worker_behind' | 'last_run_failed';

/** The scheduler ticks every 30 s; five minutes of silence past a slot is a stall, not jitter. */
export const SCHEDULER_GRACE_MS = 5 * 60_000;
/** A worker polls continuously; a slot enqueued 15 minutes ago and still not started is a stall. */
export const WORKER_GRACE_MS = 15 * 60_000;

export interface RunFacts {
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean;
}

export interface ScheduleFacts {
  cron: string;
  lastEnqueuedSlot: Date | null;
  /** True when no ScheduleState row exists for the key. */
  stateMissing: boolean;
  lastRun: RunFacts | null;
  runsVisible: boolean;
}

export function scheduleAlarms(f: ScheduleFacts, now: Date): ScheduleAlarm[] {
  const out: ScheduleAlarm[] = [];
  if (f.stateMissing || !f.lastEnqueuedSlot) {
    out.push('never_enqueued');
  } else {
    const expected = latestSlot(parseCron(f.cron), now);
    if (expected && f.lastEnqueuedSlot.getTime() < expected.getTime() && now.getTime() - expected.getTime() > SCHEDULER_GRACE_MS) {
      out.push('scheduler_behind');
    }
    if (
      f.runsVisible &&
      now.getTime() - f.lastEnqueuedSlot.getTime() > WORKER_GRACE_MS &&
      (!f.lastRun || f.lastRun.startedAt.getTime() < f.lastEnqueuedSlot.getTime())
    ) {
      out.push('worker_behind');
    }
  }
  if (f.lastRun && f.lastRun.finishedAt && !f.lastRun.ok) out.push('last_run_failed');
  return out;
}

/** The next slot strictly after `now`, at most `MAX_LOOKBACK_MS` ahead; null when there is none. */
export function nextSlot(cron: string, now: Date): Date | null {
  const m = parseCron(cron);
  const end = now.getTime() + MAX_LOOKBACK_MS;
  for (let t = floorMinute(now).getTime() + 60_000; t <= end; t += 60_000) {
    const d = new Date(t);
    if (matchesMinute(m, d)) return d;
  }
  return null;
}

export const ERROR_WINDOWS = { hour: 60 * 60_000, day: 24 * 60 * 60_000 } as const;
