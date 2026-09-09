import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { initCronJobs } from '@/services/emailService';
import { initNewsletterCron } from '@/lib/newsletterDispatch';
import { initDeadLetterAlertCron } from '@/lib/jobs/dlqAlert';
import { initRetentionCron } from '@/lib/retentionEntries';
import { initUsageRollupCron } from '@/lib/jobs/usageRollup';

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
  // Same reason as above (#1674): the dead-letter alert imports emailService to
  // send its mail, so registering it inside initCronJobs would close the import
  // graph into a cycle.
  initDeadLetterAlertCron();
  // The one retention schedule in the product (#1678). Registered here for the
  // same reason as the two above — it imports emailService for the EmailLog
  // window it took over — and because the mail service should not be the owner
  // of the product's data-retention policy.
  initRetentionCron();
  // The nightly billing rollup (#1750). Registered here for the same reason as
  // the three above — and because the meter must not be owned by the mail
  // service. It ports to the leader-elected scheduler (#1676) as a plain
  // handler, timer and all.
  initUsageRollupCron();
  return NextResponse.json({ ok: true, started: true });
}
