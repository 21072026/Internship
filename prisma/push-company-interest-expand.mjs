import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';

// MySQL currently uses the legacy CompanyInterest(companyId, menteeId) unique
// index to support the companyId foreign key. Prisma's final diff can order the
// DROP before replacement indexes are created, which MySQL correctly rejects.
// First converge to an expand schema that contains both the old unique index
// and the final FK-supporting indexes; the normal db push can then contract it.
const sourcePath = 'prisma/schema.prisma';
const marker = '  @@index([companyId, menteeId])\n  @@index([menteeId])\n  @@index([requisitionId])\n';
const tempDirectory = await mkdtemp(join(tmpdir(), 'company-interest-expand-'));
const expandPath = join(tempDirectory, 'schema.prisma');

try {
  const schema = await readFile(sourcePath, 'utf8');
  if (!schema.includes(marker)) {
    throw new Error('CompanyInterest index marker not found; expand push not attempted');
  }

  // The unique directory is mode 0700 on supported platforms; explicitly keep
  // the generated schema owner-readable/writable only as an additional guard.
  await writeFile(expandPath, schema.replace(marker, `  @@unique([companyId, menteeId])\n${marker}`), {
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
    // Do not re-add the legacy unique index on later deploys: once the contract
    // phase has completed, valid requisition-specific rows may share a company and
    // mentee. This read-only metadata check makes the expand phase one-shot.
    const prisma = new PrismaClient();
    try {
      const legacyIndex = await prisma.$queryRaw`
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'CompanyInterest'
          AND index_name = 'CompanyInterest_companyId_menteeId_key'
        LIMIT 1
      `;
      const companyInterestTable = await prisma.$queryRaw`
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = 'CompanyInterest'
        LIMIT 1
      `;

      if (companyInterestTable.length > 0 && legacyIndex.length === 0) {
        console.log('Legacy CompanyInterest unique index is absent; expand phase already complete');
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
