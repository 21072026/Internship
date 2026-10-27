/**
 * The registry of scoreable matching dimensions (#1781). CLIENT-SAFE: no
 * Prisma, no server imports — the same functions score on the server and in a
 * browser preview of a rule set.
 *
 * Every dimension is a pure `(mentee, mentor, config, ctx) => DimensionResult`.
 * `matched` is the yes/no a hard rule reads, `ratio` (0-1) is what a weighted
 * rule multiplies its weight by, `detail` is the evidence a person reads.
 * `applicable: false` means one side has nothing to compare (a mentee with no
 * language preference): a hard rule then passes and a weighted rule adds 0 —
 * the same 0 for every mentor, so it cannot reorder anybody.
 */

import { getMentorAvailability } from '@/lib/mentorAvailability';
import { isValidTimeZone, offsetAt } from '@/lib/timezone';
import { MATCH_DIMENSIONS, type MatchDimension } from './types';
import { asStringList, lowercaseOnly, normalizeTerm, termMap, tokens } from './normalize';

/** What every person on either side of a match may carry. All optional. */
export interface MatchPerson {
  id: string;
  /** `User.skills` — a mentor's expertise lives here too (#427). */
  skills?: unknown;
  languages?: unknown;
  department?: string | null;
  university?: string | null;
  city?: string | null;
  timezone?: string | null;
  interests?: string | null;
  targetPosition?: string | null;
  managerId?: string | null;
}

export interface MatchMentee extends MatchPerson {
  /** From the mentee's MentorshipRequest (#939), when there is one. */
  preferredField?: string | null;
  preferredLanguages?: unknown;
  /** Every mentor this mentee has had a MentorshipRelation with, any status. */
  pastMentorIds?: readonly string[];
}

export interface MatchMentor extends MatchPerson {
  mentorCapacity?: number | null;
  activeMenteeCount: number;
  acceptingMentees?: boolean | null;
  /** #1808: how many mentees may pick this mentor themselves; read only by a self-select round. */
  selfMatchLimit?: number | null;
  /** #1808: self-selected seats currently held (countSelfSelected). */
  selfSelectedCount?: number;
}

export interface DimensionResult {
  matched: boolean;
  ratio: number;
  detail: string[];
  applicable?: boolean;
}

export interface ScoreContext {
  /** The instant zone offsets are read at. Fixed by the caller for determinism. */
  now: Date;
}

export type DimensionConfig = Record<string, unknown>;

export type DimensionFn = (
  mentee: MatchMentee,
  mentor: MatchMentor,
  config: DimensionConfig,
  ctx: ScoreContext
) => DimensionResult;

const notApplicable = (why: string): DimensionResult => ({ matched: false, ratio: 0, detail: [why], applicable: false });
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Shared terms between two lists; ratio is over the MENTEE's list. */
function overlap(menteeList: string[], mentorList: string[], fold: (s: string) => string, minShared: number): DimensionResult {
  const want = termMap(menteeList, fold);
  if (want.size === 0) return notApplicable('mentee lists none');
  const have = termMap(mentorList, fold);
  const shared = Array.from(want.keys()).filter((k) => have.has(k)).map((k) => want.get(k) as string);
  return { matched: shared.length >= Math.max(1, minShared), ratio: clamp01(shared.length / want.size), detail: shared };
}

/** Exact equality of one normalised field; missing on either side = not applicable. */
function sameValue(a: string | null | undefined, b: string | null | undefined): DimensionResult {
  const [x, y] = [normalizeTerm(a ?? ''), normalizeTerm(b ?? '')];
  if (!x || !y) return notApplicable('not set');
  return x === y ? { matched: true, ratio: 1, detail: [(a ?? '').trim()] } : { matched: false, ratio: 0, detail: [] };
}

