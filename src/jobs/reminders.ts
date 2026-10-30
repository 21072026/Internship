// The 09:00 reminder batch, split into one job per sweep (#1677). Today they
// used to run in one `try`, so the first failure skipped the rest; now each
// fails and retries on its own.
//
// THE DORMANCY CHAIN. `dormancy.sweep` decides who counts as a dormant first
// contact today (docs/dormant-first-contacts.md); the check-in mail and the
// mentor interaction reminder READ that state, so they must run after it, not
// beside it. The sweep therefore enqueues both itself, and only when it
// succeeded — a failed sweep retries before anything downstream runs. Both are
// keyed on the sweep's job id, so a retried or re-run sweep enqueues them once.
//
// Idempotency (at-least-once delivery, src/lib/jobs/queue.ts):
//   dormancy.sweep               — sets/clears `dormantSince`; a rerun finds nothing new.
//   dormancy.checkIn             — at most two mails ever, counted on the relation.
//   reminders.mentorInteraction  — `stalenessReminderSentAt` single-shot per window.
//   reminders.stageDeadline      — `deadlineReminderSentAt` + mail dedupeKey.
//   reminders.retentionReconsent — `retentionReminderSentAt`.
//   matching.needMatchAlerts     — createMany(skipDuplicates) on the alert rows.
//   requests.expirySweep         — guarded updateMany on PENDING / nudgeSentAt null (#1775),
//                                  and the Mentor Offers sweep on PENDING / remindedAt null (#1809).
import { registerJob } from '@/lib/jobs/registry';
import { dormancySweepHandler } from './dormancyChain';
import { counters, SWEEP_OPTS } from './summary';
import { enqueue } from '@/lib/jobs/queue';
import { sweepDormantFirstContacts } from '@/lib/dormantFirstContact';
import { sweepMentorOffers } from '@/lib/mentorOffers';
import { sweepMentorshipRequests } from '@/lib/requestExpiry';
import {
  checkRequisitionMatches,
  checkMentorInteractionReminders,
  checkRetentionReminders,
  checkStageDeadlineReminders,
  sendDormantCheckIns,
} from '@/services/emailService';

export function registerReminderJobs(): void {
  registerJob(
    'dormancy.sweep',
    dormancySweepHandler({
      sweep: sweepDormantFirstContacts,
      enqueueNext: (name, idempotencyKey, trigger) => enqueue(name, {}, { idempotencyKey, trigger }),
    }),
    SWEEP_OPTS
  );
  registerJob('dormancy.checkIn', async () => counters(await sendDormantCheckIns()), SWEEP_OPTS);
  registerJob('reminders.mentorInteraction', async () => counters(await checkMentorInteractionReminders()), SWEEP_OPTS);
  registerJob('reminders.stageDeadline', async () => counters(await checkStageDeadlineReminders()), SWEEP_OPTS);
  registerJob('reminders.retentionReconsent', async () => counters(await checkRetentionReminders()), SWEEP_OPTS);
  // Both directions of an unanswered ask in one morning job (#1775 + #1809).
  // Each half is a guarded sweep of its own, so a rerun — or one half throwing
  // after the other committed — repeats nothing: requests claim on
  // status/nudgeSentAt, offers on status/remindedAt.
  registerJob('requests.expirySweep', async () => {
    const requests = await sweepMentorshipRequests();
    const offers = await sweepMentorOffers();
    return counters({ ...requests, offersExpired: offers.expired, offersReminded: offers.reminded });
  }, SWEEP_OPTS);
  registerJob('matching.needMatchAlerts', async () => counters(await checkRequisitionMatches()), SWEEP_OPTS);
  // No schedule of its own any more — the offers ride requests.expirySweep. Kept
  // registered so a row queued before that change still has a handler to run.
  registerJob('mentorOffers.sweep', async () => counters(await sweepMentorOffers()), SWEEP_OPTS);
}
