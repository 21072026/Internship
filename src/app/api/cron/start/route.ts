import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { startScheduler } from '@/lib/jobs/schedulerRuntime';

// The scheduler tick lives in this process and needs Prisma — never the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST — start the queue scheduler in this server process (#1676/#1677).
// Called once at boot by src/instrumentation.ts, which must stay import-free:
// middleware.ts makes Next compile instrumentation for the edge runtime too,
// where Prisma/nodemailer fail to resolve.
//
// Every scheduled job in the product is declared in src/lib/jobs/schedules.ts.
// Every 30 s the 'scheduler' lease holder enqueues the due slots (with
// missed-slot catch-up), and the job worker — ticked separately by
// instrumentation on every replica — runs them through the handlers in
// src/jobs/. No node-cron timer is registered any more.
//
// Only reached where CRON_SECRET is set and CRON_ENABLED is not 0 (the
// instrumentation gate): the preview DB holds real addresses, so a scheduler
// there would mail real people. startScheduler() is idempotent, so a retried
// call is harmless.
//
// Distinct from `GET /api/cron`, which runs or enqueues one job now, for an
// authenticated ADMIN. This only starts the schedule.
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return NextResponse.json({ error: 'Not configured' }, { status: 503 });

  const got = request.headers.get('x-cron-secret') || '';
  const ok = got.length === expected.length
    && (() => { try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; } })();
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  startScheduler();
  return NextResponse.json({ ok: true, started: true });
}
