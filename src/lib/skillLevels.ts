// The DB-side half of skill proficiency (#1822): reading a person's levels and
// a mentor's confirmation. The rules (what a confirmation writes, when history
// is due) are pure in `src/lib/skillLevelRule.ts`; the self-assessment mirror
// of a profile save is `syncUserSkillLevels()` in `src/lib/skillsResolve.ts`.
//
// Who may confirm is the route's question (`/api/mentorship/[id]/skills/…`),
// answered from the relation — never from a body field.

import { prisma } from '@/lib/prisma';
import { skillLabel } from '@/lib/skillTaxonomyRule';
import { resolveMany } from '@/lib/skillsResolve';
import { confirmLevelPlan, skillProgression } from '@/lib/skillLevelRule';

export interface SkillLevelView {
  skillId: string;
  label: string;
  level: number | null;
  levelSource: string | null;
  verified: boolean;
  verifiedAt: string | null;
}

/** A person's canonical skills with their levels, labelled in `locale`. */
export async function skillLevelsOf(userId: string, locale: string): Promise<SkillLevelView[]> {
  const rows = await prisma.userSkill.findMany({
    where: { userId },
    select: {
      skillId: true,
      level: true,
      levelSource: true,
      verifiedAt: true,
      skill: { select: { labelEn: true, labelTr: true, labelDe: true } },
    },
  });
  return rows
    .map((r) => ({
      skillId: r.skillId,
      label: skillLabel(r.skill, locale),
      level: r.level,
      levelSource: r.levelSource,
      verified: r.verifiedAt !== null,
      verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

export type ConfirmOutcome = { ok: true; changed: boolean } | { ok: false; reason: 'missing' | 'conflict' };

/**
 * Record a mentor's confirmation of `userId`'s level on `skillId` (optionally
 * correcting it). One guarded update — the level read here is in the WHERE, so
 * a self-assessment saved in between answers `conflict` instead of being
 * silently overwritten — plus a history row when the value moved.
 */
export async function confirmSkillLevel(input: {
  userId: string;
  skillId: string;
  level: number;
  actorId: string;
}): Promise<ConfirmOutcome> {
  const row = await prisma.userSkill.findUnique({
    where: { userId_skillId: { userId: input.userId, skillId: input.skillId } },
    select: { id: true, level: true },
  });
  if (!row) return { ok: false, reason: 'missing' };
  const plan = confirmLevelPlan(row.level, input.level, input.actorId, 'MENTOR', new Date());
  return prisma.$transaction(async (tx) => {
    const moved = await tx.userSkill.updateMany({ where: { id: row.id, level: row.level }, data: plan.data });
    if (moved.count !== 1) return { ok: false, reason: 'conflict' } as const;
    if (plan.change) {
      await tx.userSkillLevelChange.create({
        data: { userSkillId: row.id, ...plan.change, source: 'MENTOR', changedById: input.actorId },
      });
    }
    return { ok: true, changed: plan.change !== null } as const;
  });
}

/**
 * The confirmed levels of a person, keyed by the TYPED skill strings a screen
 * already renders (`User.skills`), so a chip can show the confirmed value and a
 * mark without the screen learning about skill ids. Unconfirmed skills are
 * absent.
 */
export async function verifiedLevelsByTerm(
  orgId: string | null,
  userId: string,
  terms: readonly string[],
): Promise<Record<string, number>> {
  if (!orgId || terms.length === 0) return {};
  const rows = await prisma.userSkill.findMany({
    where: { userId, verifiedAt: { not: null }, level: { not: null } },
    select: { skillId: true, level: true },
  });
  if (rows.length === 0) return {};
  const levelOf = new Map(rows.map((r) => [r.skillId, r.level as number]));
  const resolved = await resolveMany(orgId, terms);
  const out: Record<string, number> = {};
  for (const term of terms) {
    const id = resolved.get(term)?.id;
    if (id && levelOf.has(id)) out[term] = levelOf.get(id)!;
  }
  return out;
}

export interface SkillProgressView {
  skillId: string;
  label: string;
  start: number;
  now: number;
  verified: boolean;
}

/**
 * A person's rated skills, each with where it started and where it is now
 * (`skillProgression`), most-grown first. Free core: a mentee reading their
 * own growth is never gated.
 */
export async function skillProgressOf(userId: string, locale: string): Promise<SkillProgressView[]> {
  const rows = await prisma.userSkill.findMany({
    where: { userId, level: { not: null } },
    select: {
      skillId: true,
      level: true,
      verifiedAt: true,
      skill: { select: { labelEn: true, labelTr: true, labelDe: true } },
      levelChanges: { orderBy: { createdAt: 'asc' }, select: { fromLevel: true, toLevel: true } },
    },
  });
  const out: SkillProgressView[] = [];
  for (const r of rows) {
    const p = skillProgression(r.levelChanges, r.level);
    if (!p) continue;
    out.push({ skillId: r.skillId, label: skillLabel(r.skill, locale), ...p, verified: r.verifiedAt !== null });
  }
  return out.sort((a, b) => b.now - b.start - (a.now - a.start) || a.label.localeCompare(b.label, locale));
}
