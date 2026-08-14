#!/usr/bin/env node
// Find (and optionally repair) rows whose `Json` column holds something that is
// not valid JSON.
//
// Why this exists: Prisma JSON.parse()s a `Json` column when it reads the row,
// so ONE invalid value makes every read of that row throw
// "Unexpected end of JSON input". On MySQL 8 a native JSON column rejects such a
// value at write time, but MariaDB stores JSON as LONGTEXT and only enforces a
// `json_valid()` CHECK when the column was created with one — so a column that
// predates the check, or was written by raw SQL, can hold '' (or any garbage)
// and quietly poison the row. That is what took production sign-in down in
// #1150: the admin's `User` row could not be read at all, so no password would
// ever get them in.
//
//   node prisma/backfill-json-columns.mjs            # report only (safe, read-only)
//   node prisma/backfill-json-columns.mjs --repair   # reset bad values to the column default
//
// Reads DATABASE_URL from the environment. Reports ids and value lengths only —
// never the value itself, which may contain personal data.

import { PrismaClient } from '@prisma/client';

// Every `Json` column in prisma/schema.prisma, with the default to repair to.
// `null` means the column is nullable and NULL is its "unset" state.
const COLUMNS = [
  { table: 'User', column: 'skills', fallback: '[]' },
  { table: 'User', column: 'languages', fallback: '[]' },
  { table: 'User', column: 'skillLevels', fallback: '{}' },
  { table: 'User', column: 'notificationPrefs', fallback: null },
  { table: 'MentorApplication', column: 'expertise', fallback: '[]' },
  { table: 'Webhook', column: 'events', fallback: '[]' },
  { table: 'Project', column: 'technologies', fallback: '[]' },
  { table: 'ProjectTaskTemplate', column: 'translations', fallback: null },
  { table: 'MenteeOnboarding', column: 'steps', fallback: '{}' },
  { table: 'Evaluation', column: 'scores', fallback: '{}' },
  { table: 'MeetingSeries', column: 'daysOfWeek', fallback: '[]' },
];

const repair = process.argv.includes('--repair');
const prisma = new PrismaClient();

let bad = 0;
let repaired = 0;
let skipped = 0;

try {
  for (const { table, column, fallback } of COLUMNS) {
    // JSON_VALID() exists on MySQL 5.7+ and MariaDB 10.4+. On a native JSON
    // column it is always 1, so this simply finds nothing — which is correct.
    let rows;
    try {
      rows = await prisma.$queryRawUnsafe(
        `SELECT \`id\` AS id, CHAR_LENGTH(\`${column}\`) AS len
           FROM \`${table}\`
          WHERE \`${column}\` IS NOT NULL AND JSON_VALID(\`${column}\`) = 0`
      );
    } catch (error) {
      // A table/column that does not exist yet (schema older than this script)
      // is not a failure — say so and move on.
      skipped++;
      console.warn(`? ${table}.${column} — could not be checked: ${String(error).split('\n')[0]}`);
      continue;
    }

    if (rows.length === 0) {
      console.log(`✓ ${table}.${column}`);
      continue;
    }

    bad += rows.length;
    console.error(`✗ ${table}.${column} — ${rows.length} invalid row(s):`);
    for (const row of rows) console.error(`    id=${row.id} (${Number(row.len)} chars)`);

    if (repair) {
      const affected =
        fallback === null
          ? await prisma.$executeRawUnsafe(
              `UPDATE \`${table}\` SET \`${column}\` = NULL
                WHERE \`${column}\` IS NOT NULL AND JSON_VALID(\`${column}\`) = 0`
            )
          : await prisma.$executeRawUnsafe(
              `UPDATE \`${table}\` SET \`${column}\` = ?
                WHERE \`${column}\` IS NOT NULL AND JSON_VALID(\`${column}\`) = 0`,
              fallback
            );
      repaired += affected;
      console.error(`  → repaired ${affected} row(s) to ${fallback === null ? 'NULL' : fallback}`);
    }
  }
} finally {
  await prisma.$disconnect();
}

console.log(
  `\n${bad === 0 ? 'All Json columns are valid.' : `${bad} invalid value(s) found`}` +
    `${repair && repaired > 0 ? `, ${repaired} repaired.` : bad > 0 ? ' — re-run with --repair to reset them to the column default.' : ''}` +
    `${skipped > 0 ? ` (${skipped} column(s) skipped.)` : ''}`
);

// Non-zero on unrepaired damage so this can gate a deploy or run from cron.
process.exit(bad > 0 && !repair ? 1 : 0);
