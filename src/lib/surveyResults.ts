// A survey's results (#1910) — the reporting half of the survey engine. Every
// rule that keeps a small group from being read is applied HERE, before any
// number leaves the server:
//
//   • below the survey's response floor nothing is reported but the count —
//     no NPS, no distribution, no free text;
//   • the same floor per QUESTION (#1877): an optional question two people
//     answered is two people, however many answered the survey — it reports
//     its count and `suppressed: true`, nothing else;
//   • every breakdown (by respondent role, cohort, mentor) goes through
//     applyResponseFloor, residual suppression included (src/lib/surveyPrivacy.ts);
//   • cohort and mentor breakdowns exist only for surveys whose responses
//     carry a relation — an ANONYMOUS response carries none, by design;
//   • free-text answers are returned as an unattributed list, sorted by text,
//     never in submission order (which could be matched to a known time).
//
// Admin-only, enforced by the route. docs/surveys.md § Results.

import { prisma } from '@/lib/prisma';
import { applyResponseFloor, effectiveMinResponses } from '@/lib/surveyPrivacy';
import { pickLocalized } from '@/lib/surveySchema';
import { npsFromScores, npsTrend, isoWeek, type Nps, type NpsPoint, type NpsResult } from '@/lib/nps';

export interface DistributionBin {
  value: string;
  label: string;
  count: number;
}

export interface QuestionResult {
  key: string;
  type: string;
  label: string;
  answered: number;
  /** True when fewer than the floor answered THIS question: only `answered` is reported. */
  suppressed?: boolean;
  nps?: Nps;
  trend?: NpsPoint[];
  distribution?: DistributionBin[];
  mean?: number | null;
  texts?: string[];
}

/**
 * A floored breakdown as it leaves the server: the shown groups only. A hidden
 * group is not listed at all — not even by key, since "Mentor X: hidden"
 * already says Mentor X has fewer than the floor — and `hidden` only says that
 * some were held back. Keys are ids; `label` is what to print (two mentors
 * with one name stay two groups).
 */
export interface Breakdown {
  shown: { key: string; label: string; n: number; nps: NpsResult }[];
  hidden: boolean;
}

export interface SurveyResults {
  survey: { id: string; title: string; anonymity: string; status: string };
  floor: number;
  n: number;
  /** True when n is under the floor: only the counts below are reported. */
  suppressed: boolean;
  responseRate: { invited: number; responded: number; rate: number | null };
  questions: QuestionResult[];
  breakdowns: {
    role: Breakdown;
    cohort: Breakdown | null;
    mentor: Breakdown | null;
  } | null;
}

