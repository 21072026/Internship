import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

// Companion to prisma/push-setting-id-expand.mjs: fills the surrogate `id`
// added there for every pre-existing row, so the final contract push
// (`id` required + primary key) has no NULLs left to reject. Raw SQL only —
// the generated client already models the FINAL schema (`id` required,
// `key` not `@id`), so its typed `setting.*` methods don't match the
// in-between shape this script runs against.
const prisma = new PrismaClient();

try {
  const rows = await prisma.$queryRaw`SELECT \`key\` FROM \`Setting\` WHERE \`id\` IS NULL`;

  for (const row of rows) {
    await prisma.$executeRaw`
      UPDATE \`Setting\` SET \`id\` = ${crypto.randomUUID()}
      WHERE \`key\` = ${row.key} AND \`id\` IS NULL
    `;
  }

  console.log(`Setting id backfill complete (${rows.length} row(s))`);
} finally {
  await prisma.$disconnect();
}
