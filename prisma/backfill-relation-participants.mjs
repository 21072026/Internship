// The scalar pair's two seats for every relation (#1804).
//
// `RelationParticipant` arrived after thousands of relations. Every relation
// gets a MENTOR seat for `mentorId` and a MENTEE seat for `menteeId`, both
// `isPrimaryPair` — mirror rows that grant nothing (the scalars stay the
// truth for the pair; src/lib/relationParticipants.ts). New relations get
// theirs from the shared create path; this fills the rest.
//
// INSERT-ONLY and idempotent: `createMany({ skipDuplicates })` on the unique
// (relationId, userId), so a seat that exists — a mirror, or a GROUP seat the
// admin added — is never touched, and a second run writes nothing. Never
// deletes, never updates, never reads or changes `mentorId`/`menteeId`.
// Dry-run by default; `--apply` writes.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const PAGE = 1000;

async function main() {
  const totals = { relations: 0, missing: 0, written: 0 };
  let cursor = null;
  for (;;) {
    const relations = await prisma.mentorshipRelation.findMany({
      select: { id: true, mentorId: true, menteeId: true, participants: { select: { userId: true } } },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (relations.length === 0) break;
    cursor = relations[relations.length - 1].id;
    totals.relations += relations.length;
    const rows = [];
    for (const r of relations) {
      const seated = new Set(r.participants.map((p) => p.userId));
      if (!seated.has(r.mentorId)) rows.push({ relationId: r.id, userId: r.mentorId, role: 'MENTOR', isPrimaryPair: true });
      if (!seated.has(r.menteeId) && r.menteeId !== r.mentorId) rows.push({ relationId: r.id, userId: r.menteeId, role: 'MENTEE', isPrimaryPair: true });
    }
    totals.missing += rows.length;
    if (APPLY && rows.length) totals.written += (await prisma.relationParticipant.createMany({ data: rows, skipDuplicates: true })).count;
  }
  console.log(`backfill-relation-participants ${APPLY ? 'applied' : 'dry run'}:`, JSON.stringify(totals));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
