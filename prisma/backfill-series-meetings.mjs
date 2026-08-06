// Delete the `Meeting` rows the old recurring-meeting generator materialised (#1110).
//
// Why this is needed: a MeetingSeries used to be expanded into one Meeting row
// per mentee per occurrence, weeks ahead. Cancelling the series only flipped
// `active` to false, so those rows outlived it and sat on everyone's calendar
// forever; moving the meeting to another day left the old slots behind next to
// the new ones. A series is now a rule that is expanded on read, and nothing
// writes these rows any more — but every existing deployment is carrying years
// of them, and the calendar's `seriesId: null` filter only hides them. This
// removes them.
//
// Notes taken in one of those meetings survive: `PersonalNote.meetingId` is
// `SetNull`, so the note keeps its text and simply loses the meeting pointer.
//
// Idempotent by construction — it deletes rows that can no longer be created,
// so a second run finds nothing. Safe to leave wired into the deploy scripts.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const { count } = await prisma.meeting.deleteMany({ where: { seriesId: { not: null } } });
  console.log(
    count === 0
      ? 'backfill-series-meetings: nothing to do.'
      : `backfill-series-meetings: removed ${count} generated series occurrence(s).`,
  );
}

main()
  .catch((e) => {
    console.error('backfill-series-meetings failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
