import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { seedContributorTerms } from './seed-contributor-terms.mjs';

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
    // Idempotent backfill (#1535): the first admin is the instance operator and
    // must keep the super-admin capability that gates tenant management, even
    // on a database seeded before the flag existed.
    if (existing.role === 'ADMIN' && !existing.isSuperAdmin) {
      await prisma.user.update({ where: { id: existing.id }, data: { isSuperAdmin: true } });
      console.log(`Granted super admin to: ${email}`);
    }
  } else {
    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.create({
      // isSuperAdmin (#1535): the very first admin manages the instance itself —
      // creating tenants and configuring their SSO. Every later ADMIN is a
      // tenant admin and gets the flag only when an operator grants it.
      data: { email, password: hashedPassword, fullName, role: 'ADMIN', skills: [], isSuperAdmin: true },
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

  // Contributor terms v1.0 (#1025) — the acceptance gate has nothing to show
  // until these rows exist, so a fresh database gets them with the first seed.
  await seedContributorTerms(prisma);

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
