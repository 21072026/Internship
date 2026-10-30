// Job names, payload types and run provenance for the queue engine (#1671).
//
// WHY A UNION AND NOT `string`. A queue's payload is the one place where a
// producer and a consumer agree on a shape without ever calling each other:
// `enqueue()` writes JSON, a handler somewhere else reads it back, and nothing
// in between type-checks the hand-off. Naming the jobs in a union and mapping
// each name to its payload type makes that hand-off a compile error instead of
// a runtime `undefined` three weeks later, in a background job nobody is
// watching.
//
// SCOPE / EXTENSION POINT. This union starts with the two housekeeping jobs
// this task itself produces work for. It is deliberately NOT the full list:
//
//   • #1677 replaces the twelve `cron.schedule` callbacks (ten in
//     `src/services/emailService.ts`, two in `src/lib/newsletterDispatch.ts`)
//     with enqueued jobs and adds their names and payloads here.
//   • #1676 owns the schedule REGISTRY that decides which name fires when.
//   • #1673 owns the worker loop that maps a name to a handler.
//
// Adding a name here is additive and safe; inventing those three issues' work
// is not, so this file stops at what #1671 can honestly claim.

/// Where a run came from. Provenance, not status — a failed scheduled run and a
/// failed manual re-run look identical on the row without it, and the
/// operations console (#1607) needs to tell them apart. `'boot'` is a run that
/// fired because the process started, which is the one class of run that can
/// arrive in a burst after a deploy. `'event'` is a delivery `emit()` enqueued
/// for a domain event (#1693).
export type JobTrigger = 'schedule' | 'manual' | 'boot' | 'event';

export const JOB_TRIGGERS: readonly JobTrigger[] = ['schedule', 'manual', 'boot', 'event'] as const;

export function isJobTrigger(value: unknown): value is JobTrigger {
  return typeof value === 'string' && (JOB_TRIGGERS as readonly string[]).includes(value);
}

/// What a handler may report about the work it did.
///
/// COUNTERS ONLY, and the type says so rather than a comment asking nicely:
/// every value is a number, so there is no shape in which an e-mail address, a
/// mentee's name or the body of a message can be put here. The admin surfaces
/// render this more or less verbatim, which is exactly why it may not hold PII.
/// `sanitizeSummary()` in `./queue` re-checks it at runtime, because a
/// JavaScript caller can hand a TypeScript signature anything at all.
export type JobSummary = Record<string, number>;

