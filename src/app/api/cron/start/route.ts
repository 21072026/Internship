import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { initCronJobs } from '@/services/emailService';
import { initKlaviyoSyncCron } from '@/lib/klaviyoSync';
import { initNewsletterCron } from '@/lib/newsletterDispatch';
import { startScheduler } from '@/lib/jobs/schedulerRuntime';
import { initRetentionCron } from '@/lib/retentionEntries';
import { initUsageRollupCron } from '@/lib/jobs/usageRollup';
import { initTrialRemindersCron } from '@/lib/jobs/trialReminders';
import { initReportSubscriptionsCron } from '@/lib/jobs/reportSubscriptions';
import { initRelationHealthCron } from '@/lib/jobs/relationHealthSweep';
import { initSurveyCampaignsCron } from '@/lib/surveyCampaigns';
import { initEvaluationRemindersCron } from '@/lib/evaluationDue';
import { initProgramJourneyCron } from '@/lib/programJourney';

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
// registered — and so is every other init here and startScheduler(), so a
// retried call is harmless.
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
  // The daily trial sweep (#2415, story #2392). Registered here for the same
  // reason as the four above: it imports emailService to send the reminder, so
  // registering it inside initCronJobs would close a one-way import into a
  // cycle. It also expires the trials that ran out overnight, which is why it
  // runs early (05:20 UTC) rather than behind the mail-heavy slots.
  initTrialRemindersCron();
  // Scheduled report delivery (#1905), hourly. Here for the same reason as the
  // five above: it sends through emailService.
  initReportSubscriptionsCron();
  // The nightly relationship-health sweep (#1901), 02:00 — it mails the
  // at-risk digest through emailService, so it is registered here too.
  initRelationHealthCron();
  // Survey campaigns (#1887), daily 10:00 — they mail through emailService too.
  initSurveyCampaignsCron();
  // Evaluation due reminders (#1891), daily 08:15 — they mail through emailService too.
  initEvaluationRemindersCron();
  // Program journey steps (#1852), daily 07:10 — in-app only, but registered
  // here with the other daily sweeps so #1676 finds every schedule in one place.
  initProgramJourneyCron();
  // The Klaviyo pull connector (docs/integrations/klaviyo.md), every fifteen
  // minutes through scheduleLeased() (a 'node-cron' entry in
  // src/lib/jobs/schedules.ts). Imports leads; never mails one.
  initKlaviyoSyncCron();
  // The queue scheduler (#1676): every 30 s the 'scheduler' lease holder
  // enqueues the due slots of the QUEUE schedules in src/lib/jobs/schedules.ts
  // (the dead-letter alert, the audit stream, the JobRun prune), with missed-
  // slot catch-up; the job worker runs them. Every node-cron timer above fires
  // through scheduleLeased(), so its body too runs on the lease holder only —
  // which is why a second replica no longer needs CRON_ENABLED=0.
  startScheduler();
  return NextResponse.json({ ok: true, started: true });
}
