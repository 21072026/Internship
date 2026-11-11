// Curating an org's canonical skill vocabulary (#1817) — the server half of
// /admin/skills. Every function takes the org from its caller, which takes it
// from the session (never from a request body), and every query names that
// org explicitly: the taxonomy models are in TENANT_MODELS, but the middleware
// is dormant unless MT_ENFORCE_ISOLATION is on.
//
// The rules that keep the taxonomy coherent:
//   - A key or an alias is unique per org ACROSS both tables: a spelling that is
//     one skill's alias can never be another skill's key, or `resolveSkill()`
//     would answer differently depending on which lookup ran first.
//   - Merging never deletes the losing skill. Its people and requisitions move
//     to the target (a person who held both keeps one row), its aliases and
//     edges move with them, and the row stays with `mergedIntoId` set so every
//     old reference — and every old spelling — still resolves.
//   - Retiring hides a skill from suggestions and matching; it removes nobody's
//     row, so reactivating it restores everything.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { normalizeSkillName, skillKey } from '@/lib/skills';
import { seedSkillTaxonomy } from '@/lib/skillsResolve';
import { USER_SKILL_FOLD_SELECT, foldUserSkillRow } from '@/lib/skillLevels';
import {
  MAX_SKILLS_PER_ORG,
  MAX_SKILL_KEY_LENGTH,
  SKILL_EDGE_KINDS,
  clampEdgeWeight,
  isValidSkillLabel,
  skillKeyFromFolded,
} from '@/lib/skillTaxonomyRule';

export const MAX_EDGES_PER_SKILL = 50;
export const MAX_ALIASES_PER_SKILL = 50;
const PAGE_SIZE = 100;

export type CurationError = { ok: false; status: 400 | 404 | 409; code: string };
export type CurationResult<T> = ({ ok: true } & T) | CurationError;

const fail = (status: 400 | 404 | 409, code: string): CurationError => ({ ok: false, status, code });

export interface SkillListQuery {
  q?: string;
  status?: 'ACTIVE' | 'RETIRED' | 'MERGED' | 'ALL';
  page?: number;
}

