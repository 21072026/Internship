// The candidate write rules of /api/v1 (#1996), shared by POST /candidates and
// PATCH /candidates/{id}: the body schemas and the skill check. The schemas are
// `.strict()` on purpose — `role`, `orgId`, a password or anything else not
// listed is REFUSED with a 422 naming the key, never silently dropped, so an
// integration that thinks it can set them learns that it cannot.
import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { blockingSkillIssue, parseSkills } from '@/lib/skills';
import { apiError } from '@/lib/api/v1';

const profileFields = {
  fullName: z.string().trim().min(1).max(TEXT_LIMITS.userFullName),
  university: z.string().trim().max(TEXT_LIMITS.profileShortText).optional(),
  department: z.string().trim().max(TEXT_LIMITS.profileShortText).optional(),
  graduationYear: z.number().int().min(1950).max(2100).optional(),
  skills: z.array(z.string()).max(200).optional(),
};

export const createCandidateSchema = z
  .object({
    ...profileFields,
    email: z.string().trim().toLowerCase().email().max(TEXT_LIMITS.userEmail),
    // A name / phone / university look-alike is a 409 unless the caller says it
    // has checked; an e-mail already in use never is.
    allowPossibleDuplicate: z.boolean().optional(),
  })
  .strict();

export const updateCandidateSchema = z
  .object({ ...profileFields, fullName: profileFields.fullName.optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });

/** The parsed skill list, or the 422 that refuses it (the same limits a person editing their profile meets). */
export function checkSkills(skills: string[] | undefined): string[] | undefined | NextResponse {
  if (skills === undefined) return undefined;
  const parsed = parseSkills(skills);
  const blocking = blockingSkillIssue(parsed.issues);
  if (blocking) {
    return apiError(422, 'validation_failed', 'The request body is invalid', undefined, {
      errors: [{ path: 'skills', code: blocking.code, message: blocking.code === 'too_many' ? 'too many skills' : 'a skill is too long' }],
    });
  }
  return parsed.skills;
}
