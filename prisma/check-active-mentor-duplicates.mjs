// READ-ONLY detector: mentees holding more than one ACTIVE mentorship (#419).
//
// "One mentee, at most one ACTIVE mentor" was always the intended invariant but
// was enforced at two of eight write paths. The application-level guards are in
// place now (src/lib/activeMentorship.ts); this reports whether the data that
// existed BEFORE them already violates it.
//
// Why it matters operationally: the real backstop is a DB-level unique index
// (MySQL has no partial unique index, so the technique is a nullable
// `activeMenteeKey` = menteeId while ACTIVE, NULL otherwise, with @@unique —
// MySQL permits many NULLs). Adding it while a violating row exists makes
// `prisma db push --accept-data-loss` FAIL, and that push is how this app
// deploys. So the constraint waits until this reports clean on prod AND on the
// shared preview. See docs/one-active-mentor.md.
//
// It NEVER writes, and it ALWAYS exits 0 — a detector that can red a deploy is
// a detector that gets removed the first time it fires. `extraRelations` is
// exactly the number of rows the future unique index would reject.
//
// The same report is available in the app as GET /api/admin/relation-integrity,
// which shares the filter with the guards via src/lib/activeMentorship.ts. This
// file duplicates the query because scripts run as plain .mjs and cannot import
// a @/lib TS module.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TAG = 'check-active-mentors';

async function main() {
  const totalActive = await prisma.mentorshipRelation.count({ where: { status: 'ACTIVE' } });
  const grouped = await prisma.mentorshipRelation.groupBy({
    by: ['menteeId'],
    where: { status: 'ACTIVE' },
    _count: { _all: true },
    having: { menteeId: { _count: { gt: 1 } } },
  });

  if (grouped.length === 0) {
    console.log(`${TAG}: OK — no mentee has more than one ACTIVE mentorship (${totalActive} active relations checked).`);
    return;
  }

  const extra = grouped.reduce((sum, g) => sum + (g._count._all - 1), 0);
  console.log(
    `${TAG}: VIOLATION — ${grouped.length} mentee(s) with more than one ACTIVE mentorship; ` +
      `${extra} relation row(s) more than the invariant allows (of ${totalActive} active).`
  );
  console.log(`${TAG}: the @@unique([activeMenteeKey]) backstop CANNOT be added until this is 0.`);

  const rows = await prisma.mentorshipRelation.findMany({
    where: { menteeId: { in: grouped.map((g) => g.menteeId) }, status: 'ACTIVE' },
    orderBy: [{ menteeId: 'asc' }, { startDate: 'asc' }],
    select: {
      id: true,
      menteeId: true,
      orgId: true,
      startDate: true,
      pipelineStatus: true,
      // These two say whether the mentee has already been over-mailed: the
      // dormant-first-contact nudge cap lives on the RELATION, so two ACTIVE
      // relations spend two independent two-nudge budgets (#1499).
      dormantSince: true,
      dormantNudgeCount: true,
      mentee: { select: { email: true, fullName: true } },
      mentor: { select: { id: true, fullName: true } },
    },
  });

  let current = null;
  for (const r of rows) {
    if (r.menteeId !== current) {
      current = r.menteeId;
      console.log(`\n  mentee ${r.menteeId} — ${r.mentee.fullName} <${r.mentee.email}> (org ${r.orgId ?? 'NULL'})`);
    }
    console.log(
      `    relation ${r.id}  mentor ${r.mentor.id} (${r.mentor.fullName})  ` +
        `start ${r.startDate.toISOString().slice(0, 10)}  stage ${r.pipelineStatus}  ` +
        `dormantSince ${r.dormantSince ? r.dormantSince.toISOString().slice(0, 10) : '-'}  ` +
        `nudges ${r.dormantNudgeCount}`
    );
  }
  console.log(
    `\n${TAG}: resolve each by closing the mentorship that should no longer be active ` +
      `("Mark complete" on /admin/mentorship) — nothing is changed automatically.`
  );
}

main()
  .catch((e) => {
    // Even a failure exits 0: this is a report wired into the deploy, not a gate.
    console.error(`${TAG}: check failed (reporting only, deploy unaffected):`, e?.message ?? e);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
