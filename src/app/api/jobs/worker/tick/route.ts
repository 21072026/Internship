import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createWorker, concurrencyFromEnv, workerEnabled, type JobWorker } from '@/lib/jobs/worker';
import { jobRegistry } from '@/lib/jobs/registry';
import { prismaQueueStore } from '@/lib/jobs/queueStore';
import { replicaId } from '@/lib/jobs/lease';
import { logActivity } from '@/lib/activity';
import { sanitizeError } from '@/lib/sanitizeError';
import { logger } from '@/lib/logger';
import { withRequestScope } from '@/lib/requestContext';
import { registerAllJobs } from '@/jobs';
import { runWithOrg } from '@/lib/orgContext';

// Prisma and the handlers' mail — never the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST — one tick of the job worker (#1673, src/lib/jobs/worker.ts). Ticked
// every few seconds by src/instrumentation.ts on EVERY replica; the request
// stays open until the jobs it claimed have settled, which is what lets Next's
// own SIGTERM handling (stop accepting, wait for open requests) drain the
// worker on a deploy.
//
// THE CREDENTIAL. Same as the mail drain: CRON_SECRET where it is set, else
// JOBS_WORKER_SECRET, which the instrumentation hook mints in this very process
// on an environment without CRON_SECRET. Neither set: 503, never open.
//
// JOBS_WORKER_ENABLED=0 (the deploy canary, which shares production's
// database) answers 200 { skipped } and claims nothing.
export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

function secretOk(got: string, expected: string): boolean {
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

// One worker per process, across hot reloads in dev.
const holder = globalThis as unknown as { __jobWorker?: JobWorker };

/** SIGTERM → stop claiming; release what is still running just before docker's SIGKILL. */
const SHUTDOWN_GRACE_MS = 20_000;

function worker(): JobWorker {
  if (holder.__jobWorker) return holder.__jobWorker;
  registerAllJobs();
  const w = createWorker({
    store: prismaQueueStore(),
    registry: jobRegistry,
    workerId: replicaId(),
    concurrency: concurrencyFromEnv(process.env.JOBS_CONCURRENCY),
    // The mail outbox drains its own rows (src/lib/mailOutbox.ts).
    ownedElsewhere: ['email.send'],
    logger,
    bindOrg: runWithOrg,
    onDeadLetter: (job, error) =>
      logActivity({
        action: 'job.dead_letter',
        level: 'error',
        targetType: 'Job',
        targetId: job.id,
        orgId: job.orgId,
        // ActivityLog.detail is VARCHAR(191): one line, cut to fit. The whole
        // error stays on Job.lastError.
        detail: `${job.name} · attempt ${job.attempts}/${job.maxAttempts} · ${(sanitizeError(error) ?? '').replace(/\s+/g, ' ').trim()}`.slice(0, 190),
      }),
  });
  holder.__jobWorker = w;
  process.once('SIGTERM', () => {
    void w.shutdown(SHUTDOWN_GRACE_MS);
  });
  void w.checkHandlers();
  return w;
}

async function handlePost(request: Request) {
  const expected = process.env.CRON_SECRET || process.env.JOBS_WORKER_SECRET;
  if (!expected) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (!secretOk(request.headers.get('x-cron-secret') || '', expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!workerEnabled(process.env.JOBS_WORKER_ENABLED)) return NextResponse.json({ ok: true, skipped: 'disabled' });

  const summary = await worker().tick();
  // Quiet when idle — this runs every few seconds.
  if (summary.claimed > 0 || summary.reaped > 0 || summary.released > 0) logger.info('job_worker.tick', { ...summary });
  return NextResponse.json({ ok: true, ...summary });
}
