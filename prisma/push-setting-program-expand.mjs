import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';

// #1619 widens Setting's natural key from (orgId, key) to (orgId, programId,
// key). MySQL uses the old unique index `Setting_orgId_key_key` to support the
// `orgId` foreign key, and Prisma's diff drops it BEFORE it creates the
// replacement indexes, so the plain push against a live table fails with
// "Cannot drop index 'Setting_orgId_key_key': needed in a foreign key
// constraint" — on prod and preview, never on a topic env's fresh database.
// The same failure, and the same fix, as push-company-interest-expand.mjs:
// first converge to an expand schema that keeps the old unique index AND adds
// the final ones (the new unique, @@index([orgId, key]), the programId column
// and its FK); the normal db push then only drops the old index, which by then
// is no longer the one the FK leans on.
//
// Nothing is lost on the way: the expand phase only adds, and every existing
// row has programId = NULL, so the old (orgId, key) uniqueness it keeps is
// already true of the data.
const sourcePath = 'prisma/schema.prisma';
const marker = '  @@unique([orgId, programId, key])\n  @@index([orgId, key])\n  @@index([programId])\n}\n';
const tempDirectory = await mkdtemp(join(tmpdir(), 'setting-program-expand-'));
const expandPath = join(tempDirectory, 'schema.prisma');

try {
  const schema = await readFile(sourcePath, 'utf8');
  if (schema.split(marker).length !== 2) {
    throw new Error('Setting programme-index marker not found exactly once; expand push not attempted');
  }

  // The unique directory is mode 0700 on supported platforms; explicitly keep
  // the generated schema owner-readable/writable only as an additional guard.
  await writeFile(expandPath, schema.replace(marker, `  @@unique([orgId, key])\n${marker}`), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });

  if (process.argv.includes('--validate-only')) {
    const validation = spawnSync('npx', ['prisma', 'validate', '--schema', expandPath], {
      stdio: 'inherit',
      env: process.env,
    });
    if (validation.error) throw validation.error;
    process.exitCode = validation.status ?? 1;
  } else {
    // One-shot: only while the legacy index exists. Once the contract push has
    // dropped it, re-adding it would forbid the programme rows it exists for.
    const prisma = new PrismaClient();
    try {
      const legacyIndex = await prisma.$queryRaw`
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'Setting'
          AND index_name = 'Setting_orgId_key_key'
        LIMIT 1
      `;

      if (legacyIndex.length === 0) {
        console.log('Legacy Setting (orgId, key) unique index is absent; expand phase not needed');
      } else {
        const result = spawnSync(
          'npx',
          ['prisma', 'db', 'push', '--schema', expandPath, '--accept-data-loss', '--skip-generate'],
          { stdio: 'inherit', env: process.env },
        );
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
      }
    } finally {
      await prisma.$disconnect();
    }
  }
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
