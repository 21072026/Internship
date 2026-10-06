// The programme health scorecard (#1908) — pure and client-safe: the
// threshold table, the band rule and the next action per indicator. The counts
// are loaded by src/lib/programScorecardData.ts; this file only judges them,
// so the boundaries are unit-tested (scripts/test/program-scorecard.test.mjs)
// and the screen, the print report and the XLSX all read the same verdict.
//
// A scorecard whose thresholds nobody can defend is worse than none, so every
// number below carries the reason it is that number. Change one only together
// with its comment, and docs/program-scorecard.md.

export const SCORECARD_KEYS = [
  'activation',
  'matchRate',
  'timeToFirstMeeting',
  'meetingCadence',
  'stalledPairs',
  'atRisk',
  'evaluationCoverage',
  'surveyResponseRate',
  'nps',
] as const;
export type ScorecardKey = (typeof SCORECARD_KEYS)[number];

export type ScorecardBand = 'GREEN' | 'AMBER' | 'RED';
/** `score` is NPS: a signed number with no unit (−100..100). */
export type ScorecardUnit = 'percent' | 'days' | 'score';

interface Threshold {
  /** `higher`: a bigger value is better; `lower`: a smaller one is. */
  direction: 'higher' | 'lower';
  /** At or past this value the indicator is GREEN — the target shown on screen. */
  green: number;
  /** At or past this (but short of green) it is AMBER; beyond it RED. */
  amber: number;
  unit: ScorecardUnit;
}

/** Below this many items in the denominator a ratio is noise, not a verdict. */
export const MIN_TO_JUDGE = 5;

export const SCORECARD_THRESHOLDS: Record<Exclude<ScorecardKey, 'evaluationCoverage'>, Threshold> = {
  // Invitations with a known outcome (used, or expired unused) that were used.
  // 40 % is the signup funnel's own "the door looks broken" line
  // (LOW_VERIFICATION_RATE, src/lib/signupFunnel.ts) — below it something is
  // wrong with the invitation itself, not with the people. 60 % is where a
  // personal invitation from a programme someone applied to should land.
  activation: { direction: 'higher', green: 60, amber: 40, unit: 'percent' },
  // Active mentee accounts with an active mentor. A programme exists to pair
  // people: one in five waiting is the most a coordinator should tolerate,
  // two in five waiting means intake is outrunning mentor capacity.
  matchRate: { direction: 'higher', green: 80, amber: 60, unit: 'percent' },
  // Median days from the start of a relationship to its first meeting. 14 is
  // the default `reminderDays` — the same "out of touch" window the health
  // rules and the reminder mails use — and 28 is twice it, where the health
  // table's contact rule drops to zero points.
  timeToFirstMeeting: { direction: 'lower', green: 14, amber: 28, unit: 'days' },
  // Active relationships older than 30 days with a meeting in the last 30.
  // A monthly meeting is the minimum cadence a mentoring relationship is
  // sold on; most should keep it (70 %), and under half means the cadence is
  // the exception, not the rule.
  meetingCadence: { direction: 'higher', green: 70, amber: 50, unit: 'percent' },
  // Active relationships older than 60 days with no stage change in 60 days —
  // the health table's `stage_movement` rule. A few slow journeys are normal
  // (10 %); a quarter stuck is a pipeline problem, not a people problem.
  stalledPairs: { direction: 'lower', green: 10, amber: 25, unit: 'percent' },
  // Active relationships in the AT_RISK band of the published health rules
  // (#1898). One in ten needing a rescue is a normal load for a coordinator;
  // one in five is more than one person can work through in a week.
  atRisk: { direction: 'lower', green: 10, amber: 20, unit: 'percent' },
  // Survey invitations sent 7-90 days ago that were answered (#1910) — 7 days
  // so both reminders (day 3, day 7, src/lib/surveyReminders.ts) have had
  // their chance. Under 30 % the answers stop speaking for the cohort; half is
  // what a programme people chose to join, asking twice, should reach.
  surveyResponseRate: { direction: 'higher', green: 50, amber: 30, unit: 'percent' },
  // Net Promoter Score of the last 90 days (#1910), −100..100. Above 0 there
  // are more promoters than detractors — below it the programme is talked
  // down more than up. 30 is the usual "good" line for education and
  // professional services; a number above it is worth putting in a deck.
  nps: { direction: 'higher', green: 30, amber: 0, unit: 'score' },
};

