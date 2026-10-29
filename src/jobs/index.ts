// Every queue handler in the product, registered by name (#1673). The worker
// route imports this file once; a job whose name is not registered here is
// never claimed and is reported at worker start (`checkHandlers()`).
//
// One `registerJob()` per name. Handlers are at-least-once — each one states
// what makes a second run harmless. The schedule that ENQUEUES them is
// src/lib/jobs/schedules.ts (#1676); the bodies they call stay where the domain
// lives (emailService, newsletterDispatch, …) — only the wiring is here.
import { registerJob } from '@/lib/jobs/registry';
import { pruneJobRuns } from '@/lib/jobs/queue';
import { runDeadLetterAlert } from '@/lib/jobs/dlqAlert';
import { runAuditDrains } from '@/lib/auditDrain';
import { runApiImport } from '@/lib/api/v1Imports';
import { runApiExport } from '@/lib/api/v1Exports';
import { sweepDueRosterFeeds } from '@/lib/rosterFeedRunner';
import { runEventDelivery } from '@/lib/events/emit';
import { runWebhookDelivery } from '@/lib/webhookDelivery';
import { runNudgeScan, runNudgeSend } from '@/lib/nudges/evaluate';
import { runDelayedAutomation } from '@/lib/automation/evaluate';
import { runNotificationEmail } from '@/lib/notifications/emailJob';
import { counters } from './summary';
import { registerReminderJobs } from './reminders';
import { registerMeetingJobs } from './meetings';
import { registerDigestJobs } from './digests';
import { registerHousekeepingJobs } from './housekeeping';
import { registerPlatformJobs } from './platform';

let registered = false;

export function registerAllJobs(): void {
  if (registered) return;
  registered = true;

  // A DELETE by age: a second run deletes nothing new.
  registerJob('jobs.pruneRuns', async (payload) => {
    const days = typeof payload?.retentionDays === 'number' && Number.isFinite(payload.retentionDays) ? payload.retentionDays : undefined;
    return { deleted: await pruneJobRuns(days) };
  });

  // Reads the queue and mails one digest. Not idempotent on its own — a second
  // run mails a second digest — so it is enqueued under a per-day
  // idempotencyKey by its schedule, and maxAttempts bounds the rest.
  registerJob('jobs.deadLetterAlert', async () => {
    const run = await runDeadLetterAlert();
    return { total: run.total, sent: run.sent ? 1 : 0 };
  });

  // The cursor moves only on a 2xx and receivers dedupe on the row id
  // (docs/audit-stream.md), so a repeated tick re-ships at most one batch.
  registerJob('audit.drain', async () => counters(await runAuditDrains()));

  // The former node-cron jobs (#1677), grouped by area; each file states why
  // a rerun of each of its handlers is harmless.
  registerReminderJobs();
  registerMeetingJobs();
  registerDigestJobs();
  registerHousekeepingJobs();
  registerPlatformJobs();

  // A DONE or FAILED import is left alone, and a row the dead attempt already
  // created is found by its e-mail and skipped — nothing is created twice.
  registerJob(
    'api.import.candidates',
    async (payload, { job, attempt, signal }) => ({ ...(await runApiImport(payload.importId, { signal, attempt, maxAttempts: job.maxAttempts })) }),
    { timeoutMs: 10 * 60 * 1000 },
  );
  // A READY or FAILED export is left alone and the file is stored in one
  // guarded update, so a repeated run rewrites at most an unfinished one.
  registerJob('api.export', async (payload, { signal }) => ({ ...(await runApiExport(payload.exportId, signal)) }), {
    timeoutMs: 10 * 60 * 1000,
  });

  // One subscriber for one domain event (#1693). The enqueue is keyed
  // `<eventId>:<subscriber>`, so a retried emit makes no second row; a rerun of
  // the row itself is the subscriber's to tolerate — each one says how in its
  // file under src/lib/events/subscribers/.
  registerJob('event.deliver', async (payload) => {
    const outcome = await runEventDelivery(payload);
    return { [outcome]: 1 };
  }, { timeoutMs: 60_000 });

  // One webhook POST for one (event × subscription) (#1695). Each attempt
  // writes its own WebhookDelivery row and every attempt carries the same
  // X-Delivery-Id, so a rerun is a second delivery the receiver dedupes —
  // at-least-once, documented in docs/api-explorer.md. A FAILED attempt throws
  // and the backoff schedules the next; a DEAD one settles the job.
  registerJob('webhook.deliver', async (payload, { attempt, job }) => {
    const outcome = await runWebhookDelivery(payload, attempt, job.maxAttempts);
    return { [outcome]: 1 };
  }, { timeoutMs: 30_000 });

  // Admin-authored nudges (#1684). The scan only enqueues keyed `nudge.send`
  // jobs and skips anyone who already has the NudgeSend row, so a second scan
  // the same night queues nothing new. A send claims its NudgeSend row (unique)
  // before it mails, so a rerun loses the claim and sends nothing.
  registerJob('nudge.evaluate', async () => counters(await runNudgeScan()), { timeoutMs: 10 * 60_000 });
  registerJob('nudge.send', async (payload) => ({ [await runNudgeSend(payload)]: 1 }), { timeoutMs: 60_000 });

  // A delayed stage-automation run (#1703). The run is claimed PENDING →
  // RUNNING in one guarded update before any action, so a rerun finds it taken
  // and does nothing — the actions are at-most-once by design (engine.ts).
  registerJob('automation.run', async (payload) => runDelayedAutomation(payload.runId), { timeoutMs: 120_000 });

  // One event mail the notification router owes one person (#1719). The
  // NotificationDelivery row is claimed QUEUED → SENT before the send, so a
  // rerun of a job whose mail already left finds it taken and sends nothing.
  registerJob('notification.email', async (payload, ctx) => ({ [await runNotificationEmail(payload, ctx.job)]: 1 }), { timeoutMs: 60_000 });

  // Each feed runs under its own claim (one conditional UPDATE), and a feed
  // whose lastRunAt the first run already moved is no longer due — so a
  // repeated tick runs nothing twice.
  registerJob('roster.sweep', async () => {
    const ran = await sweepDueRosterFeeds();
    return { ran: ran.length, claimedElsewhere: ran.filter((r) => r.status === 'claimed_elsewhere').length };
  });
}
