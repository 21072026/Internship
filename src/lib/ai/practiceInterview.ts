// The practice interviewer (#2051). Server-only; the client, model and caps are
// callModel's (task `practice_interview`). Callers MUST go through runAiGated.
// Every piece of the mentee's typing — each answer, the transcript — and the
// role and requisition text enter the prompt fenced as untrusted data (#2026).

import { z } from 'zod';
import { callModel, safeParseModelJson } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import { REPORT_REPLY, RUBRIC, normalizeReport, transcriptText, type PracticeReport, type PracticeTurn } from '@/lib/practiceInterviewRules';

/** The interviewer's tone rules — asserted by scripts/test/practice-interview-rules.test.mjs. */
export const INTERVIEWER_RULES = [
  'You are a practice interviewer for a student or junior candidate. Be challenging but never hostile, mocking or discouraging.',
  'Never comment on, ask about or guess the candidate’s accent, appearance, name, age, gender, nationality, origin, religion, health or family.',
  'Never give legal, visa or immigration advice, and never estimate anyone’s chances based on who they are; if asked, say briefly that this practice is about the answers and redirect to the next question.',
  'Ask one question at a time, realistic for the role, mixing behavioural and role-specific questions, and build on what the candidate said.',
  'Reply in the language the candidate answers in (or the language of the role if they have not answered yet).',
].join(' ');

const TURN_REPLY = z.object({ observation: z.string(), question: z.string() }).partial();

export interface PracticeContext {
  role: string;
  skills: string[];
  requisitionText: string | null;
}

function contextBlocks(ctx: PracticeContext): string {
  return [
    `Role:\n${wrapUntrusted('role', ctx.role)}`,
    `The candidate's declared skills:\n${wrapUntrusted('skills', ctx.skills.join(', ') || '—')}`,
    ...(ctx.requisitionText ? [`The job posting:\n${wrapUntrusted('posting', ctx.requisitionText.slice(0, 4000))}`] : []),
  ].join('\n\n');
}

/** The next question, plus a one-line observation on the last answer (empty for the opening question). */
export async function practiceTurn(ctx: PracticeContext, turns: PracticeTurn[]): Promise<{ question: string; observation: string } | null> {
  const reply = await callModel({
    task: 'practice_interview',
    system: `${INTERVIEWER_RULES} Return ONLY JSON {"observation": "...", "question": "..."}: "observation" is one short, specific sentence on the candidate's last answer (empty if there is none yet); "question" is your next question.`,
    input: `${contextBlocks(ctx)}\n\nThe interview so far:\n${wrapUntrusted('transcript', transcriptText(turns) || '(not started)')}`,
    jsonSchema: { type: 'object', additionalProperties: false, properties: { observation: { type: 'string' }, question: { type: 'string' } }, required: ['observation', 'question'] },
    maxTokens: 400,
  });
  const p = safeParseModelJson(reply, TURN_REPLY, {});
  const question = String(p.question ?? '').trim();
  return question ? { question: question.slice(0, 600), observation: String(p.observation ?? '').trim().slice(0, 400) } : null;
}

/** The after-action report on the fixed rubric. */
export async function practiceReport(ctx: PracticeContext, turns: PracticeTurn[]): Promise<PracticeReport | null> {
  const reply = await callModel({
    task: 'practice_interview',
    system:
      `${INTERVIEWER_RULES} The interview is over. Write the after-action report for the candidate, in the language they answered in. ` +
      `Return ONLY JSON: "ratings" — each of ${RUBRIC.join(', ')} from 1 (weak) to 5 (strong); "went_well" — 2-4 specific things; ` +
      '"work_on" — exactly the two most useful things to practise next; "rewrite" — one of their answers rewritten to show the difference ({"question", "answer"}); "summary" — two encouraging, honest sentences. ' +
      'Base everything on what they actually said.',
    input: `${contextBlocks(ctx)}\n\nThe interview:\n${wrapUntrusted('transcript', transcriptText(turns))}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ratings: { type: 'object', additionalProperties: false, properties: Object.fromEntries(RUBRIC.map((k) => [k, { type: 'integer' }])), required: [...RUBRIC] },
        went_well: { type: 'array', items: { type: 'string' } },
        work_on: { type: 'array', items: { type: 'string' } },
        rewrite: { type: 'object', additionalProperties: false, properties: { question: { type: 'string' }, answer: { type: 'string' } }, required: ['question', 'answer'] },
        summary: { type: 'string' },
      },
      required: ['ratings', 'went_well', 'work_on', 'rewrite', 'summary'],
    },
  });
  const p = safeParseModelJson(reply, REPORT_REPLY, {});
  if (!p.ratings) return null;
  return normalizeReport(p, ctx.role);
}
