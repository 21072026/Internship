// Meeting cadence and attendance figures (#2014) — pure, client-safe and
// unit-tested (scripts/test/meeting-cadence.test.mjs).
//
// DETERMINISTIC, ON PURPOSE. Every number here is counted arithmetic over
// meetings that happened, against a cadence the programme declared
// (MentorshipRelation.expectedMeetingIntervalWeeks). There is no model, no
// weighting and no prediction: the CTO review's line — "you do not have the
// volume for a model to beat a rules table… ship a deterministic health score
// and call it deterministic" — applies here too. Do not "improve" this into a
// forecast; a forecast is a different feature with a different name.
//
// What counts as MET: a pair meeting that was not cancelled, whose start has
// passed, and at which nobody was recorded NO_SHOW. An unrecorded meeting
// counts as attended — recording defaults to "everyone was there", and the
// recording step only marks the exception.

import { SURVEY_MIN_RESPONSES } from '@/lib/surveyPrivacy';

const DAY = 24 * 60 * 60 * 1000;
/** "Met recently" — the programme-level window. */
export const MET_WINDOW_DAYS = 30;
/** The no-show rate looks back this far. */
export const NO_SHOW_WINDOW_DAYS = 90;
/** Gaps between meetings are measured over this window. */
export const GAP_WINDOW_DAYS = 180;
/**
 * Below this many pairs (or meetings) a programme figure is suppressed rather
 * than published: the same floor the survey reporting uses, because a rate
 * over three pairs is three people.
 */
export const CADENCE_MIN_GROUP = SURVEY_MIN_RESPONSES;

export interface PairMeeting {
  relationId: string;
  at: Date;
  /** Somebody was recorded NO_SHOW. */
  noShow: boolean;
}

export interface RelationCadence {
  lastMetAt: Date | null;
  daysSinceLastMet: number | null;
  /** null when no cadence was promised — the pair is then never "off cadence". */
  onCadence: boolean | null;
}

const met = (m: PairMeeting, now: Date) => !m.noShow && m.at.getTime() <= now.getTime();

/** One pair: when it last met, and whether that is inside the promised interval. */
export function relationCadence(expectedIntervalWeeks: number | null, meetings: PairMeeting[], now: Date): RelationCadence {
  const times = meetings.filter((m) => met(m, now)).map((m) => m.at.getTime());
  const last = times.length ? Math.max(...times) : null;
  const daysSince = last === null ? null : Math.floor((now.getTime() - last) / DAY);
  const onCadence = expectedIntervalWeeks && expectedIntervalWeeks > 0 ? last !== null && now.getTime() - last <= expectedIntervalWeeks * 7 * DAY : null;
  return { lastMetAt: last === null ? null : new Date(last), daysSinceLastMet: daysSince, onCadence };
}

export interface Ratio {
  /** 0..100, rounded once; null when suppressed or nothing to divide by. */
  pct: number | null;
  /** How many the ratio is over — shown next to it. */
  basis: number;
}

export interface ProgrammeAttendance {
  activePairs: number;
  metRecently: Ratio;
  onCadence: Ratio;
  noShowRate: Ratio;
  medianDaysBetween: number | null;
}

const ratio = (part: number, whole: number): Ratio => ({ pct: whole >= CADENCE_MIN_GROUP ? Math.round((100 * part) / whole) : null, basis: whole });

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** The programme's figures over its active pairs. */
export function programmeAttendance(pairs: { relationId: string; expectedIntervalWeeks: number | null }[], meetings: PairMeeting[], now: Date): ProgrammeAttendance {
  const t = now.getTime();
  const byPair = new Map<string, PairMeeting[]>();
  for (const m of meetings) byPair.set(m.relationId, [...(byPair.get(m.relationId) ?? []), m]);
  const active = new Set(pairs.map((p) => p.relationId));

  const metRecently = pairs.filter((p) => (byPair.get(p.relationId) ?? []).some((m) => met(m, now) && t - m.at.getTime() <= MET_WINDOW_DAYS * DAY)).length;

  const promised = pairs.filter((p) => p.expectedIntervalWeeks && p.expectedIntervalWeeks > 0);
  const kept = promised.filter((p) => relationCadence(p.expectedIntervalWeeks, byPair.get(p.relationId) ?? [], now).onCadence).length;

  const recent = meetings.filter((m) => active.has(m.relationId) && m.at.getTime() <= t && t - m.at.getTime() <= NO_SHOW_WINDOW_DAYS * DAY);

  const gaps: number[] = [];
  for (const p of pairs) {
    const times = (byPair.get(p.relationId) ?? [])
      .filter((m) => met(m, now) && t - m.at.getTime() <= GAP_WINDOW_DAYS * DAY)
      .map((m) => m.at.getTime())
      .sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) gaps.push(Math.round((times[i] - times[i - 1]) / DAY));
  }

  return {
    activePairs: pairs.length,
    metRecently: ratio(metRecently, pairs.length),
    onCadence: ratio(kept, promised.length),
    noShowRate: ratio(recent.filter((m) => m.noShow).length, recent.length),
    medianDaysBetween: pairs.length >= CADENCE_MIN_GROUP ? median(gaps) : null,
  };
}