export const DIMENSIONS: Readonly<Record<MatchDimension, DimensionFn>> = {
  // config.mode: 'normalized' (default — aliases, accents, punctuation) or
  // 'lowercase' (the pre-#1781 comparison, used by DEFAULT_RULE_SET).
  // config.minShared: how many shared skills count as a match (default 1).
  skills: (mentee, mentor, config) =>
    overlap(
      asStringList(mentee.skills),
      asStringList(mentor.skills),
      config.mode === 'lowercase' ? lowercaseOnly : normalizeTerm,
      num(config.minShared, 1)
    ),

  // The request's preferred languages win over the profile's spoken ones.
  language: (mentee, mentor) => {
    const preferred = asStringList(mentee.preferredLanguages);
    return overlap(preferred.length ? preferred : asStringList(mentee.languages), asStringList(mentor.languages), normalizeTerm, 1);
  },

  // The field the mentee asked for (or, without a request, the role they aim
  // at) against what the mentor knows: skills plus free-text interests.
  field: (mentee, mentor) => {
    const want = tokens(mentee.preferredField || mentee.targetPosition);
    if (want.length === 0) return notApplicable('no field given');
    const have = new Set([...asStringList(mentor.skills).flatMap((s) => tokens(s)), ...tokens(mentor.interests)]);
    const shared = want.filter((w) => have.has(w));
    return { matched: shared.length > 0, ratio: clamp01(shared.length / want.length), detail: shared };
  },

  department: (mentee, mentor) => sameValue(mentee.department, mentor.department),
  university: (mentee, mentor) => sameValue(mentee.university, mentor.university),
  city: (mentee, mentor) => sameValue(mentee.city, mentor.city),

  // config.maxHours (default 3): the widest gap that still counts as a match.
  // The ratio falls linearly to 0 at 12 hours apart.
  timezone: (mentee, mentor, config, ctx) => {
    if (!isValidTimeZone(mentee.timezone) || !isValidTimeZone(mentor.timezone)) return notApplicable('zone not set');
    const hours = Math.abs(offsetAt(ctx.now, mentee.timezone) - offsetAt(ctx.now, mentor.timezone)) / 3_600_000;
    return { matched: hours <= num(config.maxHours, 3), ratio: clamp01(1 - hours / 12), detail: [`${hours}h`] };
  },

  // Consumes getMentorAvailability (#941) rather than re-deriving it.
  // config.honourPreference (default false): also refuse a mentor who switched
  // acceptingMentees off. Off by default because the pre-#1781 ranking only
  // looked at the headcount ceiling.
  // config.selfSelect (default false, #1808): the round is a self-selection,
  // so a mentor at their selfMatchLimit does not match; an admin-led round
  // (the default) still ranks them.
  capacityHeadroom: (_mentee, mentor, config) => {
    const availability = getMentorAvailability({
      mentorCapacity: mentor.mentorCapacity,
      activeMenteeCount: mentor.activeMenteeCount,
      acceptingMentees: config.honourPreference === true ? mentor.acceptingMentees : undefined,
      selfMatchLimit: mentor.selfMatchLimit,
      selfSelectedCount: mentor.selfSelectedCount ?? 0,
      context: config.selfSelect === true ? 'self_select' : 'admin',
    });
    const cap = mentor.mentorCapacity;
    const ratio = cap == null ? 1 : cap <= 0 ? 0 : clamp01((cap - mentor.activeMenteeCount) / cap);
    const detail = [cap == null ? `${mentor.activeMenteeCount} active` : `${mentor.activeMenteeCount}/${cap}`];
    return { matched: availability.status === 'available', ratio, detail: availability.status === 'available' ? detail : [...detail, availability.status] };
  },

  // Meant as HARD_EXCLUDE: matched means "one manages the other".
  managerExclusion: (mentee, mentor) => {
    const hit = (mentee.managerId != null && mentee.managerId === mentor.id) || (mentor.managerId != null && mentor.managerId === mentee.id);
    return { matched: hit, ratio: hit ? 1 : 0, detail: hit ? ['direct manager'] : [] };
  },

  // Meant as HARD_EXCLUDE: matched means "these two were paired before".
  previousPairing: (mentee, mentor) => {
    const hit = (mentee.pastMentorIds ?? []).includes(mentor.id);
    return { matched: hit, ratio: hit ? 1 : 0, detail: hit ? ['paired before'] : [] };
  },
};

export function isKnownDimension(key: string): key is MatchDimension {
  return (MATCH_DIMENSIONS as readonly string[]).includes(key);
}

/** Evaluate one dimension. An unknown key is a non-match, never a silent pass. */
export function evaluateDimension(
  key: string,
  mentee: MatchMentee,
  mentor: MatchMentor,
  config: DimensionConfig,
  ctx: ScoreContext
): DimensionResult {
  if (!isKnownDimension(key)) return { matched: false, ratio: 0, detail: ['unknown dimension'] };
  return DIMENSIONS[key](mentee, mentor, config, ctx);
}