/** The vocabulary with usage counts, aliases and adjacency, one page at a time. */
export async function listSkills(orgId: string, query: SkillListQuery = {}) {
  // An org created after the last deploy has no rows yet; give it the starter
  // set rather than an empty screen (insert-missing, so it never undoes curation).
  if ((await prisma.skill.count({ where: { orgId } })) === 0) await seedSkillTaxonomy(orgId);

  const q = (query.q ?? '').trim().slice(0, 60);
  const folded = q ? skillKey(q) : '';
  const status = query.status ?? 'ACTIVE';
  const where: Prisma.SkillWhereInput = {
    orgId,
    ...(status === 'MERGED'
      ? { mergedIntoId: { not: null } }
      : status === 'ALL'
        ? {}
        : { status, mergedIntoId: null }),
    ...(q
      ? {
          OR: [
            { labelEn: { contains: q } },
            { labelTr: { contains: q } },
            { labelDe: { contains: q } },
            { key: { contains: folded } },
            { aliases: { some: { key: { contains: folded } } } },
          ],
        }
      : {}),
  };
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const [total, orgTotal, rows] = await Promise.all([
    prisma.skill.count({ where }),
    prisma.skill.count({ where: { orgId } }),
    prisma.skill.findMany({
      where,
      orderBy: [{ labelEn: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        key: true,
        labelEn: true,
        labelTr: true,
        labelDe: true,
        category: true,
        status: true,
        mergedIntoId: true,
        mergedInto: { select: { labelEn: true } },
        aliases: { select: { id: true, key: true }, orderBy: { key: 'asc' } },
        edgesFrom: { select: { id: true, weight: true, kind: true, to: { select: { id: true, labelEn: true } } } },
        edgesTo: { select: { id: true, weight: true, kind: true, from: { select: { id: true, labelEn: true } } } },
        _count: { select: { users: true, requisitions: true } },
      },
    }),
  ]);

  return {
    total,
    orgTotal,
    limit: MAX_SKILLS_PER_ORG,
    page,
    pageSize: PAGE_SIZE,
    skills: rows.map((row) => ({
      id: row.id,
      key: row.key,
      labelEn: row.labelEn,
      labelTr: row.labelTr,
      labelDe: row.labelDe,
      category: row.category,
      status: row.status,
      mergedIntoId: row.mergedIntoId,
      mergedIntoLabel: row.mergedInto?.labelEn ?? null,
      usageUsers: row._count.users,
      usageRequisitions: row._count.requisitions,
      aliases: row.aliases,
      // ADJACENT reads both ways, so an edge stored on the other skill shows here too.
      edges: [
        ...row.edgesFrom.map((e) => ({ id: e.id, skillId: e.to.id, label: e.to.labelEn, weight: e.weight, kind: e.kind })),
        ...row.edgesTo
          .filter((e) => e.kind === 'ADJACENT')
          .map((e) => ({ id: e.id, skillId: e.from.id, label: e.from.labelEn, weight: e.weight, kind: e.kind })),
      ],
    })),
  };
}

/** Is this folded spelling already a key or an alias in the org (other than `exceptSkillId`)? */
async function spellingTaken(orgId: string, folded: string, exceptSkillId?: string) {
  const key = skillKeyFromFolded(folded);
  const [skill, alias] = await Promise.all([
    prisma.skill.findFirst({ where: { orgId, key: { in: [folded, key] } }, select: { id: true } }),
    prisma.skillAlias.findFirst({ where: { orgId, key: folded }, select: { skillId: true } }),
  ]);
  const owner = skill?.id ?? alias?.skillId ?? null;
  return owner && owner !== exceptSkillId ? owner : null;
}

function cleanLabels(input: { labelEn?: string; labelTr?: string; labelDe?: string }, fallback?: string) {
  const en = normalizeSkillName(input.labelEn ?? fallback ?? '');
  const tr = normalizeSkillName(input.labelTr || en);
  const de = normalizeSkillName(input.labelDe || en);
  return { labelEn: en, labelTr: tr, labelDe: de };
}

export async function createSkill(
  orgId: string,
  input: { labelEn: string; labelTr?: string; labelDe?: string; category?: string | null },
  actorId: string,
): Promise<CurationResult<{ skill: { id: string; key: string } }>> {
  const labels = cleanLabels(input);
  if (![labels.labelEn, labels.labelTr, labels.labelDe].every(isValidSkillLabel)) return fail(400, 'invalid_label');
  const folded = skillKey(labels.labelEn);
  if (!folded || folded.length > MAX_SKILL_KEY_LENGTH) return fail(400, 'invalid_label');
  if (await spellingTaken(orgId, folded)) return fail(409, 'duplicate');
  if ((await prisma.skill.count({ where: { orgId } })) >= MAX_SKILLS_PER_ORG) return fail(409, 'org_limit');

  const key = skillKeyFromFolded(folded);
  const skill = await prisma.skill.create({
    data: { orgId, key, ...labels, category: input.category?.trim().slice(0, 32) || null, createdById: actorId },
    select: { id: true, key: true },
  });
  // The folded label as an alias too, when the key had to be hyphenated
  // ("data analysis" → key "data-analysis"), so the label itself resolves.
  if (folded !== key) {
    await prisma.skillAlias.createMany({ data: [{ orgId, skillId: skill.id, key: folded }], skipDuplicates: true });
  }
  return { ok: true, skill };
}

async function ownSkill(orgId: string, id: string) {
  return prisma.skill.findFirst({
    where: { id, orgId },
    select: { id: true, key: true, labelEn: true, status: true, mergedIntoId: true },
  });
}

export async function updateSkill(
  orgId: string,
  id: string,
  input: { labelEn?: string; labelTr?: string; labelDe?: string; category?: string | null; status?: 'ACTIVE' | 'RETIRED' },
): Promise<CurationResult<{ skill: { id: string } }>> {
  const skill = await ownSkill(orgId, id);
  if (!skill) return fail(404, 'not_found');
  if (skill.mergedIntoId && input.status === 'ACTIVE') return fail(409, 'merged');

  const data: Prisma.SkillUpdateInput = {};
  for (const field of ['labelEn', 'labelTr', 'labelDe'] as const) {
    if (input[field] === undefined) continue;
    const label = normalizeSkillName(input[field]!);
    if (!isValidSkillLabel(label)) return fail(400, 'invalid_label');
    data[field] = label;
  }
  if (input.category !== undefined) data.category = input.category?.trim().slice(0, 32) || null;
  if (input.status !== undefined) data.status = input.status;
  if (Object.keys(data).length === 0) return fail(400, 'no_changes');

  // A relabel leaves the key alone (it is forever), but the new English label
  // must still find the skill: add its fold as an alias unless another skill
  // already owns that spelling, which is a conflict to resolve by merging.
  if (typeof data.labelEn === 'string') {
    const folded = skillKey(data.labelEn);
    const owner = await spellingTaken(orgId, folded, id);
    if (owner) return fail(409, 'duplicate');
    if (folded !== skill.key && folded.length <= MAX_SKILL_KEY_LENGTH) {
      await prisma.skillAlias.createMany({ data: [{ orgId, skillId: id, key: folded }], skipDuplicates: true });
    }
  }
  await prisma.skill.update({ where: { id }, data });
  return { ok: true, skill: { id } };
}

export async function addAlias(
  orgId: string,
  id: string,
  raw: string,
): Promise<CurationResult<{ alias: { id: string; key: string } }>> {
  const skill = await ownSkill(orgId, id);
  if (!skill) return fail(404, 'not_found');
  if (skill.mergedIntoId) return fail(409, 'merged');
  const folded = skillKey(raw);
  if (!folded || folded.length > MAX_SKILL_KEY_LENGTH || !isValidSkillLabel(normalizeSkillName(raw))) {
    return fail(400, 'invalid_alias');
  }
  if (folded === skill.key) return fail(409, 'duplicate');
  if (await spellingTaken(orgId, folded)) return fail(409, 'duplicate');
  if ((await prisma.skillAlias.count({ where: { skillId: id } })) >= MAX_ALIASES_PER_SKILL) return fail(409, 'alias_limit');
  const alias = await prisma.skillAlias.create({ data: { orgId, skillId: id, key: folded }, select: { id: true, key: true } });
  return { ok: true, alias };
}

export async function removeAlias(orgId: string, id: string, aliasId: string): Promise<CurationResult<object>> {
  const { count } = await prisma.skillAlias.deleteMany({ where: { id: aliasId, skillId: id, orgId } });
  return count === 1 ? { ok: true } : fail(404, 'not_found');
}

async function mergeTarget(orgId: string, id: string, targetId: string) {
  if (id === targetId) return fail(400, 'same_skill');
  const [loser, target] = await Promise.all([ownSkill(orgId, id), ownSkill(orgId, targetId)]);
  if (!loser || !target) return fail(404, 'not_found');
  if (loser.mergedIntoId) return fail(409, 'merged');
  if (target.mergedIntoId || target.status !== 'ACTIVE') return fail(409, 'target_inactive');
  return { ok: true as const, loser, target };
}

/** What a merge would touch — the dialog states it before the admin confirms. */
export async function mergePreview(
  orgId: string,
  id: string,
  targetId: string,
): Promise<CurationResult<{ users: number; requisitions: number; alreadyBoth: number }>> {
  const check = await mergeTarget(orgId, id, targetId);
  if (!check.ok) return check;
  const [users, requisitions, targetHolders] = await Promise.all([
    prisma.userSkill.count({ where: { skillId: id } }),
    prisma.requisitionSkill.count({ where: { skillId: id } }),
    prisma.userSkill.findMany({ where: { skillId: targetId }, select: { userId: true } }),
  ]);
  const alreadyBoth = targetHolders.length
    ? await prisma.userSkill.count({ where: { skillId: id, userId: { in: targetHolders.map((h) => h.userId) } } })
    : 0;
  return { ok: true, users, requisitions, alreadyBoth };
}

/**
 * Merge skill `id` into `targetId`, in one transaction. People and requisitions
 * move (a duplicate row is dropped instead of violating the unique key),
 * aliases move, edges are re-pointed (a self-loop or an existing pair is
 * dropped), and the loser stays as a RETIRED row with `mergedIntoId` set.
 */
export async function mergeSkill(
  orgId: string,
  id: string,
  targetId: string,
): Promise<CurationResult<{ movedUsers: number; movedRequisitions: number }>> {
  const check = await mergeTarget(orgId, id, targetId);
  if (!check.ok) return check;

  const result = await prisma.$transaction(async (tx) => {
    // Guard the loser inside the transaction: two merges of the same skill
    // racing must not both run.
    const claimed = await tx.skill.updateMany({
      where: { id, orgId, mergedIntoId: null },
      data: { mergedIntoId: targetId, status: 'RETIRED' },
    });
    if (claimed.count !== 1) return null;

    // A person holding both keeps ONE row — the target's. Its proficiency is
    // decided by `mergedLevel` (a confirmed level beats a self-rating, a rating
    // beats none) and the loser's history moves over before the row goes (#1822).
    const targetRows = await tx.userSkill.findMany({ where: { skillId: targetId }, select: USER_SKILL_FOLD_SELECT });
    const targetUsers = targetRows.map((r) => r.userId);
    if (targetUsers.length) {
      const loserRows = await tx.userSkill.findMany({ where: { skillId: id, userId: { in: targetUsers } }, select: USER_SKILL_FOLD_SELECT });
      const targetOf = new Map(targetRows.map((r) => [r.userId, r]));
      for (const loser of loserRows) {
        const target = targetOf.get(loser.userId);
        if (target) await foldUserSkillRow(tx, target, loser);
      }
      await tx.userSkill.deleteMany({ where: { skillId: id, userId: { in: targetUsers } } });
    }
    const movedUsers = (await tx.userSkill.updateMany({ where: { skillId: id }, data: { skillId: targetId } })).count;

    const targetReqs = (await tx.requisitionSkill.findMany({ where: { skillId: targetId }, select: { requisitionId: true } })).map((r) => r.requisitionId);
    if (targetReqs.length) await tx.requisitionSkill.deleteMany({ where: { skillId: id, requisitionId: { in: targetReqs } } });
    const movedRequisitions = (await tx.requisitionSkill.updateMany({ where: { skillId: id }, data: { skillId: targetId } })).count;

    await tx.skillAlias.updateMany({ where: { skillId: id, orgId }, data: { skillId: targetId } });

    const edges = await tx.skillEdge.findMany({
      where: { orgId, OR: [{ fromSkillId: id }, { toSkillId: id }] },
      select: { id: true, fromSkillId: true, toSkillId: true },
    });
    const existing = await tx.skillEdge.findMany({
      where: { orgId, OR: [{ fromSkillId: targetId }, { toSkillId: targetId }] },
      select: { fromSkillId: true, toSkillId: true },
    });
    const linked = new Set(existing.flatMap((e) => [`${e.fromSkillId}>${e.toSkillId}`, `${e.toSkillId}>${e.fromSkillId}`]));
    for (const edge of edges) {
      const from = edge.fromSkillId === id ? targetId : edge.fromSkillId;
      const to = edge.toSkillId === id ? targetId : edge.toSkillId;
      if (from === to || linked.has(`${from}>${to}`)) {
        await tx.skillEdge.delete({ where: { id: edge.id } });
        continue;
      }
      await tx.skillEdge.update({ where: { id: edge.id }, data: { fromSkillId: from, toSkillId: to } });
      linked.add(`${from}>${to}`);
      linked.add(`${to}>${from}`);
    }
    return { movedUsers, movedRequisitions };
  });
  if (!result) return fail(409, 'merged');
  return { ok: true, ...result };
}

export interface EdgeInput {
  skillId: string;
  weight: number;
  kind?: string;
}

/**
 * Replace a skill's neighbours. ADJACENT pairs are stored once whichever side
 * they were authored on, so the replaced set is every edge leaving this skill
 * plus every ADJACENT edge arriving at it.
 */
export async function setEdges(orgId: string, id: string, input: readonly EdgeInput[]): Promise<CurationResult<{ count: number }>> {
  const skill = await ownSkill(orgId, id);
  if (!skill) return fail(404, 'not_found');
  if (skill.mergedIntoId) return fail(409, 'merged');
  if (input.length > MAX_EDGES_PER_SKILL) return fail(400, 'edge_limit');

  const wanted = new Map<string, { weight: number; kind: string }>();
  for (const edge of input) {
    const kind = edge.kind ?? 'ADJACENT';
    if (!(SKILL_EDGE_KINDS as readonly string[]).includes(kind)) return fail(400, 'invalid_kind');
    if (edge.skillId === id) return fail(400, 'self_edge');
    wanted.set(edge.skillId, { weight: clampEdgeWeight(edge.weight), kind });
  }
  if (wanted.size > 0) {
    const found = await prisma.skill.count({ where: { orgId, id: { in: [...wanted.keys()] }, mergedIntoId: null } });
    if (found !== wanted.size) return fail(404, 'neighbour_not_found');
  }

  await prisma.$transaction(async (tx) => {
    await tx.skillEdge.deleteMany({
      where: { orgId, OR: [{ fromSkillId: id }, { toSkillId: id, kind: 'ADJACENT' }] },
    });
    // An ADJACENT pair the other side authored as BROADER/NARROWER towards us
    // stays; only a same-direction duplicate would violate the unique key.
    await tx.skillEdge.createMany({
      data: [...wanted].map(([toSkillId, e]) => ({ orgId, fromSkillId: id, toSkillId, weight: e.weight, kind: e.kind })),
      skipDuplicates: true,
    });
  });
  return { ok: true, count: wanted.size };
}
