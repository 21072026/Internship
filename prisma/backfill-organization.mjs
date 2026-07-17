// Idempotent backfill for multi-tenancy Phase 1 (#543): ensure a single default
// Organization exists and every tenant-scoped row points at it. Additive and
// safe — nothing enforces isolation yet, so this only fills the new nullable
// orgId columns. Runs on deploy (deploy-prod.sh / deploy.yml) and in db seed.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_SLUG = process.env.DEFAULT_ORG_SLUG || 'default';
const DEFAULT_NAME = process.env.DEFAULT_ORG_NAME || 'Default Organization';

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: DEFAULT_SLUG },
    update: {},
    create: { slug: DEFAULT_SLUG, name: DEFAULT_NAME },
    select: { id: true },
  });

  const models = ['user', 'source', 'cohort', 'company', 'project', 'mentorshipRelation'];
  let total = 0;
  for (const m of models) {
    const res = await prisma[m].updateMany({ where: { orgId: null }, data: { orgId: org.id } });
    if (res.count) console.log(`backfill-organization: ${m} +${res.count}`);
    total += res.count;
  }
  console.log(`backfill-organization: default org ${DEFAULT_SLUG}; ${total} row(s) assigned.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
