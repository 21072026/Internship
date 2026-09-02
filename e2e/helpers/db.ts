import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

/**
 * Direct DB access for E2E setup/teardown. Lets tests seed invitation tokens and
 * users without going through the email-sending invite flow, so the suite is
 * self-contained and never sends real mail (works in CI and against any env).
 */
export const prisma = new PrismaClient();

export function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@e2e.local`;
}

export async function seedInvite(email: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE') {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.invitationToken.create({ data: { token, email, role, expiresAt } });
  return token;
}

export async function seedUser(
  email: string,
  password: string,
  role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY' | 'SOURCE',
  fullName: string
) {
  const hash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: {
      email,
      password: hash,
      role,
      fullName,
      skills: [],
      // Every other spec seeding a MENTOR expects to land straight on the
      // dashboard, not the first-run onboarding wizard (#911) — only specs
      // testing that wizard itself want a "fresh" mentor, and they clear
      // this field back to null after seeding.
      ...(role === 'MENTOR' ? { mentorOnboardingSeenAt: new Date() } : {}),
    },
  });
}

export async function cleanupByEmail(email: string) {
  // Remove dependent mentorship relations first, then the user + any tokens.
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.mentorshipRelation.deleteMany({
      where: { OR: [{ mentorId: user.id }, { menteeId: user.id }] },
    });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
  await prisma.invitationToken.deleteMany({ where: { email: { equals: email } } });
}

/**
 * Record a contributor-terms acceptance for a seeded user (#1025, #1026).
 *
 * Two surfaces are gated on it: `/portal/projects` on the platform-level
 * acceptance (`projectId` omitted), and a project's internal view on an
 * acceptance scoped to that project (`projectId` given). A real member who is
 * working on a project has both; a freshly seeded one has neither. No-op when
 * the installation has no terms configured, which is also when the gates let
 * everyone through.
 */
export async function acceptContributorTerms(
  userId: string,
  opts: { termsKey?: string; projectId?: string } = {}
) {
  const termsKey = opts.termsKey ?? 'default';
  const terms = await prisma.contributorTerms.findFirst({
    where: { key: termsKey },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    select: { version: true },
  });
  if (!terms) return null;
  return prisma.contributorTermsAcceptance.create({
    data: { userId, termsKey, version: terms.version, projectId: opts.projectId ?? null },
  });
}

/**
 * A tenant whose pipeline is NOT the default catalogue (#1886).
 *
 * Every other spec runs against `resolvePipelineStages()`'s fallback, so a
 * consumer that hardcodes `'HIRED_660'` passes the whole suite and only
 * misbehaves for a customer who renamed their stages. This seeds exactly that
 * customer: six `PipelineStage` rows keyed `STAGE_A`…`STAGE_F`, an admin, and a
 * relation that has actually travelled from the first stage to the last one, so
 * the funnel has a journey to report on.
 */
export async function seedCustomPipelineOrg(prefix: string, password: string) {
  const org = await prisma.organization.create({
    data: { slug: `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, name: `${prefix} Org` },
  });
  const keys = ['STAGE_A', 'STAGE_B', 'STAGE_C', 'STAGE_D', 'STAGE_E', 'STAGE_F'];
  await prisma.pipelineStage.createMany({
    data: keys.map((key, i) => ({
      orgId: org.id,
      key,
      label: `Custom ${key.slice(-1)}`,
      order: i,
      // Only the last stage ends the journey; nothing here is off-path, so the
      // whole set is the on-path order the funnel reports.
      isTerminal: i === keys.length - 1,
      isOffPath: false,
    })),
  });

  const adminEmail = uniqueEmail(`${prefix}-admin`);
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const admin = await seedUser(adminEmail, password, 'ADMIN', `${prefix} Admin`);
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', `${prefix} Mentor`);
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', `${prefix} Mentee`);
  await prisma.user.updateMany({
    where: { id: { in: [admin.id, mentor.id, mentee.id] } },
    data: { orgId: org.id },
  });

  const relation = await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id,
      mentorId: mentor.id,
      menteeId: mentee.id,
      pipelineStatus: 'STAGE_F',
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.statusChange.create({
    data: {
      relationId: relation.id,
      fromStatus: 'STAGE_A',
      toStatus: 'STAGE_F',
      changedById: admin.id,
    },
  });

  return {
    org,
    relationId: relation.id,
    adminEmail,
    emails: [adminEmail, mentorEmail, menteeEmail],
    stageKeys: keys,
  };
}

/** Teardown for {@link seedCustomPipelineOrg}. */
export async function cleanupCustomPipelineOrg(orgId: string, emails: string[]) {
  // Explicit, in dependency order: PipelineStage cascades from Organization,
  // but a partial failure should still leave nothing behind.
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
  await prisma.pipelineStage.deleteMany({ where: { orgId } });
  for (const email of emails) await cleanupByEmail(email);
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}
