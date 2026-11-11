// Who an announcement is for (#1721) — the ONE rule. Client-safe: no Prisma
// client, only its types.
//
// An audience is CRITERIA, never a list of people. The composer sends criteria;
// the server parses them here (unknown keys dropped, every list capped) and
// turns them into a `User` where-clause that is ALWAYS combined with the
// sending tenant and `isActive` by the caller — so an id from another tenant, or
// one that does not exist, simply matches nobody. A recipient id list in a
// request body has no field to land in.
//
// Semantics, stated once (the composer repeats them to the admin):
//   * Within one dimension the values are alternatives ("mentors OR mentees").
//   * Across dimensions they all apply ("mentors AND in programme X").
//   * Resolved AT SEND TIME: a scheduled announcement reaches whoever matches
//     when it goes out, not who matched when it was written.
//   * Programme / stage / company follow the person's ACTIVE mentorship: a
//     programme reaches its active pairs on both sides; a stage reaches the
//     mentees standing in it; a company reaches its own accounts and the
//     mentees placed with it.

import { z } from 'zod';
import type { Prisma } from '@prisma/client';

export const AUDIENCE_ROLES = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY'] as const;
export type AudienceRole = (typeof AUDIENCE_ROLES)[number];

const ids = z.array(z.string().min(1).max(64)).max(50);

const audienceSchema = z.object({
  roles: z.array(z.enum(AUDIENCE_ROLES)).max(AUDIENCE_ROLES.length).optional(),
  cohortIds: ids.optional(),
  stages: z.array(z.string().min(1).max(64)).max(50).optional(),
  companyIds: ids.optional(),
  tagIds: ids.optional(),
});

export type Audience = z.infer<typeof audienceSchema>;

/**
 * Parse stored or submitted criteria. Null when there is no restriction at all
 * (everyone) — including for malformed input, which therefore can never narrow
 * a broadcast into a surprise; the route refuses malformed input before that.
 */
export function parseAudience(input: unknown): Audience | null {
  if (input === null || input === undefined) return null;
  const parsed = audienceSchema.safeParse(input);
  if (!parsed.success) return null;
  const out: Audience = {};
  for (const [k, v] of Object.entries(parsed.data) as [keyof Audience, string[] | undefined][]) {
    const unique = [...new Set(v ?? [])];
    if (unique.length > 0) (out as Record<string, string[]>)[k] = unique;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Strict check for a request body: malformed criteria are a 400, not "everyone". */
export function isValidAudienceInput(input: unknown): boolean {
  return input === null || input === undefined || audienceSchema.safeParse(input).success;
}

const ACTIVE = 'ACTIVE' as const;

/** The criteria as a `User` where-clause. `{}` for everyone. */
export function audienceWhere(audience: Audience | null): Prisma.UserWhereInput {
  if (!audience) return {};
  const and: Prisma.UserWhereInput[] = [];
  if (audience.roles) and.push({ role: { in: [...audience.roles] } });
  if (audience.cohortIds) {
    const rel = { status: ACTIVE, cohortId: { in: audience.cohortIds } };
    and.push({ OR: [{ mentorRelations: { some: rel } }, { menteeRelations: { some: rel } }] });
  }
  if (audience.stages) {
    and.push({ menteeRelations: { some: { status: ACTIVE, pipelineStatus: { in: audience.stages } } } });
  }
  if (audience.companyIds) {
    and.push({
      OR: [{ companyId: { in: audience.companyIds } }, { menteeRelations: { some: { status: ACTIVE, companyId: { in: audience.companyIds } } } }],
    });
  }
  if (audience.tagIds) and.push({ tags: { some: { tagId: { in: audience.tagIds } } } });
  return and.length === 1 ? and[0] : { AND: and };
}
