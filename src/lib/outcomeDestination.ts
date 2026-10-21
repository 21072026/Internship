// First destination (#1912) — client-safe. "Where did your participants end
// up six months later" is the report a university, a chamber or a publicly
// funded programme has to file. A pipeline stage says what OUR process did;
// this says what happened to the person.
//
// The instrument is the `outcome_destination` template (src/lib/surveyTemplates.ts),
// sent by an ordinary campaign with the DAYS_AFTER_END trigger. This file owns
// the codes, the survey input that instantiates it, and the aggregation; the
// rows are read in src/lib/outcomesData.ts.
//
// THREE RULES THE REPORT KEEPS
//   • Its knowledge rate stands next to it. A destination table without
//     "we know this for 41 of 60" is not a report.
//   • Only consented answers are counted. The question asked whether the
//     answer may appear in reports; a "no" is counted as `withheld` — a number,
//     never broken down.
//   • The response floor applies per bucket. A cohort with three answers shows
//     its knowledge rate and nothing else — three answers name three people.

import { getDictionary } from '@/i18n/dictionaries';
import { surveyInputFromTemplate } from '@/lib/surveyTemplateInput';
import { applyResponseFloor, SURVEY_MIN_RESPONSES } from '@/lib/surveyPrivacy';

export const OUTCOME_TEMPLATE_KEY = 'outcome_destination';

export const DESTINATIONS = ['EMPLOYED_HERE', 'EMPLOYED_ELSEWHERE', 'CONTINUING_STUDY', 'SEEKING', 'NOT_SEEKING', 'OTHER'] as const;
export type Destination = (typeof DESTINATIONS)[number];

export function isDestination(v: unknown): v is Destination {
  return typeof v === 'string' && (DESTINATIONS as readonly string[]).includes(v);
}

/** The days-after-end offsets offered; 90 unless the org picks another. */
export const OUTCOME_OFFSETS = [30, 90, 180] as const;
export const OUTCOME_DEFAULT_OFFSET = 90;

/** Destinations that count as "placed" in a headline rate. */
export const PLACED: readonly Destination[] = ['EMPLOYED_HERE', 'EMPLOYED_ELSEWHERE', 'CONTINUING_STUDY'];

/**
 * The `createSurvey` input for the destination instrument: every label in all
 * three languages and the choice values as codes, so the stored answer is
 * `EMPLOYED_ELSEWHERE` whatever language it was given in.
 */
export function outcomeSurveyInput() {
  // The generic instantiation (src/lib/surveyTemplateInput.ts), pinned to the
  // audience and the mode this report's rules depend on.
  return surveyInputFromTemplate(OUTCOME_TEMPLATE_KEY, { audience: 'MENTEE', anonymity: 'IDENTIFIED' })!;
}

/** The destination labels in one language, for a report. */
export function destinationLabels(locale: 'en' | 'tr' | 'de'): Record<Destination, string> {
  const o = getDictionary(locale).surveyTemplates.outcomeDestination.options;
  return {
    EMPLOYED_HERE: o.employedHere,
    EMPLOYED_ELSEWHERE: o.employedElsewhere,
    CONTINUING_STUDY: o.continuingStudy,
    SEEKING: o.seeking,
    NOT_SEEKING: o.notSeeking,
    OTHER: o.other,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** A participant whose relation completed in the period: the denominator. */
export interface EligibleParticipant {
  personId: string;
  cohort: string | null;
  source: string | null;
}

/** Their latest destination answer, if they gave one. */
export interface DestinationAnswer {
  destination: Destination;
  consent: boolean;
}

export interface OutcomeBucket {
  label: string | null;
  eligible: number;
  /** Consented answers — the ones the report may use. */
  known: number;
  /** Answered, but said no to reporting. Counted, never broken down. */
  withheld: number;
  /** known / eligible, 0..1; null with nobody eligible. */
  knowledgeRate: number | null;
  /** Counts per destination, or null below the response floor. */
  destinations: Record<Destination, number> | null;
  /** Share of `known` that is PLACED, or null below the floor. */
  placedRate: number | null;
}

export interface OutcomeSummary {
  floor: number;
  overall: OutcomeBucket;
  byCohort: OutcomeBucket[];
  bySource: OutcomeBucket[];
}

function bucket(label: string | null, people: EligibleParticipant[], answers: Map<string, DestinationAnswer>, floor: number): OutcomeBucket {
  const counts = Object.fromEntries(DESTINATIONS.map((d) => [d, 0])) as Record<Destination, number>;
  let known = 0;
  let withheld = 0;
  for (const p of people) {
    const a = answers.get(p.personId);
    if (!a) continue;
    if (!a.consent) {
      withheld++;
      continue;
    }
    known++;
    counts[a.destination]++;
  }
  const open = known >= floor;
  const placed = PLACED.reduce((n, d) => n + counts[d], 0);
  return {
    label,
    eligible: people.length,
    known,
    withheld,
    knowledgeRate: people.length > 0 ? known / people.length : null,
    destinations: open ? counts : null,
    placedRate: open && known > 0 ? placed / known : null,
  };
}

function groupBy(people: EligibleParticipant[], key: (p: EligibleParticipant) => string | null) {
  const groups = new Map<string | null, EligibleParticipant[]>();
  for (const p of people) {
    const k = key(p);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  // Largest first; the "none" bucket last, whatever its size.
  return [...groups.entries()].sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : b[1].length - a[1].length));
}

/** The whole report, from eligible people and their latest answers. Pure. */
export function summarizeOutcomes(people: EligibleParticipant[], answers: Map<string, DestinationAnswer>, floor = SURVEY_MIN_RESPONSES): OutcomeSummary {
  const f = Math.max(floor, SURVEY_MIN_RESPONSES);
  return {
    floor: f,
    overall: bucket(null, people, answers, f),
    byCohort: floorBreakdown(groupBy(people, (p) => p.cohort).map(([label, ps]) => bucket(label, ps, answers, f)), f),
    bySource: floorBreakdown(groupBy(people, (p) => p.source).map(([label, ps]) => bucket(label, ps, answers, f)), f),
  };
}

/**
 * The residual rule on a breakdown (#1906). Each bucket under the floor already
 * hides its destinations, but next to the published overall the hidden ones
 * TOGETHER come back by subtraction: overall − every shown cohort = the hidden
 * cohort's destinations. applyResponseFloor (src/lib/surveyPrivacy.ts) hides
 * the smallest shown buckets with them until the hidden ones add up to the
 * floor — the same rule every other breakdown in the survey engine uses. A
 * hidden bucket keeps its eligible/known/withheld counts and knowledge rate:
 * those say how much we know, never where anybody went.
 */
function floorBreakdown(buckets: OutcomeBucket[], floor: number): OutcomeBucket[] {
  const floored = applyResponseFloor(buckets.map((b, i) => ({ key: String(i), n: b.known })), floor);
  return buckets.map((b, i) => (floored[i].suppressed ? { ...b, destinations: null, placedRate: null } : b));
}

/** Read one stored response into a DestinationAnswer, or null if it does not parse. */
export function readDestinationAnswer(values: { questionKey: string; value: unknown }[]): DestinationAnswer | null {
  const destination = values.find((v) => v.questionKey === 'destination')?.value;
  const consent = values.find((v) => v.questionKey === 'consent')?.value;
  if (!isDestination(destination)) return null;
  return { destination, consent: consent === true };
}