export async function loadSurveyResults(surveyId: string, locale: string): Promise<SurveyResults | null> {
  const survey = await prisma.survey.findUnique({
    where: { id: surveyId },
    select: {
      id: true,
      title: true,
      anonymity: true,
      status: true,
      minResponses: true,
      questions: { orderBy: { sortOrder: 'asc' }, select: { key: true, type: true, labels: true, options: true } },
    },
  });
  if (!survey) return null;
  const floor = effectiveMinResponses(survey.minResponses);

  const [responses, invited, responded] = await Promise.all([
    prisma.surveyResponse.findMany({
      where: { surveyId },
      select: { respondentRole: true, relationId: true, submittedAt: true, answers: { select: { questionKey: true, value: true, text: true } } },
    }),
    prisma.surveyInvitation.count({ where: { surveyId } }),
    prisma.surveyInvitation.count({ where: { surveyId, respondedAt: { not: null } } }),
  ]);
  const n = responses.length;
  const base: SurveyResults = {
    survey: { id: survey.id, title: pickLocalized(survey.title, locale), anonymity: survey.anonymity, status: survey.status },
    floor,
    n,
    suppressed: n < floor,
    // Below the floor the rate is not a rate (#1889): the same rule as the completion console.
    responseRate: { invited, responded, rate: invited > 0 && responded >= floor ? Math.round((responded / invited) * 100) : null },
    questions: survey.questions.map((q) => ({ key: q.key, type: q.type, label: pickLocalized(q.labels, locale), answered: 0 })),
    breakdowns: null,
  };
  if (base.suppressed) {
    // Only how many answered each question — no values, no text.
    for (const q of base.questions) q.answered = responses.filter((r) => r.answers.some((a) => a.questionKey === q.key)).length;
    return base;
  }

  const answersOf = (key: string) => responses.flatMap((r) => r.answers.filter((a) => a.questionKey === key).map((a) => ({ r, a })));
  for (const [i, q] of survey.questions.entries()) {
    const out = base.questions[i];
    const rows = answersOf(q.key);
    out.answered = rows.length;
    if (rows.length > 0 && rows.length < floor) {
      out.suppressed = true;
      continue;
    }
    const options = Array.isArray(q.options) ? (q.options as { value: string; labels: unknown }[]) : [];
    const optionLabel = (v: string) => pickLocalized(options.find((o) => o.value === v)?.labels, locale) || v;
    switch (q.type) {
      case 'NPS':
        out.nps = npsFromScores(rows.map(({ a }) => a.value), floor);
        out.trend = npsTrend(rows.map(({ r, a }) => ({ period: isoWeek(r.submittedAt), value: a.value })), floor);
        out.distribution = Array.from({ length: 11 }, (_, v) => ({ value: String(v), label: String(v), count: rows.filter(({ a }) => a.value === v).length }));
        break;
      case 'SCALE':
      case 'NUMBER': {
        const nums = rows.map(({ a }) => a.value).filter((v): v is number => typeof v === 'number');
        out.mean = nums.length ? Math.round((nums.reduce((x, y) => x + y, 0) / nums.length) * 10) / 10 : null;
        if (q.type === 'SCALE') out.distribution = [1, 2, 3, 4, 5].map((v) => ({ value: String(v), label: String(v), count: nums.filter((x) => x === v).length }));
        break;
      }
      case 'BOOLEAN':
        out.distribution = [true, false].map((v) => ({ value: String(v), label: String(v), count: rows.filter(({ a }) => a.value === v).length }));
        break;
      case 'SELECT':
      case 'MULTI_SELECT':
        out.distribution = options.map((o) => ({
          value: o.value,
          label: optionLabel(o.value),
          count: rows.filter(({ a }) => (Array.isArray(a.value) ? (a.value as unknown[]).includes(o.value) : a.value === o.value)).length,
        }));
        break;
      case 'TEXT':
      case 'LONG_TEXT':
        out.texts = rows
          .map(({ a }) => (a.text ?? (typeof a.value === 'string' ? a.value : '')).trim())
          .filter(Boolean)
          .sort((x, y) => x.localeCompare(y));
        break;
    }
  }

  // Breakdowns of the first NPS question — the number a sponsor asks for.
  const npsQuestion = survey.questions.find((q) => q.type === 'NPS');
  if (npsQuestion) {
    const scoreOf = (r: (typeof responses)[number]) => r.answers.find((a) => a.questionKey === npsQuestion.key)?.value;
    const groupBy = (keyOf: (r: (typeof responses)[number]) => { key: string; label: string } | null): Breakdown => {
      const groups = new Map<string, { label: string; scores: unknown[] }>();
      for (const r of responses) {
        const k = keyOf(r);
        if (!k) continue;
        const g = groups.get(k.key) ?? { label: k.label, scores: [] };
        g.scores.push(scoreOf(r));
        groups.set(k.key, g);
      }
      const floored = applyResponseFloor(
        [...groups.entries()].map(([key, g]) => ({ key, n: g.scores.length, data: { label: g.label, nps: npsFromScores(g.scores, floor) as Nps } })),
        floor,
      );
      const shown: Breakdown['shown'] = [];
      for (const b of floored) {
        if (!b.suppressed && b.data && !b.data.nps.suppressed) shown.push({ key: b.key, label: b.data.label, n: b.n, nps: b.data.nps });
      }
      return { shown, hidden: shown.length < floored.length };
    };

    let cohort: Breakdown | null = null;
    let mentor: Breakdown | null = null;
    const relationIds = [...new Set(responses.map((r) => r.relationId).filter((id): id is string => !!id))];
    if (relationIds.length > 0) {
      const relations = await prisma.mentorshipRelation.findMany({
        where: { id: { in: relationIds } },
        select: { id: true, cohort: { select: { id: true, name: true } }, mentor: { select: { id: true, fullName: true } } },
      });
      const byId = new Map(relations.map((r) => [r.id, r]));
      const relationOf = (r: (typeof responses)[number]) => (r.relationId ? byId.get(r.relationId) : undefined);
      cohort = groupBy((r) => {
        const c = relationOf(r)?.cohort;
        return c ? { key: c.id, label: c.name } : null;
      });
      mentor = groupBy((r) => {
        const m = relationOf(r)?.mentor;
        return m ? { key: m.id, label: m.fullName } : null;
      });
    }
    base.breakdowns = { role: groupBy((r) => ({ key: r.respondentRole, label: r.respondentRole })), cohort, mentor };
  }
  return base;
}
