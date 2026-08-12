import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// MySQL currently uses the legacy CompanyInterest(companyId, menteeId) unique
// index to support the companyId foreign key. Prisma's final diff can order the
// DROP before replacement indexes are created, which MySQL correctly rejects.
// First converge to an expand schema that contains both the old unique index
// and the final FK-supporting indexes; the normal db push can then contract it.
const sourcePath = 'prisma/schema.prisma';
const expandPath = '/tmp/company-interest-expand.prisma';
const schema = readFileSync(sourcePath, 'utf8');
const marker = '  @@index([companyId, menteeId])\n  @@index([menteeId])\n  @@index([requisitionId])\n';

if (!schema.includes(marker)) {
  throw new Error('CompanyInterest index marker not found; expand push not attempted');
}

writeFileSync(expandPath, schema.replace(marker, `  @@unique([companyId, menteeId])\n${marker}`));

if (process.argv.includes('--prepare-only')) {
  console.log(expandPath);
  process.exit(0);
}

// Do not re-add the legacy unique index on later deploys: once the contract
// phase has completed, valid requisition-specific rows may share a company and
// mentee. This read-only metadata check makes the expand phase one-shot.
const prisma = new PrismaClient();
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
await prisma.$disconnect();

if (companyInterestTable.length > 0 && legacyIndex.length === 0) {
  console.log('Legacy CompanyInterest unique index is absent; expand phase already complete');
  process.exit(0);
}

const result = spawnSync(
  'npx',
  ['prisma', 'db', 'push', '--schema', expandPath, '--accept-data-loss', '--skip-generate'],
  { stdio: 'inherit', env: process.env },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
