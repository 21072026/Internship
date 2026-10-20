// The review queue for free-text skills the backfill could not resolve (#1819).
//
// `prisma/backfill-skill-taxonomy.mjs` parks every unresolved term in
// `UnmappedSkillTerm`; an admin decides here what it is:
//   promote — it becomes a canonical skill of its own,
//   alias   — it is another spelling of an existing skill,
//   discard — it is noise; the free text stays where it is, nothing is linked.
// Promote and alias retro-create the `UserSkill` / `RequisitionSkill` rows for
// everybody whose free text carries the term, so the decision takes effect
// for the people who already typed it, not only for the next run.
//
// Every decision is ONE guarded transition out of PENDING (`updateMany` with
// `resolution: 'PENDING'` in the WHERE), so two admins deciding the same term
// at once cannot both win. The JSON columns are never written.

import { prisma } from '@/lib/prisma';
import { skillKey, normalizeSkillName } from '@/lib/skills';
import { MAX_SKILLS_PER_ORG, isValidSkillLabel, skillKeyFromFolded } from '@/lib/skillTaxonomyRule';

export type QueueAction = 'promote' | 'alias' | 'discard';

export type QueueResult =
  | { ok: true; resolution: 'PROMOTED' | 'ALIASED' | 'DISCARDED'; skillId: string | null; linkedUsers: number; linkedRequisitions: number }
  | { ok: false; status: 400 | 404 | 409; code: string };

const PAGE = 500;

