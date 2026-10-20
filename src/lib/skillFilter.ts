// "People who have skill X" as a database `where` (#1820, epic #1810).
//
// The three people searches — the mentor directory, the admin candidate list
// and the company talent pool — used to load the whole visible set and filter
// `User.skills` in JavaScript, because a JSON array cannot be matched with a
// Prisma `where`. The mentor directory additionally capped that scan, so a
// mentor sorting past the cap did not exist for the search. This module turns
// one typed term into a `UserWhereInput`, so the count and the page come from
// the same SQL and nothing is truncated.
//
// A term matches a person when EITHER
//   - one of their canonical skills (`UserSkill` → `Skill`, #1815) carries the
//     term in a label (any locale) or in an alias — so "react.js" finds the
//     people whose free text said "ReactJS", once both resolve to React; OR
//   - their free-text `User.skills` contains it, case-insensitively — what the
//     JavaScript filter did, kept so a term nobody has curated yet (it is in the
//     #1819 review queue) and a half-typed prefix ("docke") still find people.
// The free-text half is a pre-query for ids (`LIKE` over the JSON's text), not
// a scan into Node: MySQL does the matching, only ids come back, and the outer
// query keeps every other condition — visibility, consent, tenant — as before.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { skillKey } from '@/lib/skills';

/** Longest term a search box may send; matches the old routes' trimming. */
export const MAX_SKILL_TERM_LENGTH = 60;

/** Escape LIKE's wildcards so a typed "%" or "_" matches itself. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The `where` for ONE typed term. `orgId` narrows the free-text pre-query; the
 * caller's own `where` still carries the tenant condition that decides.
 */
export async function skillTermWhere(orgId: string | null | undefined, rawTerm: string): Promise<Prisma.UserWhereInput> {
  const term = rawTerm.trim().slice(0, MAX_SKILL_TERM_LENGTH);
  if (!term) return {};
  const folded = skillKey(term);
  const pattern = `%${escapeLike(term.toLowerCase())}%`;

  const orgClause = orgId ? Prisma.sql`orgId = ${orgId} AND` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM \`User\` WHERE ${orgClause} LOWER(CAST(skills AS CHAR)) LIKE ${pattern}`,
  );

  const canonical: Prisma.UserWhereInput = {
    skillRows: {
      some: {
        skill: {
          ...(orgId ? { orgId } : {}),
          OR: [
            { labelEn: { contains: term } },
            { labelTr: { contains: term } },
            { labelDe: { contains: term } },
            ...(folded ? [{ aliases: { some: { key: { contains: folded } } } }] : []),
          ],
        },
      },
    },
  };
  return rows.length > 0 ? { OR: [{ id: { in: rows.map((r) => r.id) } }, canonical] } : canonical;
}

/** Every term must match (AND), as the candidate list's comma-separated filter always did. */
export async function skillTermsWhere(
  orgId: string | null | undefined,
  terms: readonly string[],
): Promise<Prisma.UserWhereInput> {
  const parts = await Promise.all(terms.filter((t) => t.trim()).map((t) => skillTermWhere(orgId, t)));
  return parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { AND: parts };
}
