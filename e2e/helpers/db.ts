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

/**
 * A mentee who is actually IN a mentorship (#2043).
 *
 * A bare `seedUser(…, 'MENTEE', …)` renders every relation-bearing screen in its
 * empty state: the mentor and admin boards have no cards, the inbox has no
 * threads, the portal has no journey. Scanning that measures the empty state and
 * calls it coverage — `docs/agent-experience.md` records the gap in numbers (a
 * related mentee surfaced 9 serious colour-contrast findings on `/portal#dark`
 * that the thin fixture could not see).
 *
 * So this seeds the whole shape a real pair has: mentor + mentee + company, an
 * ACTIVE relation parked mid-pipeline, one goal, one past interaction and one
 * upcoming meeting. It is deliberately the ONLY relation-seeding fixture helper
 * — #1412 (the mentee-portal half of the same widening) consumes this one rather
 * than adding a second, so the two halves keep scanning the same shape.
 */
export type SeededRelation = {
  mentorEmail: string;
  menteeEmail: string;
  mentorId: string;
  menteeId: string;
  relationId: string;
  companyId: string;
  menteeName: string;
  /** Both seeded accounts, for the caller's `cleanupByEmail` loop. */
  emails: string[];
};

export async function seedMenteeWithRelation(prefix: string, password: string): Promise<SeededRelation> {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const menteeName = `${prefix} Mentee`;
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', `${prefix} Mentor`);
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', menteeName);
  const company = await prisma.company.create({
    data: { name: `${prefix} Co ${Date.now()}`, industry: 'Software' },
  });
  const day = 24 * 60 * 60 * 1000;
  const relation = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      companyId: company.id,
      status: 'ACTIVE',
      // Mid-pipeline on purpose: a relation parked in the FIRST stage is what
      // the dormant-first-contact sweep targets, and a terminal one is done —
      // neither renders the ordinary in-progress card the boards are about.
      pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450',
      startDate: new Date(Date.now() - 30 * day),
    },
  });
  await prisma.goal.create({
    data: {
      relationId: relation.id,
      title: `${prefix} goal`,
      description: 'Seeded goal so goal-bearing screens render a row.',
      dueDate: new Date(Date.now() + 14 * day),
    },
  });
  await prisma.interactionLog.create({
    data: {
      relationId: relation.id,
      date: new Date(Date.now() - 7 * day),
      subject: `${prefix} check-in`,
      notes: 'Seeded interaction so the history is not empty.',
      type: 'Meeting',
    },
  });
  await prisma.meeting.create({
    data: {
      relationId: relation.id,
      title: `${prefix} upcoming meeting`,
      scheduledAt: new Date(Date.now() + 2 * day),
      createdById: mentor.id,
      rsvpToken: crypto.randomBytes(16).toString('hex'),
    },
  });
  return {
    mentorEmail,
    menteeEmail,
    mentorId: mentor.id,
    menteeId: mentee.id,
    relationId: relation.id,
    companyId: company.id,
    menteeName,
    emails: [mentorEmail, menteeEmail],
  };
}

/** Teardown for {@link seedMenteeWithRelation}. */
export async function cleanupMenteeWithRelation(seeded: SeededRelation) {
  // Visiting /messages lazily creates the pair's conversation, so those rows
  // exist even though nothing here asked for them. The participant rows cascade
  // from the user delete below; the conversation itself would be left orphaned.
  const conversationIds = (
    await prisma.conversationParticipant.findMany({
      where: { userId: { in: [seeded.mentorId, seeded.menteeId] } },
      select: { conversationId: true },
    })
  ).map((p) => p.conversationId);
  if (conversationIds.length > 0) {
    await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  }
  // Goal, interaction and meeting all cascade from the relation, which
  // cleanupByEmail deletes along with the users.
  for (const email of seeded.emails) await cleanupByEmail(email);
  await prisma.company.delete({ where: { id: seeded.companyId } }).catch(() => {});
}
