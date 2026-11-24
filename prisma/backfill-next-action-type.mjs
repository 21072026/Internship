// Fill MentorshipRelation.nextActionType for follow-ups written before the
// column existed (#3900).
//
// A hand-off stored its quick pick only inside the note ("Telefonla aranacak:
// …"); the column now carries it. For every record with a note and no type,
// this reads the pick from the note's label (prisma/next-action-type.mjs, the
// mirror of the app's rule) and writes it. A note that names no pick stays
// null — a free-text step says nothing about what it is.
//
// Idempotent: a filled row no longer matches, and the write is guarded on the
// note it was read from and on a still-empty type, so a follow-up edited in
// between is left to the app. Dry-run by default; `--apply` writes.
import { PrismaClient } from '@prisma/client';
import { actionFromNote } from './next-action-type.mjs';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const BATCH = 500;

async function main() {
  let filled = 0;
  let untyped = 0;
  let cursor;
  for (;;) {
    const rows = await prisma.mentorshipRelation.findMany({
      where: { nextActionNote: { not: null }, nextActionType: null },
      select: { id: true, nextActionNote: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const action = actionFromNote(row.nextActionNote);
      if (!action) {
        untyped++;
        continue;
      }
      if (APPLY) {
        const { count } = await prisma.mentorshipRelation.updateMany({
          where: { id: row.id, nextActionNote: row.nextActionNote, nextActionType: null },
          data: { nextActionType: action },
        });
        filled += count;
      } else {
        filled++;
      }
    }
    if (rows.length < BATCH) break;
  }
  console.log(`backfill-next-action-type: ${APPLY ? 'filled' : 'would fill'}=${filled} free_text=${untyped}`);
}

main()
  .catch((error) => {
    console.error('backfill-next-action-type failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
