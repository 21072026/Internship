// Every schedule in the product, in one list (#1676). Pure data — no imports
// beyond types — so the unit test can hold it against the source.
//
// TWO CARRIERS, during the move off node-cron:
//
//   'queue'     — the scheduler tick (`./scheduler`) enqueues a `Job` for each
//                 slot, under the 'scheduler' lease, with missed-slot catch-up;
//                 the worker (#1673) runs it with retries and a JobRun.
//   'node-cron' — still a `cron.schedule` timer in its own module, but fired
//                 through `scheduleLeased()` (`./leasedCron`), so only the
//                 'scheduler' lease holder runs the body. No catch-up yet: a
//                 slot that fires while no replica is up is lost, as before.
//                 #1677 moves each of these onto the queue, and the entry's
//                 carrier changes in the same diff.
//
// The expression of a 'node-cron' entry must match the one in its `source`
// file character for character (the unit test reads the file). Changing a
// cadence means changing both.
//
// TIMEZONE: process local time, i.e. UTC in the containers — see `./cronSlot`.
// `catchUp` applies to 'queue' entries: 'latest' enqueues only the most recent
// missed slot (a digest must not fire six times after a six-hour outage);
// 'none' enqueues a slot only within `ON_TIME_GRACE_MS` of it and skips missed
// ones entirely.

import type { JobName, JobPayloadMap } from './types';

export type CatchUp = 'latest' | 'none';

interface Base {
  /** Stable key — the ScheduleState row id for a queue entry. */
  key: string;
  cron: string;
  why: string;
}

export interface QueueSchedule<N extends JobName = JobName> extends Base {
  carrier: 'queue';
  job: N;
  payload: JobPayloadMap[N];
  catchUp: CatchUp;
  maxAttempts?: number;
}

export interface NodeCronSchedule extends Base {
  carrier: 'node-cron';
  /** The file whose `scheduleLeased('<cron>', …)` call carries it today. */
  source: string;
}

export type Schedule = QueueSchedule | NodeCronSchedule;

function queue<N extends JobName>(s: Omit<QueueSchedule<N>, 'carrier'>): QueueSchedule {
  return { carrier: 'queue', ...s } as QueueSchedule;
}

const EMAIL = 'src/services/emailService.ts';

