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
import { skillOverlap, type SkillEdgeRow } from '@/lib/skillTaxonomyRule';
import { semanticAffinity } from './semantic';

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
  /**
   * Canonical skill ids (`UserSkill`, #1815). Read by the `skills` dimension
   * only when the caller also passes `ctx.skillGraph` (#1787) — then the
   * comparison is the taxonomy's adjacency-weighted `skillOverlap()` (#1821)
   * instead of the free-text one.
   */
  skillIds?: readonly string[];
  /**
   * The person's cached profile themes (`ProfileDigest.themes`, #2038), read
   * by the `semanticAffinity` dimension. Absent = no digest yet: the rule is
   * not applicable and adds the same 0 to everybody.
   */
  themes?: readonly string[];
  /**
   * Answers to the org's MATCHABLE admin-defined questions (#1803), field key
   * → value, loaded in bulk by ./customAnswers.ts. Read only by the
   * `customField:<key>` family.
   */
  customAnswers?: Readonly<Record<string, unknown>>;
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
  /**
   * The org's skill graph, loaded by the caller (#1787). Present = score the
   * `skills` dimension on canonical ids with adjacency, the same rule the
   * requisition alerts use (#1821); absent = the free-text comparison, so a
   * dry run or a preview without the graph scores exactly as before.
   */
  skillGraph?: { edges: readonly SkillEdgeRow[]; label?: (skillId: string) => string };
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
  // With ctx.skillGraph and a mentee who has canonical skills, the overlap is
  // `skillOverlap()` over ids: an exact skill counts 1, a neighbour its edge
  // weight, and the ratio is over the mentee's skills — `mode` is ignored, ids
  // need no folding. The detail names the neighbour and what it stands in for.
  skills: (mentee, mentor, config, ctx) => {
    const ids = [...new Set(mentee.skillIds ?? [])];
    if (ctx.skillGraph && ids.length > 0) {
      const label = ctx.skillGraph.label ?? ((id: string) => id);
      const o = skillOverlap(ids, mentor.skillIds ?? [], ctx.skillGraph.edges);
      const hits = o.direct.length + o.adjacent.length;
      return {
        matched: hits >= Math.max(1, num(config.minShared, 1)),
        ratio: clamp01(o.score / ids.length),
        detail: [...o.direct.map(label), ...o.adjacent.map((a) => `${label(a.skillId)} ≈ ${label(a.via)}`)],
      };
    }
    return overlap(
      asStringList(mentee.skills),
      asStringList(mentor.skills),
      config.mode === 'lowercase' ? lowercaseOnly : normalizeTerm,
      num(config.minShared, 1)
    );
  },

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

  // Soft only (#2038): the cached themes of both profiles, compared without a
  // provider call (src/lib/matching/semantic.ts). The detail names what they
  // share, and what met halfway ("platform engineering ≈ platform team").
  semanticAffinity: (mentee, mentor) => {
    if (!mentee.themes?.length || !mentor.themes?.length) return notApplicable('no profile digest');
    const a = semanticAffinity(mentee.themes, mentor.themes);
    return {
      matched: a.score > 0,
      ratio: a.score,
      detail: [...a.sharedThemes, ...a.relatedThemes.map((r) => `${r.theme} ≈ ${r.via}`)],
    };
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

/** The prefix of the admin-defined family: `customField:<fieldKey>` (#1803). */
export const CUSTOM_FIELD_PREFIX = 'customField:';
const CUSTOM_KEY_RE = /^customField:[a-z][a-z0-9_]{0,79}$/;

/** Is `key` a well-formed `customField:<fieldKey>` dimension? */
export function isCustomFieldDimension(key: string): boolean {
  return CUSTOM_KEY_RE.test(key);
}

/**
 * One admin-defined question compared between the two people who both
 * answered it. The answer's own shape picks the comparison — the write side
 * (validateResponse) guarantees a key's answers share one type:
 *   · a string or a boolean (SELECT, BOOLEAN) — exact match;
 *   · a list (MULTI_SELECT) — shared options over the MENTEE's list;
 *   · a number (NUMBER, SCALE) — closeness: matched within config.tolerance
 *     (default 0), ratio falling linearly to 0 at tolerance + 1 apart.
 * Either side unanswered = not applicable, the same 0 for every mentor.
 */
export function customFieldDimension(fieldKey: string, mentee: MatchMentee, mentor: MatchMentor, config: DimensionConfig): DimensionResult {
  const a = mentee.customAnswers?.[fieldKey];
  const b = mentor.customAnswers?.[fieldKey];
  const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (empty(a) || empty(b)) return notApplicable('not answered');
  if (typeof a === 'number' && typeof b === 'number') {
    const diff = Math.abs(a - b);
    const tolerance = Math.max(0, num(config.tolerance, 0));
    return { matched: diff <= tolerance, ratio: clamp01(1 - diff / (tolerance + 1)), detail: [`${a} / ${b}`] };
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const want = (Array.isArray(a) ? a : [a]).map(String);
    const have = new Set((Array.isArray(b) ? b : [b]).map(String));
    const shared = want.filter((v) => have.has(v));
    return { matched: shared.length > 0, ratio: clamp01(shared.length / want.length), detail: shared };
  }
  const same = String(a) === String(b);
  return { matched: same, ratio: same ? 1 : 0, detail: same ? [String(a)] : [] };
}

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
  if (isCustomFieldDimension(key)) return customFieldDimension(key.slice(CUSTOM_FIELD_PREFIX.length), mentee, mentor, config);
  if (!isKnownDimension(key)) return { matched: false, ratio: 0, detail: ['unknown dimension'] };
  return DIMENSIONS[key](mentee, mentor, config, ctx);
}