/// Name → payload. The payload is stored in `Job.payload` (a MySQL JSON column),
/// so every type here must be JSON-round-trippable: no `Date`, no `undefined`
/// as a meaningful value, no class instances. Pass timestamps as ISO strings.
export interface JobPayloadMap {
  /// Retention sweep over the `JobRun` ledger. Registered as an ordinary
  /// schedule entry by #1676 rather than as a hand-rolled timer; the default
  /// window lives in `pruneJobRuns()`.
  'jobs.pruneRuns': { retentionDays?: number };
  /// The daily dead-letter alert (#1674, `src/lib/jobs/dlqAlert.ts`). It runs
  /// off its own `cron.schedule` today; giving it a name here is what lets
  /// #1676 move it onto the queue without inventing one.
  'jobs.deadLetterAlert': Record<string, never>;
  /// One tick of the audit stream (#2012, `src/lib/auditDrain.ts`): ship the
  /// due drains' next batches. Runs off its own `cron.schedule` today, like
  /// the dead-letter alert; the name is here so #1673's worker can take it
  /// over as a handler without inventing one.
  'audit.drain': Record<string, never>;
  /// One tick of the roster-feed waker (#1967, `src/lib/rosterFeedRunner.ts`):
  /// run every enabled feed whose cron expression is due, each under its own
  /// claim on the feed row.
  'roster.sweep': Record<string, never>;
  /// One queued mail (#2944, `src/lib/mailOutbox.ts`). The drain claims only
  /// this name (`claim({ names })`), so no other job's rows are touched by it.
  /// `box` is the whole prepared mail sealed with `secretBox` (purpose
  /// 'mail-outbox') and is set to null on every terminal state; `rcpt` is the
  /// sha256 of the address, never the address — it is what account erasure
  /// deletes by. Everything else is metadata the drain needs before opening
  /// the box: the lane, the deadline and the preference gate's inputs.
  'email.send': {
    v: number;
    lane: 'CRITICAL' | 'TRANSACTIONAL' | 'BULK';
    category: string | null;
    group: string | null;
    userId: string | null;
    orgId: string | null;
    world: string | null;
    rcpt: string;
    /// ISO instant after which the mail is no longer worth sending.
    notAfter: string;
    /// Why it was queued: 'retry' | 'inline_timeout' | 'breaker' | 'lane' |
    /// 'approved' (an operator released a held draft, #2960).
    reason: string;
    ref: string | null;
    box: string | null;
    /// Relay-wide releases so far (mailWorkerRule.ts RELAY_RELEASES_PER_ATTEMPT).
    /// Optional: absent on a fresh row.
    releases?: number;
  };
  /// One /api/v1 bulk import (#3015, `src/lib/api/v1Imports.ts`). The
  /// `ApiImport` row holds the org, the key and the rows; the payload is only
  /// its id, so a payload can never widen what the request was granted.
  'api.import.candidates': { importId: string };
  /// One /api/v1 export (#3002, `src/lib/api/v1Exports.ts`): write the
  /// `ApiExport` row's file. The row carries everything else (org, key,
  /// resource), so a payload can never widen what the request was granted.
  'api.export': { exportId: string };
  /// Re-evaluate every affiliate partner after a commission-plan change (#3170,
  /// `src/lib/affiliatePlanResync.ts`). Enqueued with the org's `orgId`, keyed
  /// on the org and the plan version; the state it reports and resumes from is
  /// `AffiliateProgramSettings.planResync`. `actorId` is the admin who saved
  /// the plan (the writer's audit rows name them).
  'affiliate.planResync': { planVersion: number; actorId: string };
  /// The Klaviyo pull connector's tick (src/lib/klaviyoSync.ts): every enabled
  /// connection whose turn it is. Each connection takes its own lease.
  'klaviyo.sync': Record<string, never>;
  /// IdP certificate-expiry warnings (#1933, src/lib/jobs/ssoCertificateExpiry.ts).
  'sso.certificateExpiry': Record<string, never>;
  // ── The scheduled jobs (#1677, src/jobs/*). Each is enqueued by the
  // scheduler (src/lib/jobs/schedules.ts) with an empty payload — "every
  // tenant, now" — or by GET /api/cron?job=…&enqueue=1 with the narrowing an
  // operator asked for. `at` is an ISO instant that pins the clock (the
  // route's `?at=`), `orgIds` limits a sweep to those tenants.
  'dormancy.sweep': Record<string, never>;
  'dormancy.checkIn': Record<string, never>;
  'reminders.mentorInteraction': Record<string, never>;
  'reminders.stageDeadline': Record<string, never>;
  'reminders.retentionReconsent': Record<string, never>;
  'matching.needMatchAlerts': Record<string, never>;
  'mentorOffers.sweep': Record<string, never>;
  'requests.expirySweep': Record<string, never>;
  'reminders.relationEnding': Record<string, never>;
  'meetings.reminders': Record<string, never>;
  'meetings.seriesReminders': Record<string, never>;
  'meetings.autoLog': Record<string, never>;
  'digest.weeklyMentor': Record<string, never>;
  'digest.dailyActivity': Record<string, never>;
  'digest.unreadMessages': Record<string, never>;
  'reports.weeklyReportReminders': Record<string, never>;
  'reports.subscriptions': ScopedPayload;
  'documents.missingReminders': Record<string, never>;
  'email.healthCheck': Record<string, never>;
  'outbound.expireDrafts': Record<string, never>;
  'auth.trustedDevicePurge': Record<string, never>;
  /// One health sample for the public /status page (#1604, src/lib/statusSample.ts).
  'status.sample': Record<string, never>;
  'ai.artifactRetention': Record<string, never>;
  'newsletter.dispatch': Record<string, never>;
  'newsletter.queue': Record<string, never>;
  'retention.prune': Record<string, never>;
  'usage.rollup': Record<string, never>;
  'trial.reminders': ScopedPayload;
  'relationHealth.sweep': ScopedPayload;
  'surveys.campaigns': ScopedPayload & { batch?: number };
  'evaluations.reminders': ScopedPayload;
  'programJourney.run': ScopedPayload;
  /// One subscriber for one recorded domain event (#1693, src/lib/events/emit.ts).
  /// Names only — the event is read from its `DomainEvent` row and the handler
  /// is resolved by `subscriber` name when the job runs, never serialised.
  'event.deliver': { eventId: string; subscriber: string };
  /// One (event × webhook subscription) delivery (#1695, src/lib/webhookDelivery.ts).
  /// Each attempt writes a `WebhookDelivery` row; the queue's backoff spaces retries.
  'webhook.deliver': { eventId: string; webhookId: string };
  /// The nightly nudge scan (#1684, src/lib/nudges/evaluate.ts): every enabled
  /// condition-scan NudgeRule of every org.
  'nudge.evaluate': Record<string, never>;
  /// One nudge to one person (#1684). Keyed `nudge:<ruleId>:<userId>:<dedupeKey>`;
  /// the NudgeSend row (unique on the same triple) is claimed before the send.
  'nudge.send': { ruleId: string; userId: string; dedupeKey: string; eventId: string | null };
  /// One delayed stage-automation run (#1703, src/lib/automation/evaluate.ts).
  /// The `AutomationRun` row holds the rule, the relation and the org; the
  /// payload is only its id, keyed `automation:<runId>`.
  'automation.run': { runId: string };
  /// One event mail the notification router owes one person (#1710, sender
  /// #1719). Enqueued by the router's e-mail channel (src/lib/notifications/
  /// router.ts, keyed `notify:<dedupeKey>`); rendered by renderNotificationEmail()
  /// — the same renderer the template editor's preview uses — and handed to
  /// sendEmail(). The job's own `orgId` is the recipient's org.
  /// One SCHEDULED announcement whose time has come (#1721). Enqueued by
  /// POST /api/admin/announcements with runAt = scheduledAt, keyed
  /// `announcement:<id>`; dispatchScheduledAnnouncement() claims the row
  /// SCHEDULED → SENDING, so a rerun or a prior cancel sends nothing.
  'announcement.send': { announcementId: string };
  'notification.email': {
    eventKey: string;
    userId: string;
    locale: string;
    params: Record<string, unknown>;
    link: string | null;
    emailGroup: string;
    delivery: 'immediate' | 'batched';
  };
  /// A delivery held to the end of the recipient's quiet hours or an org
  /// blackout day (#1714); the consumer is runDeferredDelivery() in the router.
  'notification.deferred': {
    deliveryId: string;
    channel: string;
    eventKey: string;
    userId: string;
    orgId: string | null;
    locale: string;
    params: Record<string, unknown>;
    link: string;
    dedupeKey: string;
    /** The chat card (#1942), carried so a held reminder keeps its join button. */
    card?: { subjectKey: string; actionUrl: string | null; supersede: boolean } | null;
  };
}

