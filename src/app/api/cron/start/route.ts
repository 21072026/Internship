import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { initCronJobs } from '@/services/emailService';
import { initNewsletterCron } from '@/lib/newsletterDispatch';

// node-cron timers live in this process; nothing about them works on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST — register the node-cron schedules in this server process. Called once at
// boot by src/instrumentation.ts, which cannot import emailService directly:
// middleware.ts makes Next compile instrumentation for the edge runtime too,
// where Prisma/nodemailer fail to resolve (the same constraint the mail bridge
// works around).
//
// initCronJobs() is idempotent — it returns early once 'mentor-reminders' is
// registered — so a retried call is harmless.
//
// Distinct from `GET /api/cron`, which runs every job once, right now, for an
// authenticated ADMIN. This only starts the schedule.
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return NextResponse.json({ error: 'Not configured' }, { status: 503 });

  const got = request.headers.get('x-cron-secret') || '';
  const ok = got.length === expected.length
    && (() => { try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; } })();
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  initCronJobs();
  // Registered here rather than inside initCronJobs so the dependency stays
  // one-way (newsletterDispatch imports emailService, never the reverse, #1469).
  initNewsletterCron();
  return NextResponse.json({ ok: true, started: true });
}
