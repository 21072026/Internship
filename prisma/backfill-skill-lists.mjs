// Split the skill lists that were stored as one blob, before anything split
// them (#2314).
//
// WHAT WENT IN
//   Every form wrote `skills.split(',')` from a single-line <input>. A browser
//   drops the line breaks out of a multi-line paste, so a mentee who pasted
//   their CV's skill list stored ONE entry:
//     "Java C# / .NET Backend Development REST API / API Development SQL /
//      PostgreSQL Spring Boot FastAPI Python Generative AI / AI Tools …"
//   — 300+ characters in a badge, which filled half the admin dashboard card it
//   was rendered in.
//
// WHAT THIS DOES
//   Re-splits `User.skills` and `MentorApplication.expertise` through the same
//   rule the app now uses (`prisma/skill-split.mjs`, mirrored from
//   `src/lib/skills.ts` and pinned to it by scripts/test/skills.test.mjs) and
//   writes the result back where it differs.
//
//   The separators that survived the flattening are the ones this can act on:
//   commas, semicolons, bullets, tabs, and any line breaks that did survive
//   (an API or CSV write). A blob whose separators are GONE cannot be recovered
//   here — there is no way to tell "Data Analysis" from two skills — so those
//   are TRUNCATED to the 60-character cap and reported, and the person can
//   retype the rest in a field that now keeps a pasted list intact.
//
// Idempotent: the rule is a fixed point, so a second run finds nothing to do.
// Dry-run by default; `--apply` writes. `--verbose` prints every change.
import { PrismaClient } from '@prisma/client';
import { capSkills } from './skill-split.mjs';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const PAGE = 500;

const asList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** One model's JSON skill column, paged so a large tenant cannot blow up memory. */
async function sweep({ label, findMany, update, column }) {
  let cursor = null;
  let scanned = 0;
  let changed = 0;
  let truncated = 0;

  for (;;) {
    const rows = await findMany(cursor, PAGE);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      scanned++;
      const before = asList(row[column]);
      if (before.length === 0) continue;
      const after = capSkills(before);
      if (same(before, after)) continue;

      // A single entry that only got shorter is the unrecoverable case: its
      // separators were already gone when it was stored. Worth naming in the
      // log, because somebody may want to ask that person to re-enter them.
      const lostText = before.some((skill) => !after.includes(skill) && !after.some((kept) => skill.startsWith(kept)));
      if (before.length >= after.length && lostText) truncated++;

      if (VERBOSE || !APPLY) {
        console.log(`  ${label} ${row.id}: ${before.length} → ${after.length} skill(s)`);
        if (VERBOSE) {
          console.log(`    before: ${JSON.stringify(before)}`);
          console.log(`    after:  ${JSON.stringify(after)}`);
        }
      }
      if (APPLY) await update(row.id, after);
      changed++;
    }

    if (rows.length < PAGE) break;
  }

  return { label, scanned, changed, truncated };
}

async function main() {
  const results = [];

  results.push(
    await sweep({
      label: 'User',
      column: 'skills',
      findMany: (cursor, take) =>
        prisma.user.findMany({
          where: cursor ? { id: { gt: cursor } } : {},
          orderBy: { id: 'asc' },
          take,
          select: { id: true, skills: true },
        }),
      update: (id, skills) => prisma.user.update({ where: { id }, data: { skills } }),
    }),
  );

  results.push(
    await sweep({
      label: 'MentorApplication',
      column: 'expertise',
      findMany: (cursor, take) =>
        prisma.mentorApplication.findMany({
          where: cursor ? { id: { gt: cursor } } : {},
          orderBy: { id: 'asc' },
          take,
          select: { id: true, expertise: true },
        }),
      update: (id, expertise) => prisma.mentorApplication.update({ where: { id }, data: { expertise } }),
    }),
  );

  const total = results.reduce((n, r) => n + r.changed, 0);
  for (const r of results) {
    console.log(
      `backfill-skill-lists: ${r.label} — scanned ${r.scanned}, ${APPLY ? 'rewrote' : 'would rewrite'} ${r.changed}` +
        (r.truncated > 0 ? `, ${r.truncated} had an unrecoverable blob truncated to the cap` : ''),
    );
  }
  if (total === 0) console.log('backfill-skill-lists: nothing to do.');
  else if (!APPLY) console.log('backfill-skill-lists: dry run — re-run with --apply to write.');
}

main()
  .catch((e) => {
    console.error('backfill-skill-lists failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
