// Relationship health (#1898) — a published RULES TABLE, not a model.
//
// One pure function turns the signals the product already collects into a
// 0-100 score, a band and the named reasons behind it. Every rule carries its
// weight, its window and one sentence saying why it is there, because the
// number is only worth showing if the mentor it is about can be told *why*,
// an admin can argue with it, a works council can inspect it and a
// procurement questionnaire can be answered from it. Deterministic: the same
// input gives the same score, and nothing here is learned from anyone's data.
// docs/relationship-health.md is the human-readable copy of this table.
//
// TWO OUTPUTS PER RULE, ON PURPOSE:
//   • `points` (0..1, or null) feed the score. A rule with NO DATA returns
//     null and drops out of the denominator — a missing signal is not a bad
//     signal. Otherwise every new relationship reads red on day one and the
//     feature is discredited before anyone uses it.
//   • `flag` is the mentor attention queue's reason (src/lib/mentorAttention.ts
//     reads it from here), with exactly the semantics that queue has always
//     had — so the queue and the admin monitor can never disagree about what
//     is wrong, even where the score is more forgiving (a brand-new pair is
//     still flagged "no recent contact"; it just does not lose points yet).
//
// PURE: no Prisma, no settings read. The caller loads the signals (and
// `reminderDays`, which is a per-org setting, never a constant) and passes a
// plain struct, like findDormantFirstContacts' input.

import { addUtcWeeks, firstFullUtcWeek, utcWeekStart } from './week';

export const HEALTH_RULES_VERSION = 1;

const DAY = 24 * 60 * 60 * 1000;

/** The mentor attention queue's mentorship reasons — each one a rule's flag. */
export type HealthReason =
  | 'inactive'
  | 'overdue'
  | 'unanswered_question'
  | 'pending_meeting'
  | 'no_open_goal'
  | 'missing_weekly_reports'
  | 'stage_stalled';

export interface HealthInput {
  now: number;
  /** Org setting `reminderDays` — the same "stale" the weekly digest uses. */
  reminderDays: number;
  status: string;
  /** A dormant first contact (src/lib/dormantFirstContact.ts) is not scored. */
  dormant: boolean;
  startDate: Date;
  /** lib/lastContact.ts — interaction log, direct message, mentee's own group message. */
  lastContactAt: Date | null;
  stageDeadline: Date | null;
  unansweredQuestions: number;
  pendingMeetingRequests: number;
  /** An open Goal, or a to-do somebody else gave the mentee. */
  hasOpenWork: boolean;
  /** Present only while the relation is in the internship stage. */
  weeklyReports: { submittedWeekStarts: number[] } | null;
  /** The last StatusChange into the current stage, if any. */
  lastStageMoveAt: Date | null;
}

export interface RuleOutcome {
  /** 0..1, or null when the rule has no data for this relation yet. */
  points: number | null;
  /** The attention-queue reason this rule raises, if any. */
  flag?: HealthReason;
}

export interface HealthRule {
  key: string;
  /** Share of the score, before missing rules drop out. Weights sum to 100. */
  weight: number;
  /** The time window the rule looks at, in words. */
  window: string;
  /** Why the rule exists — one sentence, shown to admins and in the doc. */
  describe: string;
  evaluate(input: HealthInput): RuleOutcome;
}

const ageDays = (input: HealthInput) => (input.now - input.startDate.getTime()) / DAY;

/** Weekly reports are owed when the two last full weeks are both missing. */
export function missingWeeklyReports(startDate: Date, submittedWeekStarts: number[], now: number): boolean {
  const currentWeek = utcWeekStart(new Date(now));
  const firstEligibleWeek = firstFullUtcWeek(startDate);
  const lastWeek = addUtcWeeks(currentWeek, -1);
  const previousWeek = addUtcWeeks(currentWeek, -2);
  const submitted = new Set(submittedWeekStarts);
  return previousWeek >= firstEligibleWeek && !submitted.has(lastWeek.getTime()) && !submitted.has(previousWeek.getTime());
}

