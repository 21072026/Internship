import { enqueue } from './queue';
import { releaseLease, replicaId, SCHEDULER_LEASE } from './lease';
import { holdsSchedulerLease, SCHEDULER_TICK_MS, stopSchedulerLeasing } from './leasedCron';
import { QUEUE_SCHEDULES } from './schedules';
import { schedulerTick } from './scheduler';
import { prismaScheduleStateStore } from './scheduleStateStore';
import { logger } from '@/lib/logger';

// Starts the 30 s scheduler tick in this process (#1676). Called from
// POST /api/cron/start, i.e. only where CRON_SECRET is set and CRON_ENABLED is
// not 0 — the preview/topic safety property is the instrumentation gate's, and
// this file adds no second one. Idempotent per process.

const holder = globalThis as unknown as { __schedulerTimer?: ReturnType<typeof setInterval> };

export async function runSchedulerTickOnce(now: Date = new Date()) {
  return schedulerTick({
    now,
    schedules: QUEUE_SCHEDULES,
    holdsLease: holdsSchedulerLease,
    states: prismaScheduleStateStore(),
    enqueue: (s, _slot, idempotencyKey) =>
      enqueue(s.job, s.payload as never, { idempotencyKey, trigger: 'schedule', maxAttempts: s.maxAttempts }),
    onError: (key, error) => logger.error('scheduler.tick_failed', { schedule: key, error: String(error) }),
  });
}

export function startScheduler(): boolean {
  if (holder.__schedulerTimer) return false;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runSchedulerTickOnce();
      if (r.enqueued || r.skippedMissed || r.failed) logger.info('scheduler.tick', { ...r });
    } catch (e) {
      logger.error('scheduler.tick_failed', { error: String(e) });
    } finally {
      running = false;
    }
  };
  holder.__schedulerTimer = setInterval(tick, SCHEDULER_TICK_MS);
  holder.__schedulerTimer.unref?.();
  void tick();
  // A graceful hand-over: the next replica takes the lease in seconds rather
  // than after the TTL. An optimisation only — expiry is the mechanism.
  process.once('SIGTERM', () => {
    if (holder.__schedulerTimer) clearInterval(holder.__schedulerTimer);
    stopSchedulerLeasing();
    void releaseLease(SCHEDULER_LEASE, replicaId());
  });
  return true;
}
