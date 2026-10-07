// The scored CV review for mentees (#535, scored since #2050). Sends only the
// already-extracted CV TEXT (same rule as cvExtractAi) — and, when the mentee
// tailors it to a role, that requisition's title, skills and description,
// fenced as untrusted data like the CV itself (#2026: a job posting is
// user-authored content too). Returns a CvReview: an overall score, six
// fixed sections, a checklist with how to fix each item, and the tailoring.
// Callers MUST go through runAiGated (consent + quota); this module holds the
// prompt and the parser only — the client, model, timeout and input cap are
// callModel's (#2022, task `cv_feedback`).
//
// A reply that is not the JSON asked for falls back to null and is metered
// parse_error (#2024): the caller answers "not right now", nothing is stored.

import { callModel, safeParseModelJson } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import { CV_REVIEW_REPLY, CV_SECTIONS, normalizeReview, type CvReview, type CvReviewReply } from '@/lib/cvReviewRules';

const SECTION_GUIDE: Record<(typeof CV_SECTIONS)[number], string> = {
  contact_links: 'contact & links (reachable, professional profile links)',
  structure: 'structure (order, length, scannability, consistent dates)',
  impact: 'impact statements (outcomes and numbers, not duties)',
  skills_evidence: 'skills evidence (each claimed skill backed by a project or role)',
  education: 'education (degree, institution, dates, relevant coursework)',
  language: 'language quality (spelling, grammar, tone)',
};

const SYSTEM = `You review a student/junior CV for its owner and score it. Write every text field in the same language the CV is written in, addressed to the CV owner.
Return ONLY JSON matching the schema:
- "score": 0-100 overall readiness for applying.
- "sections": exactly these six keys, in this order, each with a 0-100 score and 1-4 short findings grounded in the actual CV: ${CV_SECTIONS.map((k) => `"${k}" = ${SECTION_GUIDE[k]}`).join('; ')}.
- "checklist": 4-10 concrete items, each with "status" ok | missing | weak and a one-sentence "how_to_fix" (empty for ok).
- "summary": two sentences, encouraging and specific.
- "tailoring": when a target role is given, the skills it requires that the CV does not show ("missing_skills"), wording that does not match the posting ("wording_gaps"), and what to emphasise ("emphasis"); otherwise null.
Never invent experience, employers, dates or skills. Score what is there.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'integer' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string', enum: [...CV_SECTIONS] }, score: { type: 'integer' }, findings: { type: 'array', items: { type: 'string' } } },
        required: ['key', 'score', 'findings'],
      },
    },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { item: { type: 'string' }, status: { type: 'string', enum: ['ok', 'missing', 'weak'] }, how_to_fix: { type: 'string' } },
        required: ['item', 'status', 'how_to_fix'],
      },
    },
    summary: { type: 'string' },
    tailoring: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: { missing_skills: { type: 'array', items: { type: 'string' } }, wording_gaps: { type: 'array', items: { type: 'string' } }, emphasis: { type: 'string' } },
          required: ['missing_skills', 'wording_gaps', 'emphasis'],
        },
      ],
    },
  },
  required: ['score', 'sections', 'checklist', 'summary', 'tailoring'],
} as const;

export interface TailoringTarget {
  id: string;
  title: string;
  description: string | null;
  requiredSkills: string[];
  /** Required skills the CV text never mentions — computed, not asked for. */
  deterministicMissing: string[];
}

export async function aiCvFeedback(text: string, target?: TailoringTarget | null): Promise<CvReview | null> {
  const role = target
    ? `\n\nThe role to tailor the review to:\n${wrapUntrusted('role', `Title: ${target.title}\nRequired skills: ${target.requiredSkills.join(', ') || '—'}\n${(target.description ?? '').slice(0, 4000)}`)}`
    : '\n\nNo target role: set "tailoring" to null.';
  const reply = await callModel({ task: 'cv_feedback', system: SYSTEM, input: `The CV to review:\n\n${wrapUntrusted('cv', text)}${role}`, jsonSchema: SCHEMA });
  const parsed = safeParseModelJson<CvReviewReply | null>(reply, CV_REVIEW_REPLY, null);
  if (!parsed || typeof parsed.score !== 'number') return null;
  return normalizeReview(parsed, target ? { id: target.id, title: target.title, deterministicMissing: target.deterministicMissing } : null);
}
