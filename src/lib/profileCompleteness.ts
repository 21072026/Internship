/**
 * Profile completeness — the one rule behind the meter on /portal and
 * /portal/profile.
 *
 * Deliberately LIGHT gamification (no points, no badges, no streaks, nothing
 * that compares one person with another — docs/research/competitive-analysis-2026-08.md
 * §4.5 keeps those a non-goal). The meter only says how much of the profile
 * that matching and the people reading it actually use is filled in, and which
 * of those fields are still empty. It never rewards *activity*: the billing
 * meter counts relations with logged activity (docs/metering.md), so anything
 * that nudged people to log more would inflate a customer's bill.
 *
 * Which fields count, and why (each is read somewhere real):
 *   skills         — the skill overlap in /api/admin/mentor-suggest, the AI
 *                    ranking payload (src/lib/aiMentorMatch.ts) and the
 *                    company talent-pool skill filter.
 *   targetPosition — sent to the AI ranking; searched in the talent pool.
 *   cv             — what a mentor or company opens first; feeds the CV
 *                    suggestions on the profile page.
 *   university     — a matching dimension (src/lib/matching/types.ts);
 *                    searched in the talent pool.
 *   department     — the field/department matching dimensions; talent pool.
 *   interests      — sent to the AI ranking next to the skills.
 *   city           — the city matching dimension; talent pool search.
 *   graduationYear — shown on every talent-pool card.
 *   bio            — the first thing on the public profile (/p/[id]).
 * Timezone is a matching dimension too but is left out: the form always
 * submits one (it falls back to a default), so it would read as "done" for
 * everybody and say nothing.
 *
 * The weights sum to exactly 100, so the percentage is an integer sum and
 * needs no rounding. The order of `PROFILE_FIELDS` is the order the missing
 * items are listed in: heaviest first, ties in a fixed order — deterministic.
 *
 * Dependency-free on purpose: imported by a server page, a client component
 * and `node --test` (scripts/test/profile-completeness.test.mjs), which cannot
 * resolve this repo's extensionless imports.
 */

export const PROFILE_FIELDS = [
  { key: 'skills', weight: 25 },
  { key: 'targetPosition', weight: 15 },
  { key: 'cv', weight: 15 },
  { key: 'university', weight: 10 },
  { key: 'department', weight: 10 },
  { key: 'interests', weight: 10 },
  { key: 'city', weight: 5 },
  { key: 'graduationYear', weight: 5 },
  { key: 'bio', weight: 5 },
] as const;

export type ProfileFieldKey = (typeof PROFILE_FIELDS)[number]['key'];

/** The subset of a User row the rule reads. Every field may be absent. */
export interface ProfileCompletenessInput {
  skills?: unknown;
  targetPosition?: string | null;
  cvUrl?: string | null;
  university?: string | null;
  department?: string | null;
  interests?: string | null;
  city?: string | null;
  graduationYear?: number | null;
  bio?: string | null;
}

export interface ProfileCompleteness {
  /** 0-100, the sum of the weights of the filled fields. */
  percent: number;
  /** Empty fields, heaviest first. Empty array ⇔ percent === 100. */
  missing: ProfileFieldKey[];
}

function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFieldFilled(key: ProfileFieldKey, p: ProfileCompletenessInput): boolean {
  switch (key) {
    case 'skills':
      // `skills` is a JSON column: anything but an array with a real entry is empty.
      return Array.isArray(p.skills) && p.skills.some(filled);
    case 'cv':
      return filled(p.cvUrl);
    case 'graduationYear':
      return typeof p.graduationYear === 'number' && Number.isFinite(p.graduationYear) && p.graduationYear > 0;
    default:
      return filled(p[key]);
  }
}

export function profileCompleteness(profile: ProfileCompletenessInput | null | undefined): ProfileCompleteness {
  const p = profile ?? {};
  let percent = 0;
  const missing: ProfileFieldKey[] = [];
  for (const field of PROFILE_FIELDS) {
    if (isFieldFilled(field.key, p)) percent += field.weight;
    else missing.push(field.key);
  }
  return { percent, missing };
}

/**
 * The element id on /portal/profile each checklist item jumps to. One place,
 * so the anchors in ProfileForm and the links on the meter cannot drift.
 */
export const PROFILE_FIELD_ANCHOR_PREFIX = 'profile-field-';

export function profileFieldAnchor(key: ProfileFieldKey): string {
  return `${PROFILE_FIELD_ANCHOR_PREFIX}${key}`;
}

/**
 * Pick exactly the fields the rule reads out of a persisted User row (the
 * `/api/profile` GET and PUT both answer with one). The profile page builds
 * its meter from this — the saved row, never the submitted form values.
 */
export function completenessSnapshot(user: Record<string, unknown> | null | undefined): ProfileCompletenessInput {
  const u = user ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    skills: u.skills,
    targetPosition: str(u.targetPosition),
    cvUrl: str(u.cvUrl),
    university: str(u.university),
    department: str(u.department),
    interests: str(u.interests),
    city: str(u.city),
    graduationYear: typeof u.graduationYear === 'number' ? u.graduationYear : null,
    bio: str(u.bio),
  };
}
