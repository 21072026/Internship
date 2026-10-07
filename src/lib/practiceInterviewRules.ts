// Practice interview (#2051) — the pure half: the turn model, the bound on a
// session, the fixed rubric and normalising the after-action report. Client-
// safe, unit-tested in scripts/test/practice-interview-rules.test.mjs.
//
// TEXT ONLY: a turn is a question and a typed answer. Nothing here (or in the
// routes) captures audio or video.

import { z } from 'zod';

export const PRACTICE_MAX_TURNS = 6;
export const PRACTICE_ANSWER_MAX = 2_000;

export interface PracticeTurn {
  q: string;
  a?: string;
  /** The interviewer's one-line observation on the answer just given. */
  note?: string;
}

/** A stored `turns` column read back defensively. */
export function readTurns(value: unknown): PracticeTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as { q?: unknown }).q === 'string')
    .map((t) => ({
      q: String(t.q),
      ...(typeof t.a === 'string' ? { a: t.a } : {}),
      ...(typeof t.note === 'string' ? { note: t.note } : {}),
    }));
}

/** How many answers have been given. */
export const answered = (turns: PracticeTurn[]) => turns.filter((t) => typeof t.a === 'string').length;

/** The session ends after the answer that reaches the cap: then the report, not another question. */
export function isLastAnswer(turns: PracticeTurn[], maxTurns: number = PRACTICE_MAX_TURNS): boolean {
  return answered(turns) >= maxTurns;
}

/** The transcript as the model reads it — fenced by the caller (wrapUntrusted). */
export function transcriptText(turns: PracticeTurn[]): string {
  return turns.map((t, i) => `Q${i + 1}: ${t.q}${typeof t.a === 'string' ? `\nA${i + 1}: ${t.a}` : ''}`).join('\n\n');
}

/** Fixed and ordered, so two reports compare. */
export const RUBRIC = ['structure', 'evidence', 'relevance', 'clarity'] as const;
export type RubricKey = (typeof RUBRIC)[number];

export interface PracticeReport {
  role: string;
  ratings: Record<RubricKey, number>;
  wentWell: string[];
  workOn: string[];
  rewrite: { question: string; answer: string } | null;
  summary: string;
}

export const REPORT_REPLY = z.object({
  ratings: z.record(z.string(), z.number()),
  went_well: z.array(z.string()),
  work_on: z.array(z.string()),
  rewrite: z.object({ question: z.string(), answer: z.string() }).nullable(),
  summary: z.string(),
}).partial();

const clamp = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 1);
const list = (v: unknown, max: number) => (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().slice(0, 400)).slice(0, max);

/** Every rubric key rated 1-5, exactly two things to work on (fewer if the model gave fewer), lists capped. */
export function normalizeReport(reply: z.infer<typeof REPORT_REPLY>, role: string): PracticeReport {
  const r = reply.ratings ?? {};
  const rewrite = reply.rewrite && reply.rewrite.question?.trim() && reply.rewrite.answer?.trim()
    ? { question: reply.rewrite.question.trim().slice(0, 400), answer: reply.rewrite.answer.trim().slice(0, 1500) }
    : null;
  return {
    role,
    ratings: Object.fromEntries(RUBRIC.map((k) => [k, clamp(r[k])])) as Record<RubricKey, number>,
    wentWell: list(reply.went_well, 4),
    workOn: list(reply.work_on, 2),
    rewrite,
    summary: String(reply.summary ?? '').trim().slice(0, 600),
  };
}

/** A stored report read back; null when the content is not one. */
export function readReport(content: string): PracticeReport | null {
  try {
    const v = JSON.parse(content) as Partial<PracticeReport>;
    return v && typeof v === 'object' && v.ratings && Array.isArray(v.workOn) ? (v as PracticeReport) : null;
  } catch {
    return null;
  }
}