/** Indicators that cannot be measured yet, and the work that makes them measurable. */
export const NOT_YET_MEASURABLE: Partial<Record<ScorecardKey, number[]>> = {
  // Needs stage-triggered evaluation due dates — without a due date there is
  // no "outstanding", only "not written", which is not the same thing.
  evaluationCoverage: [1891],
};

export function bandFor(key: keyof typeof SCORECARD_THRESHOLDS, value: number): ScorecardBand {
  const t = SCORECARD_THRESHOLDS[key];
  if (t.direction === 'higher') return value >= t.green ? 'GREEN' : value >= t.amber ? 'AMBER' : 'RED';
  return value <= t.green ? 'GREEN' : value <= t.amber ? 'AMBER' : 'RED';
}

/** Where each indicator's problem is fixed — a destination, never advice. */
export const SCORECARD_ACTIONS: Record<keyof typeof SCORECARD_THRESHOLDS, string> = {
  activation: '/admin/invite',
  matchRate: '/admin/mentorship',
  timeToFirstMeeting: '/admin/meetings',
  meetingCadence: '/admin/meetings',
  stalledPairs: '/admin/health',
  atRisk: '/admin/health?band=AT_RISK',
  surveyResponseRate: '/admin/surveys',
  nps: '/admin/surveys',
};

export interface ScorecardMetric {
  /** The value, or null when nothing could be counted. */
  value: number | null;
  /** How many items the value is computed over — the "N" behind a ratio. */
  basis: number;
}

export type ScorecardRow =
  | {
      key: ScorecardKey;
      status: 'ok';
      value: number;
      basis: number;
      unit: Threshold['unit'];
      band: ScorecardBand;
      target: number;
      direction: Threshold['direction'];
      /** Only for an AMBER or RED row. */
      nextAction: string | null;
    }
  | { key: ScorecardKey; status: 'insufficient'; basis: number; unit: Threshold['unit']; target: number; direction: Threshold['direction'] }
  | { key: ScorecardKey; status: 'not_measurable'; dependsOn: number[] };

/** Judge the loaded metrics. Order is SCORECARD_KEYS. */
export function buildScorecard(metrics: Partial<Record<keyof typeof SCORECARD_THRESHOLDS, ScorecardMetric>>): ScorecardRow[] {
  return SCORECARD_KEYS.map((key): ScorecardRow => {
    const pending = NOT_YET_MEASURABLE[key];
    if (pending || !(key in SCORECARD_THRESHOLDS)) return { key, status: 'not_measurable', dependsOn: pending ?? [] };
    const k = key as keyof typeof SCORECARD_THRESHOLDS;
    const t = SCORECARD_THRESHOLDS[k];
    const m = metrics[k];
    if (!m || m.value === null || m.basis < MIN_TO_JUDGE) {
      return { key, status: 'insufficient', basis: m?.basis ?? 0, unit: t.unit, target: t.green, direction: t.direction };
    }
    const band = bandFor(k, m.value);
    return {
      key,
      status: 'ok',
      value: m.value,
      basis: m.basis,
      unit: t.unit,
      band,
      target: t.green,
      direction: t.direction,
      nextAction: band === 'GREEN' ? null : SCORECARD_ACTIONS[k],
    };
  });
}

/** 100 × part ÷ whole, rounded once; null with nothing to divide by. */
export function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((100 * part) / whole) : null;
}

/** The median of whole numbers, rounded half up; null for an empty list. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