export const SCHEDULES: readonly Schedule[] = [
  // ── On the queue ──────────────────────────────────────────────────────────
  queue({
    key: 'jobs.deadLetterAlert',
    cron: '45 6 * * *',
    job: 'jobs.deadLetterAlert',
    payload: {},
    catchUp: 'latest',
    // A second run mails a second digest; one retry is plenty for a daily note.
    maxAttempts: 2,
    why: '06:45 UTC, offset from every other daily slot (07:30 digests, 08:15/08:30 weeklies, 09:00 reminders) so it never sits behind the mail-heavy ones.',
  }),
  queue({
    key: 'audit.drain',
    cron: '*/5 * * * *',
    job: 'audit.drain',
    payload: {},
    catchUp: 'latest',
    why: 'Five minutes is the audit stream promise (docs/audit-stream.md); after an outage one tick ships the backlog, since the cursor reads forward.',
  }),
  queue({
    key: 'jobs.pruneRuns',
    cron: '10 4 * * *',
    job: 'jobs.pruneRuns',
    payload: {},
    catchUp: 'latest',
    why: 'The JobRun ledger grows by one row per attempt; 04:10 UTC sits after the 03:20/03:40 housekeeping and before the morning mail.',
  }),

  // ── Still node-cron, leased per tick ──────────────────────────────────────
  {
    carrier: 'node-cron',
    key: 'mentor-reminders',
    cron: '0 9 * * *',
    source: EMAIL,
    why: 'The 09:00 batch: dormancy sweep FIRST (it decides who is dormant), then check-ins, mentor reminders, stage deadlines, re-consent, need-match alerts — the start of a working day.',
  },
  {
    carrier: 'node-cron',
    key: 'meeting-reminders',
    cron: '*/15 * * * *',
    source: EMAIL,
    why: 'The reminder window is 60 min; a quarter-hourly tick is what delivers "about an hour before" (45-60 min). Also project series reminders and meeting auto-logs.',
  },
  { carrier: 'node-cron', key: 'weekly-digest', cron: '0 8 * * 1', source: EMAIL, why: 'Weekly mentor digest, Monday 08:00 — start of the working week.' },
  {
    carrier: 'node-cron',
    key: 'email-health',
    cron: '5 * * * *',
    source: EMAIL,
    why: 'Hourly delivery health check (#1190) and held-draft expiry (#2960); :05 keeps it off the top of the hour.',
  },
  {
    carrier: 'node-cron',
    key: 'missing-document-reminders',
    cron: '30 8 * * 1',
    source: EMAIL,
    why: 'Monday 08:30, offset from the 08:00 digest so the two weeklies do not share a minute.',
  },
  {
    carrier: 'node-cron',
    key: 'ai-artifact-retention',
    cron: '20 3 * * *',
    source: EMAIL,
    why: 'Nightly 03:20 (#2044): nothing generated about a person outlives the org retentionMonths.',
  },
  { carrier: 'node-cron', key: 'activity-digest', cron: '30 7 * * *', source: EMAIL, why: 'Daily mentee-activity digest at 07:30, before the working day.' },
  {
    carrier: 'node-cron',
    key: 'weekly-report-reminders',
    cron: '0 15 * * 5',
    source: EMAIL,
    why: 'Friday 15:00 — the end of the working week, while there is still time to write the report.',
  },
  { carrier: 'node-cron', key: 'unread-message-digest', cron: '20 * * * *', source: EMAIL, why: 'Hourly at :20, offset from the other hourly jobs.' },
  {
    carrier: 'node-cron',
    key: 'trusted-device-purge',
    cron: '40 3 * * *',
    source: EMAIL,
    why: 'Nightly 03:40 housekeeping: trusted devices, refresh grants, login links, stale sign-in devices, idempotency keys.',
  },
  {
    carrier: 'node-cron',
    key: 'newsletter-dispatch',
    cron: '*/15 * * * *',
    source: 'src/lib/newsletterDispatch.ts',
    why: 'Sends issues whose scheduled time has come; quarter-hourly is the scheduling granularity the editor offers.',
  },
  { carrier: 'node-cron', key: 'newsletter-queue', cron: '0 6 * * *', source: 'src/lib/newsletterDispatch.ts', why: 'Daily 06:00: queues the next curated issue ahead of the morning dispatch.' },
  {
    carrier: 'node-cron',
    key: 'retention',
    cron: '20 3 * * *',
    source: 'src/lib/retentionEntries.ts',
    why: 'The one retention job (#1678), nightly 03:20 — the quiet hour.',
  },
  { carrier: 'node-cron', key: 'usage-rollup', cron: '40 2 * * *', source: 'src/lib/jobs/usageRollup.ts', why: 'Nightly billing rollup (#1750) at 02:40, after the day has closed in UTC.' },
  {
    carrier: 'node-cron',
    key: 'trial-reminders',
    cron: '20 5 * * *',
    source: 'src/lib/jobs/trialReminders.ts',
    why: 'Expires the trials that ran out overnight and reminds the rest (#2415), early and ahead of the mail-heavy slots.',
  },
  { carrier: 'node-cron', key: 'report-subscriptions', cron: '25 * * * *', source: 'src/lib/jobs/reportSubscriptions.ts', why: 'Scheduled report delivery (#1905), hourly at :25.' },
  {
    carrier: 'node-cron',
    key: 'relation-health',
    cron: '0 2 * * *',
    source: 'src/lib/jobs/relationHealthSweep.ts',
    why: 'Nightly relationship-health sweep (#1901) at 02:00; mails the at-risk digest.',
  },
  { carrier: 'node-cron', key: 'survey-campaigns', cron: '0 10 * * *', source: 'src/lib/surveyCampaigns.ts', why: 'Survey campaigns (#1887), daily 10:00 — mid-morning.' },
  { carrier: 'node-cron', key: 'evaluation-reminders', cron: '15 8 * * *', source: 'src/lib/evaluationDue.ts', why: 'Evaluation due reminders (#1891), daily 08:15.' },
  { carrier: 'node-cron', key: 'program-journey', cron: '10 7 * * *', source: 'src/lib/programJourney.ts', why: 'Program journey steps (#1852), daily 07:10, in-app only.' },
];

export const QUEUE_SCHEDULES: readonly QueueSchedule[] = SCHEDULES.filter((s): s is QueueSchedule => s.carrier === 'queue');

/** A 'none' slot is still on time this long after it. */
export const ON_TIME_GRACE_MS = 2 * 60_000;
