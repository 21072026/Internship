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

/**
 * The cohort pass's version of `skillGraphFor` (#1794): ONE edge query and
 * ONE label query for the whole intake, then each mentee gets only the edges
 * that touch their own skills — exactly the edges `skillGraphFor` would have
 * loaded for them alone, so a pair scores the same here as in a suggestion
 * list, without a query per mentee.
 */
export async function skillGraphsFor(
  orgId: string | null | undefined,
  menteeSkillIds: ReadonlyMap<string, readonly string[]>,
  locale: string,
): Promise<(menteeId: string) => ScoreContext['skillGraph']> {
  const all = [...new Set([...menteeSkillIds.values()].flat())];
  if (all.length === 0) return () => undefined;
  // Sorted: an equal-weight neighbour is picked by edge order, and a round
  // must not depend on the order MySQL happened to return rows in.
  const key = (e: { fromSkillId: string; toSkillId: string }) => `${e.fromSkillId}\u0000${e.toSkillId}`;
  const edges = (orgId ? await loadSkillEdges(orgId, all) : []).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const ids = [...new Set([...all, ...edges.flatMap((e) => [e.fromSkillId, e.toSkillId])])];
  const labels = orgId ? await skillLabels(orgId, ids, locale) : new Map<string, string>();
  const label = (id: string) => labels.get(id) ?? id;
  const cache = new Map<string, ScoreContext['skillGraph']>();
  return (menteeId) => {
    if (cache.has(menteeId)) return cache.get(menteeId);
    const own = new Set(menteeSkillIds.get(menteeId) ?? []);
    const graph = own.size === 0 ? undefined : { edges: edges.filter((e) => own.has(e.fromSkillId) || own.has(e.toSkillId)), label };
    cache.set(menteeId, graph);
    return graph;
  };
}