/// The narrowing a manual run may carry. Absent fields mean "every tenant, now".
export interface ScopedPayload {
  orgIds?: string[];
  at?: string;
}

export type JobName = keyof JobPayloadMap;

export type JobPayload<N extends JobName = JobName> = JobPayloadMap[N];

export const JOB_NAMES: readonly JobName[] = [
  'jobs.pruneRuns',
  'jobs.deadLetterAlert',
  'audit.drain',
  'roster.sweep',
  'email.send',
  'api.export',
  'affiliate.planResync',
  'api.import.candidates',
  'sso.certificateExpiry',
  'klaviyo.sync',
  'dormancy.sweep',
  'dormancy.checkIn',
  'reminders.mentorInteraction',
  'reminders.stageDeadline',
  'reminders.retentionReconsent',
  'matching.needMatchAlerts',
  'mentorOffers.sweep',
  'requests.expirySweep',
  'reminders.relationEnding',
  'meetings.reminders',
  'meetings.seriesReminders',
  'meetings.autoLog',
  'digest.weeklyMentor',
  'digest.dailyActivity',
  'digest.unreadMessages',
  'reports.weeklyReportReminders',
  'reports.subscriptions',
  'documents.missingReminders',
  'email.healthCheck',
  'outbound.expireDrafts',
  'auth.trustedDevicePurge',
  'status.sample',
  'ai.artifactRetention',
  'newsletter.dispatch',
  'newsletter.queue',
  'retention.prune',
  'usage.rollup',
  'trial.reminders',
  'relationHealth.sweep',
  'surveys.campaigns',
  'evaluations.reminders',
  'programJourney.run',
  'event.deliver',
  'automation.run',
  'webhook.deliver',
  'nudge.evaluate',
  'nudge.send',
  'notification.email',
  'notification.deferred',
] as const;

export function isJobName(value: unknown): value is JobName {
  return typeof value === 'string' && (JOB_NAMES as readonly string[]).includes(value);
}

/// `Job.name` is `@db.VarChar(64)`. Kept here as a constant so a future name
/// that does not fit fails a test rather than a MySQL insert at 03:00.
export const JOB_NAME_MAX_LENGTH = 64;

/// `Job.lockedBy` is `@db.VarChar(64)` — a worker id longer than this would be
/// truncated by MySQL, and a truncated id can collide with another worker's.
export const WORKER_ID_MAX_LENGTH = 64;
