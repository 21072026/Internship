// One-shot baseline for the scheduled jobs (see src/services/emailService.ts).
//
// Why this exists: `initCronJobs()` had no caller, and nothing on the server
// drove `GET /api/cron` either, so the scheduled jobs never ran in production.
// Several of them are "everything not yet marked" queries — the unread-message
// digest selects every message with `digestedAt: null`, with no lower bound on
// age. Switching the scheduler on without a baseline therefore mails out the
// entire accumulated backlog on the first tick: measured on prod before this
// landed, 3 people would have received a digest of messages up to 3 weeks old,
// and one mentor a burst of 7 staleness reminders at once.
//
// So: mark the pre-existing backlog as already handled, once. From then on the
// jobs only ever see genuinely new work.
//
// This is deliberately ONE-SHOT, not merely idempotent. It records
// `cronBaselineAt` in Setting and exits early if that key exists — because
// re-running it would mark *newly* stale relations as reminded on every deploy
// and permanently suppress the reminder feature it is meant to protect. Safe to
// leave wired into deploy-prod.sh forever.
//
// NOT baselined on purpose:
//   - User.retentionReminderSentAt — consent renewal is a compliance path, and
//     suppressing it would silently skip a due renewal. (Nothing is due today:
//     retention is 12 months and the oldest consentAt is 2026-06-30.)
//   - Meeting.reminderSentAt — sendMeetingReminders only looks at meetings in
//     the next 60 minutes, so it has no backlog to suppress.
//   - MentorshipRelation.stalenessReminderSentAt — it gates only the in-app bell
//     item, not the email (the email loop reads every stale relation every run),
//     so baselining it would hide the notification without preventing any mail.
//     The daily-mail problem it looked like it caused was really the ungrouped
//     per-relation send, fixed in checkMentorInteractionReminders instead.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASELINE_KEY = 'cronBaselineAt';

async function main() {
  const existing = await prisma.setting.findUnique({ where: { key: BASELINE_KEY } });
  if (existing) {
    console.log(`backfill-cron-baseline: already applied at ${existing.value} — skipping.`);
    return;
  }

  const now = new Date();
  // Match sendUnreadMessageDigests' own cutoff (UNREAD_DIGEST_AFTER_MIN = 60):
  // anything newer than that is not yet digest-eligible, so leave it for the
  // first real tick to pick up normally.
  const digestCutoff = new Date(now.getTime() - 60 * 60 * 1000);

  const digested = await prisma.message.updateMany({
    where: { readAt: null, digestedAt: null, deletedForEveryoneAt: null, createdAt: { lt: digestCutoff } },
    data: { digestedAt: now },
  });

  // Already-overdue stage deadlines (0 rows when this first ran, but a deploy
  // could land after some went overdue).
  const deadlines = await prisma.mentorshipRelation.updateMany({
    where: { stageDeadline: { lt: now }, deadlineReminderSentAt: null },
    data: { deadlineReminderSentAt: now },
  });

  await prisma.setting.create({ data: { key: BASELINE_KEY, value: now.toISOString() } });

  console.log(
    `backfill-cron-baseline: baselined ${digested.count} undigested message(s) and ` +
      `${deadlines.count} overdue deadline(s) at ${now.toISOString()}.`,
  );
}

main()
  .catch((e) => {
    console.error('backfill-cron-baseline failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
