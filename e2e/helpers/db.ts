import { PrismaClient, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
// Pure catalogue module (no Prisma, no server imports) — safe to load from every spec.
import { DEFAULT_VERTICAL, VERTICAL_KEYS, toVerticalKey, type VerticalKey } from '@/lib/verticals';

/**
 * Direct DB access for E2E setup/teardown. Lets tests seed invitation tokens and
 * users without going through the email-sending invite flow, so the suite is
 * self-contained and never sends real mail (works in CI and against any env).
 */
export const prisma = new PrismaClient();

/**
 * A collision-proof e2e address.
 *
 * The prefix is slugified rather than interpolated raw, because the addresses
 * this mints are typed into the sign-in form's `<input type="email" required>`
 * — and that input is validated twice, by the browser's native constraint check
 * and by the page's own `z.string().email()`. A prefix carrying anything an
 * address may not (a space, most obviously — a caller reusing a human-readable
 * fixture label like `'A11y Rel'` is the natural way to get one) produces a row
 * that seeds fine and then cannot be signed in as: both validators reject it,
 * react-hook-form never reaches its submit handler, and the click is swallowed
 * with nothing on screen. The only symptom is the eventual
 * `page.waitForURL` timeout in `signInAsFreshUser`, pointing at the wait rather
 * than at the address (#2043).
 */
// Write a Setting row in the GLOBAL layer (orgId = NULL) — the layer a
// single-tenant test server reads, and the fallback every tenant inherits
// (#1553). Deliberately a read-modify-write: the natural key (orgId, key)
// contains a nullable column, so `upsert` cannot address the NULL row.
export async function setGlobalSetting(key: string, value: string) {
  const existing = await prisma.setting.findFirst({ where: { orgId: null, key } });
  if (existing) await prisma.setting.update({ where: { id: existing.id }, data: { value } });
  else await prisma.setting.create({ data: { orgId: null, key, value } });
}

export function uniqueEmail(prefix: string) {
  const slug = prefix.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'e2e';
  return `${slug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@e2e.local`;
}

export async function seedInvite(email: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE') {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.invitationToken.create({ data: { token, email, role, expiresAt } });
  return token;
}

/**
 * Seed one account.
 *
 * The optional fifth argument (#2590) is the `orgId` to put the account into at
 * creation — the way a spec seeds "this person's marketing-world account" (an
 * org whose `vertical` is MARKETING) next to an internship one with the SAME
 * address. Omitted, the row is org-less exactly as before (the default org, i.e.
 * the INTERNSHIP world), so every existing caller is unchanged. It may be given
 * bare (`seedUser(e, p, r, n, org.id)`) or as `{ orgId }`; `null` is an explicit
 * "no org", the same as leaving it out.
 *
 * Note what this does NOT enforce: `User.email` is no longer globally unique, the
 * database only refuses a second row for the same (email, orgId), and MySQL
 * treats every NULL orgId as distinct — so two org-less seeds of one address
 * both succeed. The app's own rule (one account per address per WORLD,
 * `emailTakenInWorld`) lives in the create paths, not here; a spec that seeds
 * the same address twice into ONE world is building a fixture the app would
 * never produce, so it should not.
 */
export async function seedUser(
  email: string,
  password: string,
  role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY' | 'SOURCE',
  fullName: string,
  org?: string | null | { orgId?: string | null }
) {
  const orgId = typeof org === 'object' && org !== null ? org.orgId : org;
  const hash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: {
      email,
      password: hash,
      role,
      fullName,
      skills: [],
      ...(orgId ? { orgId } : {}),
      // Every other spec seeding a MENTOR expects to land straight on the
      // dashboard, not the first-run onboarding wizard (#911) — only specs
      // testing that wizard itself want a "fresh" mentor, and they clear
      // this field back to null after seeding.
      ...(role === 'MENTOR' ? { mentorOnboardingSeenAt: new Date() } : {}),
    },
  });
}

/**
 * The users of one WORLD, as a Prisma `where` fragment (#2590) — the plain
 * mirror of `worldUserWhere()` in src/lib/userWorld.ts, which a spec helper does
 * not import because that module pulls the app's own PrismaClient (and its
 * tenant middleware) into every worker. Keep the two in step: a non-default
 * vertical is exactly its organizations' users; the DEFAULT vertical is
 * everything that is not one of the others, org-less rows included.
 */
export function worldUserWhere(world: VerticalKey): Prisma.UserWhereInput {
  const w = toVerticalKey(world);
  if (w !== DEFAULT_VERTICAL) return { org: { is: { vertical: w } } };
  const others = VERTICAL_KEYS.filter((k) => k !== DEFAULT_VERTICAL);
  return others.length ? { NOT: { org: { is: { vertical: { in: others } } } } } : {};
}

/**
 * The account this address holds in this world, or null.
 *
 * For addresses that are NOT unique to one test — the seeded admin
 * (`admin@example.com`), or any fixture that deliberately gives one person an
 * account in each product. A bare `findFirst({ where: { email } })` would pick
 * between the two worlds arbitrarily, so a lookup that means "the person as the
 * INTERNSHIP site knows them" says so. `select` is required, like the app's own
 * `findUserInWorld`, so a spec never hydrates a whole row by accident.
 */
export async function userInWorld<S extends Prisma.UserSelect>(
  email: string,
  world: VerticalKey,
  select: S
): Promise<Prisma.UserGetPayload<{ select: S }> | null> {
  return prisma.user.findFirst({
    where: { email: email.trim().toLowerCase(), ...worldUserWhere(world) },
    select,
    orderBy: { createdAt: 'asc' },
  }) as Promise<Prisma.UserGetPayload<{ select: S }> | null>;
}

export async function cleanupByEmail(email: string) {
  // Remove dependent mentorship relations first, then the user + any tokens.
  //
  // EVERY account carrying the address, not "the" account: since worlds (#2590)
  // one address may hold a row per product, and a spec that seeded a person into
  // both worlds must be able to tear both down with the one call it already
  // makes. An address is otherwise unique to its test, so for every other caller
  // this is still exactly one row.
  const users = await prisma.user.findMany({ where: { email }, select: { id: true } });
  for (const user of users) {
    await prisma.mentorshipRelation.deleteMany({
      where: { OR: [{ mentorId: user.id }, { menteeId: user.id }] },
    });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
  await prisma.invitationToken.deleteMany({ where: { email: { equals: email } } });
  // Brute-force lockouts are keyed by the typed email and carry no FK, so a
  // deleted user leaves one behind unless it is dropped here (#1541).
  await prisma.accountLockout.deleteMany({ where: { email: email.toLowerCase() } });
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
