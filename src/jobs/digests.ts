// Digests and weekly mail (#1677).
//
// Idempotency: every one of these sends through sendEmail() with a
// dedupeKey of (recipient, kind, UTC day) — `dedupeKeyFor(... utcDayKey ...)` —
// or claims its rows first (weekly reports, missing documents:
// createMany(skipDuplicates)), so a rerun on the same day sends nothing new.
import { registerJob } from '@/lib/jobs/registry';
import { counters, SWEEP_OPTS } from './summary';
import {
  sendDailyActivityDigests,
  sendUnreadMessageDigests,
  sendWeeklyMentorDigests,
  sendWeeklyMissingDocumentReminders,
  sendWeeklyReportReminders,
} from '@/services/emailService';

export function registerDigestJobs(): void {
  registerJob('digest.weeklyMentor', async () => counters(await sendWeeklyMentorDigests()), SWEEP_OPTS);
  registerJob('digest.dailyActivity', async () => counters(await sendDailyActivityDigests()), SWEEP_OPTS);
  registerJob('digest.unreadMessages', async () => counters(await sendUnreadMessageDigests()), SWEEP_OPTS);
  registerJob('reports.weeklyReportReminders', async () => counters(await sendWeeklyReportReminders()), SWEEP_OPTS);
  registerJob('documents.missingReminders', async () => counters(await sendWeeklyMissingDocumentReminders()), SWEEP_OPTS);
}