export async function listUnmappedTerms(orgId: string, resolution: string = 'PENDING') {
  return prisma.unmappedSkillTerm.findMany({
    where: { orgId, resolution },
    orderBy: [{ occurrences: 'desc' }, { term: 'asc' }],
    take: 500,
    select: {
      id: true,
      term: true,
      normalizedKey: true,
      occurrences: true,
      firstSeenAt: true,
      resolution: true,
      resolvedSkillId: true,
      resolvedAt: true,
    },
  });
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Link every person and requisition of the org whose free text carries
 * `normalizedKey` to `skillId`. Idempotent (`skipDuplicates` on the unique key).
 * A scan of the org's JSON columns — MySQL cannot match inside a JSON array —
 * paged, and run once per decision, never on a request path that repeats.
 */
export async function linkFreeTextHolders(
  orgId: string,
  normalizedKey: string,
  skillId: string,
): Promise<{ users: number; requisitions: number }> {
  const holds = (value: unknown) => asList(value).some((raw) => skillKey(raw) === normalizedKey);

  let users = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows: { id: string; skills: unknown }[] = await prisma.user.findMany({
      where: { orgId },
      select: { id: true, skills: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    const ids = rows.filter((r) => holds(r.skills)).map((r) => r.id);
    if (ids.length > 0) {
      users += (await prisma.userSkill.createMany({
        data: ids.map((userId) => ({ userId, skillId, source: 'BACKFILL' })),
        skipDuplicates: true,
      })).count;
    }
  }

  let requisitions = 0;
  cursor = null;
  for (;;) {
    const rows: { id: string; requiredSkills: unknown }[] = await prisma.requisition.findMany({
      where: { orgId },
      select: { id: true, requiredSkills: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    const ids = rows.filter((r) => holds(r.requiredSkills)).map((r) => r.id);
    if (ids.length > 0) {
      requisitions += (await prisma.requisitionSkill.createMany({
        data: ids.map((requisitionId) => ({ requisitionId, skillId, required: true })),
        skipDuplicates: true,
      })).count;
    }
  }
  return { users, requisitions };
}

export interface DecideInput {
  action: QueueAction;
  /** alias: the canonical skill the term is another spelling of. */
  skillId?: string;
  /** promote: optional labels; each defaults to the queued spelling. */
  labelEn?: string;
  labelTr?: string;
  labelDe?: string;
}

/** Decide one queued term. `orgId` comes from the session, never the body. */
export async function decideUnmappedTerm(
  orgId: string,
  termId: string,
  input: DecideInput,
  actorId: string,
): Promise<QueueResult> {
  const term = await prisma.unmappedSkillTerm.findFirst({
    where: { id: termId, orgId },
    select: { id: true, term: true, normalizedKey: true, resolution: true },
  });
  if (!term) return { ok: false, status: 404, code: 'not_found' };
  if (term.resolution !== 'PENDING') return { ok: false, status: 409, code: 'already_decided' };

  const claim = (resolution: string, resolvedSkillId: string | null) =>
    prisma.unmappedSkillTerm.updateMany({
      where: { id: term.id, orgId, resolution: 'PENDING' },
      data: { resolution, resolvedSkillId, resolvedById: actorId, resolvedAt: new Date() },
    });

  if (input.action === 'discard') {
    const { count } = await claim('DISCARDED', null);
    if (count === 0) return { ok: false, status: 409, code: 'already_decided' };
    return { ok: true, resolution: 'DISCARDED', skillId: null, linkedUsers: 0, linkedRequisitions: 0 };
  }

  let skillId: string;
  if (input.action === 'alias') {
    if (!input.skillId) return { ok: false, status: 400, code: 'skill_required' };
    const target = await prisma.skill.findFirst({
      where: { id: input.skillId, orgId, status: 'ACTIVE', mergedIntoId: null },
      select: { id: true, key: true },
    });
    if (!target) return { ok: false, status: 404, code: 'skill_not_found' };
    if (target.key === term.normalizedKey) return { ok: false, status: 409, code: 'alias_taken' };
    const taken = await prisma.skillAlias.findUnique({
      where: { orgId_key: { orgId, key: term.normalizedKey } },
      select: { skillId: true },
    });
    if (taken && taken.skillId !== target.id) return { ok: false, status: 409, code: 'alias_taken' };

    const outcome = await prisma.$transaction(async (tx) => {
      const { count } = await tx.unmappedSkillTerm.updateMany({
        where: { id: term.id, orgId, resolution: 'PENDING' },
        data: { resolution: 'ALIASED', resolvedSkillId: target.id, resolvedById: actorId, resolvedAt: new Date() },
      });
      if (count === 0) return false;
      if (!taken) await tx.skillAlias.create({ data: { orgId, skillId: target.id, key: term.normalizedKey } });
      return true;
    });
    if (!outcome) return { ok: false, status: 409, code: 'already_decided' };
    skillId = target.id;
  } else {
    const labels = [input.labelEn, input.labelTr, input.labelDe].map((l) => normalizeSkillName(l ?? term.term));
    if (!labels.every(isValidSkillLabel)) return { ok: false, status: 400, code: 'invalid_label' };
    const key = skillKeyFromFolded(term.normalizedKey);
    const [clash, count] = await Promise.all([
      prisma.skill.findFirst({ where: { orgId, key }, select: { id: true } }),
      prisma.skill.count({ where: { orgId } }),
    ]);
    if (clash) return { ok: false, status: 409, code: 'key_taken' };
    if (count >= MAX_SKILLS_PER_ORG) return { ok: false, status: 409, code: 'org_limit' };

    const created = await prisma.$transaction(async (tx) => {
      const skill = await tx.skill.create({
        data: { orgId, key, labelEn: labels[0], labelTr: labels[1], labelDe: labels[2], createdById: actorId },
        select: { id: true },
      });
      const { count: claimed } = await tx.unmappedSkillTerm.updateMany({
        where: { id: term.id, orgId, resolution: 'PENDING' },
        data: { resolution: 'PROMOTED', resolvedSkillId: skill.id, resolvedById: actorId, resolvedAt: new Date() },
      });
      // Lost the race: throwing rolls the new skill back with it.
      if (claimed === 0) throw new QueueRace();
      if (key !== term.normalizedKey) {
        await tx.skillAlias.createMany({ data: [{ orgId, skillId: skill.id, key: term.normalizedKey }], skipDuplicates: true });
      }
      return skill.id;
    }).catch((err) => {
      if (err instanceof QueueRace) return null;
      throw err;
    });
    if (!created) return { ok: false, status: 409, code: 'already_decided' };
    skillId = created;
  }

  const linked = await linkFreeTextHolders(orgId, term.normalizedKey, skillId);
  return {
    ok: true,
    resolution: input.action === 'alias' ? 'ALIASED' : 'PROMOTED',
    skillId,
    linkedUsers: linked.users,
    linkedRequisitions: linked.requisitions,
  };
}

class QueueRace extends Error {}
