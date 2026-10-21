// Per-tenant and platform sweeps that used to own their node-cron timer
// (#1677). A scheduled run has an empty payload (every tenant, now); a manual
// run from GET /api/cron?job=…&enqueue=1 may narrow it (`orgIds`, `at`).
//
// Idempotency:
//   newsletter.dispatch    — one NewsletterSend row per recipient; a sent issue is sealed.
//   newsletter.queue       — queues at most the next unused template per cadence slot.
//   usage.rollup           — computed metrics are written absolutely (docs/metering.md).
//   trial.reminders        — each reminder is stamped on the trial; expiry is a state move.
//   reports.subscriptions  — a period is claimed before its report is sent.
//   relationHealth.sweep   — one snapshot per relation per day.
//   surveys.campaigns      — invitations and reminders are claimed per recipient.
//   evaluations.reminders  — due rows are created once; reminders stamped.
//   programJourney.run     — a unique claim per step and person.
//   klaviyo.sync           — each connection takes its own lease and cursor;
//                            a rerun finds the connection busy or up to date.
import { registerJob } from '@/lib/jobs/registry';
import { counters, SWEEP_OPTS } from './summary';
import type { ScopedPayload } from '@/lib/jobs/types';
import { dispatchDueNewsletters, queueScheduledNewsletter } from '@/lib/newsletterDispatch';
import { runUsageRollup } from '@/lib/jobs/usageRollup';
import { runTrialReminders } from '@/lib/jobs/trialReminders';
import { runReportSubscriptions } from '@/lib/jobs/reportSubscriptions';
import { sweepRelationHealth } from '@/lib/jobs/relationHealthSweep';
import { dispatchDueSurveyCampaigns } from '@/lib/surveyCampaigns';
import { sendDueSurveyReminders } from '@/lib/surveyReminders';
import { sendEvaluationReminders } from '@/lib/evaluationDue';
import { runProgramJourney } from '@/lib/programJourney';
import { runKlaviyoTick } from '@/lib/klaviyoSync';

/** `at` as a Date when it parses; anything else is "now". */
export function atOf(p: ScopedPayload | undefined): Date | undefined {
  const at = p?.at;
  return at && !Number.isNaN(Date.parse(at)) ? new Date(at) : undefined;
}

function scope(p: ScopedPayload | undefined): { orgIds?: string[] } {
  return Array.isArray(p?.orgIds) && p.orgIds.length > 0 ? { orgIds: p.orgIds } : {};
}

export function registerPlatformJobs(): void {
  registerJob('newsletter.dispatch', async () => counters(await dispatchDueNewsletters()), SWEEP_OPTS);
  registerJob('newsletter.queue', async () => {
    const r = await queueScheduledNewsletter();
    return { queued: r.queued ? 1 : 0 };
  }, SWEEP_OPTS);
  registerJob('usage.rollup', async () => counters(await runUsageRollup()), SWEEP_OPTS);
  registerJob('trial.reminders', async (p) => counters(await runTrialReminders({ ...scope(p), now: atOf(p) })), SWEEP_OPTS);
  registerJob('reports.subscriptions', async (p) => counters(await runReportSubscriptions({ ...scope(p), now: atOf(p) })), SWEEP_OPTS);
  registerJob('relationHealth.sweep', async (p) => counters(await sweepRelationHealth({ ...scope(p), now: atOf(p) })), SWEEP_OPTS);
  registerJob('surveys.campaigns', async (p) => {
    const now = atOf(p) ?? new Date();
    const opts = { ...scope(p), batch: typeof p?.batch === 'number' && p.batch > 0 ? p.batch : undefined };
    const invited = await dispatchDueSurveyCampaigns(now, opts);
    // The reminder pass (#1889) runs after the invitations, in the same job.
    const reminded = await sendDueSurveyReminders(now, opts);
    return { invitationsDue: invited.due ?? 0, remindersDue: reminded.due ?? 0 };
  }, SWEEP_OPTS);
  registerJob('evaluations.reminders', async (p) => counters(await sendEvaluationReminders(atOf(p) ?? new Date(), scope(p))), SWEEP_OPTS);
  registerJob('programJourney.run', async (p) => {
    const r = await runProgramJourney({ ...scope(p), now: atOf(p) });
    return { delivered: r.delivered, skipped: r.skipped, unresolved: r.unresolved.length };
  }, SWEEP_OPTS);
  registerJob('klaviyo.sync', async () => counters(await runKlaviyoTick()), SWEEP_OPTS);
}
