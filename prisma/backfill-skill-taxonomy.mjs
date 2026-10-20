// Map every free-text skill onto the canonical taxonomy, and queue what did
// not map (#1819, epic #1810).
//
// WHAT THIS DOES, per organization
//   1. Seeds the starter vocabulary (prisma/skill-seed.json, generated from
//      src/lib/skillSeed.ts) — INSERT of what is missing only, so a curator's
//      merge, retirement, relabel or reweighting is never undone.
//   2. Resolves each entry of `User.skills` and `Requisition.requiredSkills`
//      through the org's Skill / SkillAlias rows (same order as
//      `resolveMany()` in src/lib/skillsResolve.ts, through the same Turkish-
//      aware fold — `İ`/`ı`/`ş`/`ğ` included) and creates the `UserSkill`
//      (source BACKFILL) / `RequisitionSkill` rows. `skipDuplicates` on the
//      unique key: a re-run is a no-op and never overwrites a row.
//   3. Records every term nothing resolved in `UnmappedSkillTerm`, with its
//      occurrence count recomputed absolutely (people + requisitions), so an
//      admin decides — promote, alias, discard — instead of the script guessing.
//      A decided row keeps its decision; a PENDING row nobody holds any more
//      drops to 0 occurrences rather than disappearing.
//
// WHAT IT DOES NOT DO
//   Touch the JSON columns (expand, not contract). `MentorApplication.expertise`
//   is not mapped: an application is not a person yet, and approving it
//   copies the expertise into `User.skills`, which the next run maps.
//   Users with a NULL orgId are skipped (backfill-organization.mjs, earlier in
//   the deploy, fills those) and reported.
//
// Dry-run by default: prints resolved / unmapped counts and the top 50
// unmapped terms, writes nothing. `--apply` writes. `--org <id>` limits the run
// to one organization.
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { skillKey } from './skill-split.mjs';
import { DEFAULT_EDGE_WEIGHT, buildSeedPlan, makeResolver } from './skill-taxonomy-lib.mjs';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const orgArg = process.argv.indexOf('--org');
const ONLY_ORG = orgArg > -1 ? process.argv[orgArg + 1] : null;
const PAGE = 500;
const TERM_MAX = 60;

const SEED = JSON.parse(readFileSync(new URL('./skill-seed.json', import.meta.url), 'utf8'));
const PLAN = buildSeedPlan(SEED, skillKey);

const asList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

async function seedOrg(orgId) {
  if (!APPLY) return;
  await prisma.skill.createMany({ data: PLAN.skills.map((s) => ({ ...s, orgId })), skipDuplicates: true });
  const rows = await prisma.skill.findMany({ where: { orgId }, select: { id: true, key: true } });
  const idOf = new Map(rows.map((r) => [r.key, r.id]));
  await prisma.skillAlias.createMany({
    data: PLAN.aliases.filter((a) => idOf.has(a.key)).map((a) => ({ orgId, skillId: idOf.get(a.key), key: a.token })),
    skipDuplicates: true,
  });
  const existing = await prisma.skillEdge.findMany({ where: { orgId }, select: { fromSkillId: true, toSkillId: true } });
  const linked = new Set(existing.flatMap((e) => [`${e.fromSkillId}>${e.toSkillId}`, `${e.toSkillId}>${e.fromSkillId}`]));
  const edges = [];
  for (const { fromKey, toKey } of PLAN.edges) {
    const fromSkillId = idOf.get(fromKey);
    const toSkillId = idOf.get(toKey);
    if (!fromSkillId || !toSkillId || linked.has(`${fromSkillId}>${toSkillId}`)) continue;
    edges.push({ orgId, fromSkillId, toSkillId, weight: DEFAULT_EDGE_WEIGHT, kind: 'ADJACENT' });
  }
  await prisma.skillEdge.createMany({ data: edges, skipDuplicates: true });
}

async function resolverFor(orgId) {
  const [skills, aliases] = await Promise.all([
    prisma.skill.findMany({ where: { orgId }, select: { id: true, key: true, status: true, mergedIntoId: true } }),
    prisma.skillAlias.findMany({ where: { orgId }, select: { key: true, skillId: true } }),
  ]);
  if (skills.length > 0) return makeResolver({ skills, aliases });
  // Dry run on an org that was never seeded: resolve against the seed plan
  // itself, so the counts say what --apply would do.
  return makeResolver({
    skills: PLAN.skills.map((s) => ({ id: s.key, key: s.key, status: 'ACTIVE', mergedIntoId: null })),
    aliases: PLAN.aliases.map((a) => ({ key: a.token, skillId: a.key })),
  });
}

/** Walk one model's JSON column in pages and map each row's entries. */
async function sweep({ findMany, column, resolve, unmapped, writeRows }) {
  let cursor = null;
  const stats = { rows: 0, entries: 0, resolved: 0, unmapped: 0, created: 0 };
  for (;;) {
    const rows = await findMany(cursor);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    const links = [];
    for (const row of rows) {
      stats.rows++;
      const seenHere = new Set();
      for (const raw of asList(row[column])) {
        const folded = skillKey(raw);
        if (!folded || seenHere.has(folded)) continue;
        seenHere.add(folded);
        stats.entries++;
        const skillId = resolve(folded);
        if (skillId) {
          stats.resolved++;
          links.push({ ownerId: row.id, skillId });
          continue;
        }
        stats.unmapped++;
        const bucket = unmapped.get(folded) ?? { occurrences: 0, spellings: new Map() };
        bucket.occurrences++;
        const spelling = raw.trim().slice(0, TERM_MAX);
        bucket.spellings.set(spelling, (bucket.spellings.get(spelling) ?? 0) + 1);
        unmapped.set(folded, bucket);
      }
    }
    if (APPLY && links.length > 0) stats.created += await writeRows(links);
  }
  return stats;
}