export const HEALTH_RULES: readonly HealthRule[] = [
  {
    key: 'recent_contact',
    weight: 25,
    window: 'reminderDays (org setting, default 14)',
    describe: 'A pair that has not been in touch within the reminder window is the strongest early sign a relationship is fading.',
    evaluate(input) {
      const stale = input.now - input.reminderDays * DAY;
      const flag = !input.lastContactAt || input.lastContactAt.getTime() < stale ? 'inactive' : undefined;
      // A pair younger than the window has not had time to be out of touch.
      if (!input.lastContactAt && ageDays(input) < input.reminderDays) return { points: null, flag };
      if (!input.lastContactAt) return { points: 0, flag };
      const since = input.now - input.lastContactAt.getTime();
      const points = since <= input.reminderDays * DAY ? 1 : since <= 2 * input.reminderDays * DAY ? 0.5 : 0;
      return { points, flag };
    },
  },
  {
    key: 'stage_deadline',
    weight: 15,
    window: 'the current stage deadline',
    describe: 'A stage deadline that has passed means the pipeline promise to the mentee is already broken.',
    evaluate(input) {
      if (!input.stageDeadline) return { points: null };
      return input.stageDeadline.getTime() < input.now ? { points: 0, flag: 'overdue' } : { points: 1 };
    },
  },
  {
    key: 'question_answered',
    weight: 10,
    window: 'open questions right now',
    describe: 'A mentee question left unanswered is the clearest signal the mentee is waiting on the mentor.',
    evaluate(input) {
      return input.unansweredQuestions > 0 ? { points: 0, flag: 'unanswered_question' } : { points: 1 };
    },
  },
  {
    key: 'meeting_request_answered',
    weight: 10,
    window: 'pending meeting requests right now',
    describe: 'A meeting the mentee asked for and nobody confirmed is a request ignored.',
    evaluate(input) {
      return input.pendingMeetingRequests > 0 ? { points: 0, flag: 'pending_meeting' } : { points: 1 };
    },
  },
  {
    key: 'open_work',
    weight: 10,
    window: 'open goals and assigned to-dos right now',
    describe: 'A pair with no open goal or to-do has nothing it is working towards.',
    evaluate(input) {
      const flag = input.hasOpenWork ? undefined : 'no_open_goal';
      // A brand-new pair is allowed its first reminder window to set one.
      if (!input.hasOpenWork && ageDays(input) < input.reminderDays) return { points: null, flag };
      return { points: input.hasOpenWork ? 1 : 0, flag };
    },
  },
  {
    key: 'weekly_reports',
    weight: 15,
    window: 'the last two full weeks, during the internship stage',
    describe: 'An intern who has stopped handing in weekly reports has usually stopped engaging with the programme.',
    evaluate(input) {
      if (!input.weeklyReports) return { points: null };
      return missingWeeklyReports(input.startDate, input.weeklyReports.submittedWeekStarts, input.now)
        ? { points: 0, flag: 'missing_weekly_reports' }
        : { points: 1 };
    },
  },
  {
    key: 'stage_movement',
    weight: 15,
    window: '60 days',
    describe: 'A relationship that has not moved stage in two months is stuck, even if the pair still talks.',
    evaluate(input) {
      // Younger than the window and never moved: there has not been time to get stuck.
      if (!input.lastStageMoveAt && ageDays(input) < 60) return { points: null };
      const since = input.lastStageMoveAt ?? input.startDate;
      return input.now - since.getTime() <= 60 * DAY ? { points: 1 } : { points: 0, flag: 'stage_stalled' };
    },
  },
];

export type HealthBand = 'HEALTHY' | 'WATCH' | 'AT_RISK';

/** Score thresholds, inclusive lower bounds. */
export const HEALTH_BANDS: readonly { band: HealthBand; min: number }[] = [
  { band: 'HEALTHY', min: 70 },
  { band: 'WATCH', min: 40 },
  { band: 'AT_RISK', min: 0 },
];

export interface Contribution {
  key: string;
  weight: number;
  /** Points earned out of `weight`, or null when the rule had no data. */
  points: number | null;
}

export type HealthAssessment =
  | {
      excluded: false;
      /** null only when no rule had data — a pair too new to judge. */
      score: number | null;
      band: HealthBand;
      reasons: HealthReason[];
      contributions: Contribution[];
      version: number;
    }
  | { excluded: true; why: 'dormant' | 'not_active'; version: number };

export function bandFor(score: number): HealthBand {
  return HEALTH_BANDS.find((b) => score >= b.min)!.band;
}

export function scoreRelation(input: HealthInput): HealthAssessment {
  // A dormant first contact is an applicant who never replied, not a dying
  // relationship; a completed or paused relation is not being worked on.
  if (input.dormant) return { excluded: true, why: 'dormant', version: HEALTH_RULES_VERSION };
  if (input.status !== 'ACTIVE') return { excluded: true, why: 'not_active', version: HEALTH_RULES_VERSION };

  const reasons: HealthReason[] = [];
  const contributions: Contribution[] = [];
  let earned = 0;
  let possible = 0;
  for (const rule of HEALTH_RULES) {
    const outcome = rule.evaluate(input);
    if (outcome.flag) reasons.push(outcome.flag);
    const points = outcome.points === null ? null : Math.round(rule.weight * outcome.points * 10) / 10;
    contributions.push({ key: rule.key, weight: rule.weight, points });
    if (outcome.points !== null) {
      earned += rule.weight * outcome.points;
      possible += rule.weight;
    }
  }
  const score = possible === 0 ? null : Math.round((100 * earned) / possible);
  return {
    excluded: false,
    score,
    band: score === null ? 'HEALTHY' : bandFor(score),
    reasons,
    contributions,
    version: HEALTH_RULES_VERSION,
  };
}
