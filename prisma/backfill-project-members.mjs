// Idempotent backfill for #617: every project with a person owner
// (ownerUserId) gets a ProjectMember(role=OWNER) row, so no project is left
// ownerless when consumers switch to the members table. Safe to run on every
// deploy (skipDuplicates) — mirrors the seed-templates.mjs pattern.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const projects = await prisma.project.findMany({
    where: { ownerUserId: { not: null } },
    select: { id: true, ownerUserId: true },
  });
  if (projects.length === 0) {
    console.log('backfill-project-members: no person-owned projects.');
    return;
  }
  const { count } = await prisma.projectMember.createMany({
    data: projects.map((p) => ({ projectId: p.id, userId: p.ownerUserId, role: 'OWNER' })),
    skipDuplicates: true,
  });
  console.log(`backfill-project-members: ${count} OWNER row(s) created (${projects.length} person-owned projects).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
