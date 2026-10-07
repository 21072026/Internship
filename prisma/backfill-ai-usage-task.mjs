// Stamp AiUsage.taskId on the rows written before the column existed (#2022).
// Node 20 ESM, no TS imports — the server runs it inside the image.
//
// The AI task registry (src/lib/ai/tasks.ts) keys every task on the historic
// `scope` string, and src/lib/aiGate.ts now writes both `scope` and `taskId`
// on every new row. A legacy row's task is therefore exactly its scope; this
// copies it over so a report can group on `taskId` alone.
//
// Idempotent: touches `taskId IS NULL` rows only. Raw SQL, like the other
// AiUsage backfill.
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const BACKFILL_SQL = 'UPDATE `AiUsage` SET `taskId` = `scope` WHERE `taskId` IS NULL';

async function main() {
  const prisma = new PrismaClient();
  try {
    const n = await prisma.$executeRawUnsafe(BACKFILL_SQL);
    console.log(`backfill-ai-usage-task: ${n} row(s) stamped`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('backfill-ai-usage-task failed:', e);
    process.exit(1);
  });
}
