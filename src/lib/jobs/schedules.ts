// Every schedule in the product, in one list (#1676). Pure data — no imports
// beyond types — so the unit test can hold it against the source.
//
// Every entry is a QUEUE schedule (#1677 moved the last node-cron timers
// here): the scheduler tick (`./scheduler`) enqueues a `Job` for each slot,
// under the 'scheduler' lease, with missed-slot catch-up, and the worker
// (#1673) runs it with retries and a JobRun. Nothing in `src/` calls
// `cron.schedule()` any more; the unit test fails if something does.
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

export type Schedule = QueueSchedule;

function queue<N extends JobName>(s: Omit<QueueSchedule<N>, 'carrier'>): QueueSchedule {
  return { carrier: 'queue', ...s } as QueueSchedule;
}

export const SCHEDULES: readonly Schedule[] = [
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
    key: 'roster.sweep',
    cron: '*/5 * * * *',
    job: 'roster.sweep',
    payload: {},
    catchUp: 'latest',
    why: 'The roster-feed waker (#1967): five minutes is the finest a feed schedule is honoured to; one late tick runs every feed that came due meanwhile once, since due-ness is read from each feed\'s lastRunAt.',
  }),
  queue({
    key: 'jobs.pruneRuns',
    cron: '10 4 * * *',
    job: 'jobs.pruneRuns',
    payload: {},
    catchUp: 'latest',
    why: 'The JobRun ledger grows by one row per attempt; 04:10 UTC sits after the 03:20/03:40 housekeeping and before the morning mail.',
  }),

  // ── The former node-cron jobs (#1677) ────────────────────────────────────
  //
  // The 09:00 batch used to be six sweeps in one `try`. Now four of them are
  // independent schedules, and the other two — the dormancy check-in and the
  // mentor interaction reminder — are CHAIN-ENQUEUED by `dormancy.sweep` on
  // success (src/jobs/reminders.ts), because they read the state the sweep
  // writes. They have no schedule of their own on purpose.
  queue({ key: 'nudge.evaluate', cron: '20 9 * * *', job: 'nudge.evaluate', payload: {}, catchUp: 'latest', why: 'The admin-authored condition-scan nudges (#1684), after the 09:00 dormancy sweep has stamped who is dormant today — the dormancy guard reads that stamp.' }),
  queue({ key: 'dormancy.sweep', cron: '0 9 * * *', job: 'dormancy.sweep', payload: {}, catchUp: 'latest', why: 'The start of the working day. Decides who is a dormant first contact today, then enqueues dormancy.checkIn and reminders.mentorInteraction, which read that state.' }),
  queue({ key: 'reminders.stageDeadline', cron: '0 9 * * *', job: 'reminders.stageDeadline', payload: {}, catchUp: 'latest', why: 'Part of the 09:00 batch: stage service-level reminders and escalations (#817), at the start of the working day.' }),
  queue({ key: 'reminders.retentionReconsent', cron: '0 9 * * *', job: 'reminders.retentionReconsent', payload: {}, catchUp: 'latest', why: 'Part of the 09:00 batch: retention re-consent reminders, one per person per window.' }),
  queue({ key: 'requests.expirySweep', cron: '10 9 * * *', job: 'requests.expirySweep', payload: {}, catchUp: 'latest', why: 'Mentorship requests nobody answered (#1775): one nudge on day 7, expiry on day 14 — part of the morning batch, so the nudge lands at the start of the working day.' }),
  queue({ key: 'matching.needMatchAlerts', cron: '0 9 * * *', job: 'matching.needMatchAlerts', payload: {}, catchUp: 'latest', why: 'Part of the 09:00 batch: company need-match alerts, read at the start of the day.' }),
  queue({ key: 'mentorOffers.sweep', cron: '10 9 * * *', job: 'mentorOffers.sweep', payload: {}, catchUp: 'latest', why: 'Mentor Offers (#1809): expire offers past their 14 days and send each the ONE reminder in its last 3 days, after the 09:00 batch so the mail lands in the working day.' }),
  queue({ key: 'meetings.reminders', cron: '*/15 * * * *', job: 'meetings.reminders', payload: {}, catchUp: 'latest', why: 'The reminder window is 60 min; a quarter-hourly tick is what delivers "about an hour before" (45-60 min).' }),
  queue({ key: 'meetings.seriesReminders', cron: '*/15 * * * *', job: 'meetings.seriesReminders', payload: {}, catchUp: 'latest', why: 'Recurring project meetings: 1h/24h windows, so the same quarter-hourly tick keeps "an hour before" accurate.' }),
  queue({ key: 'meetings.autoLog', cron: '*/15 * * * *', job: 'meetings.autoLog', payload: {}, catchUp: 'latest', why: 'Logs meetings nobody ended (#1489) two hours after they started, and asks for feedback once (#1896); same rows as the reminders.' }),
  queue({ key: 'digest.weeklyMentor', cron: '0 8 * * 1', job: 'digest.weeklyMentor', payload: {}, catchUp: 'latest', why: 'Weekly mentor digest, Monday 08:00 — start of the working week.' }),
  queue({ key: 'email.healthCheck', cron: '5 * * * *', job: 'email.healthCheck', payload: {}, catchUp: 'latest', why: 'Hourly delivery health check (#1190); :05 keeps it off the top of the hour.' }),
  queue({ key: 'outbound.expireDrafts', cron: '5 * * * *', job: 'outbound.expireDrafts', payload: {}, catchUp: 'latest', why: 'Held drafts past their deadline (#2960) expire on the same hourly mail tick.' }),
  queue({ key: 'documents.missingReminders', cron: '30 8 * * 1', job: 'documents.missingReminders', payload: {}, catchUp: 'latest', why: 'Monday 08:30, offset from the 08:00 digest so the two weeklies do not share a minute.' }),
  queue({ key: 'ai.artifactRetention', cron: '20 3 * * *', job: 'ai.artifactRetention', payload: {}, catchUp: 'latest', why: 'Nightly 03:20 (#2044): nothing generated about a person outlives the org retentionMonths.' }),
  queue({ key: 'digest.dailyActivity', cron: '30 7 * * *', job: 'digest.dailyActivity', payload: {}, catchUp: 'latest', why: 'Daily mentee-activity digest at 07:30, before the working day.' }),
  queue({ key: 'reports.weeklyReportReminders', cron: '0 15 * * 5', job: 'reports.weeklyReportReminders', payload: {}, catchUp: 'latest', why: 'Friday 15:00 — the end of the working week, while there is still time to write the report.' }),
  queue({ key: 'digest.unreadMessages', cron: '20 * * * *', job: 'digest.unreadMessages', payload: {}, catchUp: 'latest', why: 'Hourly at :20, offset from the other hourly jobs.' }),
  queue({ key: 'status.sample', cron: '*/5 * * * *', job: 'status.sample', payload: {}, catchUp: 'none', maxAttempts: 1, why: 'The /status history (#1604): one row per 5-minute slot. No catch-up and no retry on purpose — a slot the app could not sample is downtime, and filling it in afterwards would hide exactly that.' }),
  queue({ key: 'auth.trustedDevicePurge', cron: '40 3 * * *', job: 'auth.trustedDevicePurge', payload: {}, catchUp: 'latest', why: 'Nightly 03:40 housekeeping: trusted devices, refresh grants, login links, stale sign-in devices, idempotency keys.' }),
  queue({ key: 'newsletter.dispatch', cron: '*/15 * * * *', job: 'newsletter.dispatch', payload: {}, catchUp: 'latest', why: 'Sends issues whose scheduled time has come; quarter-hourly is the scheduling granularity the editor offers.' }),
  queue({ key: 'newsletter.queue', cron: '0 6 * * *', job: 'newsletter.queue', payload: {}, catchUp: 'latest', why: 'Daily 06:00: queues the next curated issue ahead of the morning dispatch.' }),
  queue({ key: 'retention.prune', cron: '20 3 * * *', job: 'retention.prune', payload: {}, catchUp: 'latest', why: 'The one retention job (#1678), nightly 03:20 — the quiet hour.' }),
  queue({ key: 'usage.rollup', cron: '40 2 * * *', job: 'usage.rollup', payload: {}, catchUp: 'latest', why: 'Nightly billing rollup (#1750) at 02:40, after the day has closed in UTC.' }),
  queue({ key: 'trial.reminders', cron: '20 5 * * *', job: 'trial.reminders', payload: {}, catchUp: 'latest', why: 'Expires the trials that ran out overnight and reminds the rest (#2415), early and ahead of the mail-heavy slots.' }),
  queue({ key: 'reports.subscriptions', cron: '25 * * * *', job: 'reports.subscriptions', payload: {}, catchUp: 'latest', why: 'Scheduled report delivery (#1905), hourly at :25.' }),
  queue({ key: 'relationHealth.sweep', cron: '0 2 * * *', job: 'relationHealth.sweep', payload: {}, catchUp: 'latest', why: 'Nightly relationship-health sweep (#1901) at 02:00; mails the at-risk digest.' }),
  queue({ key: 'surveys.campaigns', cron: '0 10 * * *', job: 'surveys.campaigns', payload: {}, catchUp: 'latest', why: 'Survey campaigns (#1887) and their reminders (#1889), daily 10:00 — mid-morning.' }),
  queue({ key: 'evaluations.reminders', cron: '15 8 * * *', job: 'evaluations.reminders', payload: {}, catchUp: 'latest', why: 'Evaluation due reminders (#1891), daily 08:15.' }),
  queue({ key: 'programJourney.run', cron: '10 7 * * *', job: 'programJourney.run', payload: {}, catchUp: 'latest', why: 'Program journey steps (#1852), daily 07:10, in-app only.' }),
  queue({ key: 'klaviyo.sync', cron: '*/15 * * * *', job: 'klaviyo.sync', payload: {}, catchUp: 'latest', why: 'The Klaviyo pull connector (docs/integrations/klaviyo.md), every 15 minutes — the cadence the owner asked for; each connection also takes its own JobLease and backoff.' }),
  queue({ key: 'sso.certificateExpiry', cron: '40 6 * * *', job: 'sso.certificateExpiry', payload: {}, catchUp: 'latest', why: 'IdP certificate-expiry warnings (#1933), daily 06:40; two mails per certificate, at 30 and 7 days.' }),
];

export const QUEUE_SCHEDULES: readonly QueueSchedule[] = SCHEDULES.filter((s): s is QueueSchedule => s.carrier === 'queue');

/** A 'none' slot is still on time this long after it. */
export const ON_TIME_GRACE_MS = 2 * 60_000;
