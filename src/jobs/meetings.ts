// Quarter-hourly meeting work (#1677), one job each so a failing reminder
// no longer skips the auto-log.
//
// Idempotency:
//   meetings.reminders       — `reminderSentAt` single-shot per meeting.
//   meetings.seriesReminders — every occurrence claimed in MeetingSeriesReminder first.
//   meetings.autoLog         — a meeting is logged once (the log row is the claim);
//                              the feedback ask goes only to the ids THIS run logged.
import { registerJob } from '@/lib/jobs/registry';
import { counters, SWEEP_OPTS } from './summary';
import { sendMeetingReminders, sendProjectMeetingSeriesReminders } from '@/services/emailService';
import { sweepMeetingInteractionLogs } from '@/lib/meetingAutoLog';
import { askForMeetingFeedback } from '@/lib/meetingFeedback';

export function registerMeetingJobs(): void {
  registerJob('meetings.reminders', async () => counters(await sendMeetingReminders()), SWEEP_OPTS);
  registerJob('meetings.seriesReminders', async () => counters(await sendProjectMeetingSeriesReminders()), SWEEP_OPTS);
  registerJob('meetings.autoLog', async () => {
    const r = await sweepMeetingInteractionLogs();
    const feedbackAsked = r.logged ? await askForMeetingFeedback(r.loggedIds) : 0;
    return { logged: r.logged, feedbackAsked };
  }, SWEEP_OPTS);
}
