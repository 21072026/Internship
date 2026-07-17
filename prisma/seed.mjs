import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Partner companies / projects from the original spreadsheet.
const SEED_COMPANIES = ['BCS-IT', 'OKAY', 'NFC', 'Abics'];

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const fullName = process.env.SEED_ADMIN_NAME || 'Admin';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`User already exists: ${email} — skipping admin seed.`);
  } else {
    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.create({
      data: { email, password: hashedPassword, fullName, role: 'ADMIN', skills: [] },
    });
    console.log(`Created ADMIN user: ${email}`);
  }

  // Backfill ProjectMember OWNER rows (#617, idempotent) so no person-owned
  // project is ever without an OWNER member.
  const owned = await prisma.project.findMany({
    where: { ownerUserId: { not: null } },
    select: { id: true, ownerUserId: true },
  });
  if (owned.length > 0) {
    await prisma.projectMember.createMany({
      data: owned.map((p) => ({ projectId: p.id, userId: p.ownerUserId, role: 'OWNER' })),
      skipDuplicates: true,
    });
  }

  // Backfill default Organization + orgId (#543, idempotent).
  const defaultOrg = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  for (const m of ['user', 'source', 'cohort', 'company', 'project', 'mentorshipRelation']) {
    await prisma[m].updateMany({ where: { orgId: null }, data: { orgId: defaultOrg.id } });
  }

  // Idempotent company seed (Company.name is not unique, so check first).
  for (const name of SEED_COMPANIES) {
    const found = await prisma.company.findFirst({ where: { name } });
    if (!found) {
      await prisma.company.create({ data: { name } });
      console.log(`Created company: ${name}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
