/**
 * The canonical-skill half of a score's inputs (#1787/#1789), loaded once and
 * shared by every server path that scores a pair — the suggestion route and
 * the decision record — so the two can never read the skill graph differently.
 * Server-only (Prisma); the scorer that consumes it is the pure ./score.ts.
 */

import { prisma } from '@/lib/prisma';
import { loadSkillEdges, skillLabels } from '@/lib/skillsResolve';
import type { ScoreContext } from './dimensions';

/** Each user's canonical skill ids (`UserSkill`), in one query. */
export async function skillIdsByUser(userIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const rows = await prisma.userSkill.findMany({ where: { userId: { in: [...userIds] } }, select: { userId: true, skillId: true } });
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.skillId]);
  return out;
}

/**
 * The org's skill graph around a mentee's skills, labelled in `locale`, or
 * `undefined` when the mentee has no canonical skills — the `skills`
 * dimension then compares free text, so nobody's score goes blank mid-migration.
 */
export async function skillGraphFor(
  orgId: string | null | undefined,
  menteeSkillIds: readonly string[],
  locale: string,
): Promise<ScoreContext['skillGraph']> {
  if (menteeSkillIds.length === 0) return undefined;
  const edges = orgId ? await loadSkillEdges(orgId, [...menteeSkillIds]) : [];
  const ids = [...new Set([...menteeSkillIds, ...edges.flatMap((e) => [e.fromSkillId, e.toSkillId])])];
  const labels = orgId && ids.length ? await skillLabels(orgId, ids, locale) : new Map<string, string>();
  return { edges, label: (id: string) => labels.get(id) ?? id };
}
