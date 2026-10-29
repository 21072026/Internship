// The DB-side half of skill proficiency (#1822): reading a person's levels and
// a mentor's confirmation. The rules (what a confirmation writes, when history
// is due) are pure in `src/lib/skillLevelRule.ts`; the self-assessment mirror
// of a profile save is `syncUserSkillLevels()` in `src/lib/skillsResolve.ts`.
//
// Who may confirm is the route's question (`/api/mentorship/[id]/skills/…`),
// answered from the relation — never from a body field.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { skillLabel } from '@/lib/skillTaxonomyRule';
import { resolveMany } from '@/lib/skillsResolve';
import { confirmLevelPlan, mergedLevel, skillProgression } from '@/lib/skillLevelRule';

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

// ─── Folding two rows into one (#1822) ───────────────────────────────────────

/** The columns a fold reads from both rows. */
export const USER_SKILL_FOLD_SELECT = {
  id: true,
  userId: true,
  skillId: true,
  level: true,
  levelSource: true,
  verifiedById: true,
  verifiedAt: true,
} as const;

type FoldRow = { id: string; level: number | null; levelSource: string | null; verifiedById: string | null; verifiedAt: Date | null };

/**
 * Two `UserSkill` rows that are about to become one — the curator merged the
 * loser's skill into the target's, or an admin merged the loser's account into
 * the target's. The target row survives: the loser's level history moves onto
 * it, and its proficiency becomes whichever `mergedLevel()` says wins (a
 * confirmed level beats a self-rating, a rating beats none). The caller deletes
 * the loser row afterwards, inside the same transaction. The ONE fold both
 * merges use, so a rating is lost by neither.
 */
export async function foldUserSkillRow(tx: Prisma.TransactionClient, target: FoldRow, loser: FoldRow): Promise<void> {
  await tx.userSkillLevelChange.updateMany({ where: { userSkillId: loser.id }, data: { userSkillId: target.id } });
  const winner = mergedLevel(target, loser);
  if (winner) await tx.userSkill.update({ where: { id: target.id }, data: winner });
}

/**
 * Move every canonical skill row of `fromUserId` onto `toUserId` (an account
 * merge). A skill only the loser holds is re-pointed as is; a skill both hold
 * is folded with `foldUserSkillRow` and the loser's row removed. Returns the
 * counts for the merge report.
 */
export async function moveUserSkills(
  tx: Prisma.TransactionClient,
  fromUserId: string,
  toUserId: string,
): Promise<{ moved: number; folded: number }> {
  const [losers, targets] = await Promise.all([
    tx.userSkill.findMany({ where: { userId: fromUserId }, select: USER_SKILL_FOLD_SELECT }),
    tx.userSkill.findMany({ where: { userId: toUserId }, select: USER_SKILL_FOLD_SELECT }),
  ]);
  const targetOf = new Map(targets.map((r) => [r.skillId, r]));
  let moved = 0;
  let folded = 0;
  for (const loser of losers) {
    const target = targetOf.get(loser.skillId);
    if (!target) {
      await tx.userSkill.update({ where: { id: loser.id }, data: { userId: toUserId } });
      moved++;
      continue;
    }
    await foldUserSkillRow(tx, target, loser);
    await tx.userSkill.delete({ where: { id: loser.id } });
    folded++;
  }
  return { moved, folded };
}