function mostCommon(spellings) {
  let best = '';
  let count = -1;
  for (const [spelling, n] of spellings) {
    if (n > count || (n === count && spelling < best)) {
      best = spelling;
      count = n;
    }
  }
  return best;
}

async function recordUnmapped(orgId, unmapped) {
  if (!APPLY) return;
  const existing = await prisma.unmappedSkillTerm.findMany({
    where: { orgId },
    select: { id: true, normalizedKey: true, resolution: true, occurrences: true },
  });
  const byKey = new Map(existing.map((r) => [r.normalizedKey, r]));
  const fresh = [];
  for (const [normalizedKey, bucket] of unmapped) {
    if (normalizedKey.length > 64) continue;
    const row = byKey.get(normalizedKey);
    if (!row) {
      fresh.push({ orgId, normalizedKey, term: mostCommon(bucket.spellings), occurrences: bucket.occurrences });
    } else if (row.occurrences !== bucket.occurrences) {
      await prisma.unmappedSkillTerm.update({ where: { id: row.id }, data: { occurrences: bucket.occurrences } });
    }
  }
  if (fresh.length > 0) await prisma.unmappedSkillTerm.createMany({ data: fresh, skipDuplicates: true });
  // A PENDING term nobody holds any more: keep the row (it is history), zero it.
  const gone = existing.filter((r) => r.resolution === 'PENDING' && r.occurrences > 0 && !unmapped.has(r.normalizedKey));
  if (gone.length > 0) {
    await prisma.unmappedSkillTerm.updateMany({ where: { id: { in: gone.map((r) => r.id) } }, data: { occurrences: 0 } });
  }
}

async function main() {
  const orgs = await prisma.organization.findMany({
    where: ONLY_ORG ? { id: ONLY_ORG } : {},
    select: { id: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });
  const totals = { users: 0, requisitions: 0, entries: 0, resolved: 0, unmapped: 0, created: 0 };
  const top = new Map();

  for (const org of orgs) {
    await seedOrg(org.id);
    const resolve = await resolverFor(org.id);
    const unmapped = new Map();

    const users = await sweep({
      column: 'skills',
      resolve,
      unmapped,
      findMany: (cursor) =>
        prisma.user.findMany({
          where: { orgId: org.id },
          select: { id: true, skills: true },
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      writeRows: async (links) =>
        (await prisma.userSkill.createMany({
          data: links.map((l) => ({ userId: l.ownerId, skillId: l.skillId, source: 'BACKFILL' })),
          skipDuplicates: true,
        })).count,
    });
    const requisitions = await sweep({
      column: 'requiredSkills',
      resolve,
      unmapped,
      findMany: (cursor) =>
        prisma.requisition.findMany({
          where: { orgId: org.id },
          select: { id: true, requiredSkills: true },
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      writeRows: async (links) =>
        (await prisma.requisitionSkill.createMany({
          data: links.map((l) => ({ requisitionId: l.ownerId, skillId: l.skillId, required: true })),
          skipDuplicates: true,
        })).count,
    });
    await recordUnmapped(org.id, unmapped);

    totals.users += users.rows;
    totals.requisitions += requisitions.rows;
    for (const s of [users, requisitions]) {
      totals.entries += s.entries;
      totals.resolved += s.resolved;
      totals.unmapped += s.unmapped;
      totals.created += s.created;
    }
    for (const [key, bucket] of unmapped) {
      const t = top.get(key) ?? { term: mostCommon(bucket.spellings), occurrences: 0 };
      t.occurrences += bucket.occurrences;
      top.set(key, t);
    }
    if (users.entries + requisitions.entries > 0) {
      console.log(
        `  ${org.slug}: ${users.rows} users, ${requisitions.rows} requisitions — ` +
          `${users.resolved + requisitions.resolved} resolved, ${users.unmapped + requisitions.unmapped} unmapped` +
          (APPLY ? `, ${users.created + requisitions.created} rows created` : ''),
      );
    }
  }

  const orphans = ONLY_ORG ? 0 : await prisma.user.count({ where: { orgId: null } });
  const pct = totals.entries ? Math.round((totals.resolved / totals.entries) * 100) : 100;
  console.log(
    `skill taxonomy backfill ${APPLY ? '(applied)' : '(dry run — nothing written; --apply to write)'}: ` +
      `${orgs.length} org(s), ${totals.users} users, ${totals.requisitions} requisitions, ` +
      `${totals.entries} distinct entries — ${totals.resolved} resolved (${pct}%), ${totals.unmapped} unmapped ` +
      `(${top.size} distinct terms)` +
      (APPLY ? `, ${totals.created} join rows created` : '') +
      (orphans ? `; ${orphans} user(s) with no org skipped` : ''),
  );
  const ranked = [...top.values()].sort((a, b) => b.occurrences - a.occurrences || a.term.localeCompare(b.term)).slice(0, 50);
  if (ranked.length > 0) {
    console.log('top unmapped terms:');
    for (const t of ranked) console.log(`  ${String(t.occurrences).padStart(5)}  ${t.term}`);
  }
}

main()
  .catch((err) => {
    console.error('skill taxonomy backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
