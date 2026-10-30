/**
 * The cohort pass as ONE plain async function (#1794): load both sides once,
 * score in memory, assign. It takes its loaders as an argument and imports no
 * Prisma, so the route wires the real ones (`cohortPassStore.ts`), the unit
 * test counts the calls — every loader runs at most once, whatever the size of
 * the intake: no query per mentee, none per pair — and the move onto the job
 * queue (#1668) is a change of caller, not of this function.
 *
 * The caps are checked BEFORE anything is scored: a pass over the ceiling
 * answers `too_large` rather than running into the request timeout and
 * truncating in silence.
 */

import type { MatchMentee, MatchMentor, ScoreContext } from './dimensions';
import type { MatchRuleSetInput } from './score';
import { COHORT_PASS_MAX_MENTEES, COHORT_PASS_MAX_MENTORS, runAssignment, type PassResult } from './assign';

export interface CohortPassLoaders<E extends MatchMentee, M extends MatchMentor> {
  /** The mentees in scope, by id, at most `limit` of them. */
  menteeIds(limit: number): Promise<string[]>;
  mentorCount(): Promise<number>;
  mentees(ids: readonly string[]): Promise<E[]>;
  mentors(): Promise<M[]>;
  skillIds(userIds: readonly string[]): Promise<Map<string, string[]>>;
  /** A pending mentorship request's preferences, per mentee that has one. */
  preferences(menteeIds: readonly string[]): Promise<Map<string, { preferredField: string | null; preferredLanguages: unknown }>>;
  skillGraphs(menteeSkillIds: ReadonlyMap<string, readonly string[]>): Promise<(menteeId: string) => ScoreContext['skillGraph']>;
  ruleSet(): Promise<MatchRuleSetInput>;
}

export type CohortPassOutcome =
  | { ok: true; result: PassResult; ruleSet: MatchRuleSetInput; durationMs: number }
  | { ok: false; code: 'too_large'; mentees: number; mentors: number; maxMentees: number; maxMentors: number };

export async function runCohortPass<E extends MatchMentee, M extends MatchMentor>(
  loaders: CohortPassLoaders<E, M>,
  opts: { now: Date; minScore?: number; clock?: () => number },
): Promise<CohortPassOutcome> {
  const clock = opts.clock ?? (() => performance.now());
  const started = clock();
  const [ids, mentorCount] = await Promise.all([loaders.menteeIds(COHORT_PASS_MAX_MENTEES + 1), loaders.mentorCount()]);
  if (ids.length > COHORT_PASS_MAX_MENTEES || mentorCount > COHORT_PASS_MAX_MENTORS) {
    return { ok: false, code: 'too_large', mentees: ids.length, mentors: mentorCount, maxMentees: COHORT_PASS_MAX_MENTEES, maxMentors: COHORT_PASS_MAX_MENTORS };
  }

  const [mentees, mentors, ruleSet, prefs] = await Promise.all([loaders.mentees(ids), loaders.mentors(), loaders.ruleSet(), loaders.preferences(ids)]);
  const skillIds = await loaders.skillIds([...mentees.map((m) => m.id), ...mentors.map((m) => m.id)]);
  const menteeSkills = new Map(mentees.map((m) => [m.id, skillIds.get(m.id) ?? []]));
  const graphFor = await loaders.skillGraphs(menteeSkills);

  const result = runAssignment({
    mentees: mentees.map((m) => ({
      ...m,
      skillIds: menteeSkills.get(m.id) ?? [],
      preferredField: prefs.get(m.id)?.preferredField ?? null,
      preferredLanguages: prefs.get(m.id)?.preferredLanguages ?? [],
    })),
    mentors: mentors.map((m) => ({ ...m, skillIds: skillIds.get(m.id) ?? [] })),
    ruleSet,
    // `now` is the round's, not the wall clock's: a re-run of the same round
    // on the same data scores time-dependent rules (timezone) identically.
    ctxFor: (mentee) => {
      const skillGraph = graphFor(mentee.id);
      return { now: opts.now, ...(skillGraph ? { skillGraph } : {}) };
    },
    minScore: opts.minScore,
  });
  return { ok: true, result, ruleSet, durationMs: Math.round(clock() - started) };
}
