// Move pre-#1806 "review notes" out of MentorApplication.rejectReason and into
// the column they should always have had, MentorApplication.adminNote.
//
// The bug: the admin review UI's "save note" action wrote the note to
// `rejectReason` — the same column the reject action uses for the reason a
// decision was made. So a note saved on an application overwrote the rejection
// reason, and a rejection reason was displayed back as if it were the note.
//
// What this fixes, and what it deliberately does NOT:
//
//   NON-REJECTED rows (PENDING / UNDER_REVIEW / APPROVED) — copied.
//     Only the reject action ever sets a real rejection reason, and it sets
//     status = REJECTED in the same write. So a value sitting on a row that is
//     not REJECTED can only have come from the note action: it IS a note, and
//     copying it into adminNote loses nothing.
//
//   REJECTED rows — left completely alone.
//     There the value is ambiguous: it is either the genuine rejection reason,
//     or a note that was saved afterwards and already destroyed that reason.
//     Nothing in the row distinguishes the two cases, so any guess would be
//     wrong half the time — and a wrong guess here either fabricates a
//     "rejection reason" out of a note, or re-labels a real decision as
//     private commentary. Leaving the value where it is keeps the surviving
//     text visible under the label it was last written with, and the fix
//     stops the destruction from continuing. Recovering the overwritten
//     reasons is not possible: the old code did a plain UPDATE.
//
// `rejectReason` is not cleared on the rows it copies: the value stays where it
// is, and the review UI simply stops showing it for a non-REJECTED status
// (src/app/admin/mentor-applications/[id]/page.tsx). A copy is reversible; a
// delete based on an inference is not.
//
// Idempotent: it only ever fills adminNote where it is still NULL, so a second
// run touches nothing. Safe to leave wired into deploy-prod.sh forever.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.mentorApplication.findMany({
    where: {
      status: { not: 'REJECTED' },
      adminNote: null,
      rejectReason: { not: null },
    },
    select: { id: true, rejectReason: true },
  });

  let moved = 0;
  for (const row of candidates) {
    // The old note action stored an emptied note as '' rather than NULL —
    // that is "no note", not a note, so it gets no adminNote row.
    const text = (row.rejectReason ?? '').trim();
    if (!text) continue;
    await prisma.mentorApplication.update({
      where: { id: row.id },
      data: { adminNote: text },
    });
    moved++;
  }

  console.log(
    moved === 0
      ? 'backfill-mentor-application-admin-note: nothing to do.'
      : `backfill-mentor-application-admin-note: copied ${moved} misfiled note(s) into adminNote (REJECTED rows untouched).`,
  );
}

main()
  .catch((e) => {
    console.error('backfill-mentor-application-admin-note failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
