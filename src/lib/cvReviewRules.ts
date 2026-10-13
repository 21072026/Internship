// The scored CV review (#2050) — the pure half: the fixed sections, the band,
// normalising what the model returns, the deterministic "missing required
// skills" for tailoring, and reading a stored artefact back (including the
// prose feedback stored before this change). Client-safe, no provider, no
// database; unit-tested in scripts/test/cv-review-rules.test.mjs.
//
// THE SCORE IS ADVICE, NOT A GATE. It is a coaching number the mentee owns:
// nothing reads it to block a stage change or rank a candidate, and it lives
// only in the mentee's own AiArtifact — private unless they share it with
// their mentor (src/lib/ai/artifacts.ts). No company-facing screen reads it.

import { z } from 'zod';

/** Fixed and ordered, so two reviews are comparable and "section 3" means the same thing to mentor and mentee. */
export const CV_SECTIONS = ['contact_links', 'structure', 'impact', 'skills_evidence', 'education', 'language'] as const;
export type CvSectionKey = (typeof CV_SECTIONS)[number];

export const CV_BANDS = ['needs_work', 'nearly', 'ready'] as const;
export type CvBand = (typeof CV_BANDS)[number];

export type ChecklistStatus = 'ok' | 'missing' | 'weak';

export interface CvReview {
  score: number;
  band: CvBand;
  sections: { key: CvSectionKey; score: number; findings: string[] }[];
  checklist: { item: string; status: ChecklistStatus; howToFix: string }[];
  summary: string;
  /** Present when the review was tailored to a requisition. */
  tailoring: { requisitionId: string; title: string; missingSkills: string[]; wordingGaps: string[]; emphasis: string } | null;
}

/** The band follows the score — never the model's own label — so the same score always reads the same. */
export function bandFor(score: number): CvBand {
  if (score >= 75) return 'ready';
  if (score >= 50) return 'nearly';
  return 'needs_work';
}

const clampScore = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);
const strings = (v: unknown, max: number, len = 300) =>
  (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().slice(0, len)).slice(0, max);

/** What the model is asked for (the json_schema in src/lib/aiCvFeedback.ts) — loosely, so a partial answer still parses. */
export const CV_REVIEW_REPLY = z.object({
  score: z.number(),
  sections: z.array(z.object({ key: z.string(), score: z.number(), findings: z.array(z.string()) }).partial()),
  checklist: z.array(z.object({ item: z.string(), status: z.string(), how_to_fix: z.string() }).partial()),
  summary: z.string(),
  tailoring: z.object({ missing_skills: z.array(z.string()), wording_gaps: z.array(z.string()), emphasis: z.string() }).partial().nullable(),
}).partial();
export type CvReviewReply = z.infer<typeof CV_REVIEW_REPLY>;

/**
 * The review as stored and shown: every fixed section present, in order (a
 * section the model skipped reads as 0 with no findings), scores clamped,
 * the band derived from the overall score, lists capped. `requisition`, when
 * given, adds the tailoring block; `deterministicMissing` (skills the posting
 * requires that the CV text never mentions) is always included in it, so the
 * missing required skills are named even when the model forgets one.
 */
export function normalizeReview(
  reply: CvReviewReply,
  requisition?: { id: string; title: string; deterministicMissing: string[] } | null,
): CvReview {
  const byKey = new Map((reply.sections ?? []).map((s) => [String(s.key ?? ''), s]));
  const sections = CV_SECTIONS.map((key) => {
    const s = byKey.get(key);
    return { key, score: clampScore(s?.score), findings: strings(s?.findings, 5) };
  });
  const score = clampScore(reply.score);
  const checklist = (reply.checklist ?? [])
    .filter((c) => typeof c.item === 'string' && c.item.trim())
    .slice(0, 12)
    .map((c) => ({
      item: String(c.item).trim().slice(0, 200),
      status: (c.status === 'ok' || c.status === 'missing' ? c.status : 'weak') as ChecklistStatus,
      howToFix: String(c.how_to_fix ?? '').trim().slice(0, 300),
    }));
  let tailoring: CvReview['tailoring'] = null;
  if (requisition) {
    const fromModel = strings(reply.tailoring?.missing_skills, 15, 60);
    const seen = new Set<string>();
    const missingSkills = [...requisition.deterministicMissing, ...fromModel].filter((s) => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    tailoring = {
      requisitionId: requisition.id,
      title: requisition.title,
      missingSkills,
      wordingGaps: strings(reply.tailoring?.wording_gaps, 6),
      emphasis: String(reply.tailoring?.emphasis ?? '').trim().slice(0, 400),
    };
  }
  return { score, band: bandFor(score), sections, checklist, summary: String(reply.summary ?? '').trim().slice(0, 600), tailoring };
}

/** Skills the posting requires that the CV text never mentions (case- and accent-insensitive, whole words). */
export function missingRequiredSkills(required: unknown, cvText: string): string[] {
  const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // A sentence-final dot is punctuation, not part of the word ("…in Go."); a dot inside one is ("node.js").
  const text = ` ${fold(cvText).replace(/[^a-z0-9+#.]+/g, ' ').replace(/\.+(?=\s|$)/g, ' ')} `;
  return strings(required, 30, 60).filter((skill) => {
    const needle = fold(skill).replace(/[^a-z0-9+#.]+/g, ' ').trim();
    return needle !== '' && !text.includes(` ${needle} `);
  });
}

/** A stored artefact read back: a scored review, or the prose feedback stored before #2050. */
export type StoredCvFeedback = { kind: 'review'; review: CvReview } | { kind: 'prose'; text: string };

export function readStoredFeedback(content: string): StoredCvFeedback {
  try {
    const v = JSON.parse(content) as Partial<CvReview>;
    if (v && typeof v === 'object' && typeof v.score === 'number' && Array.isArray(v.sections)) return { kind: 'review', review: v as CvReview };
  } catch { /* prose */ }
  return { kind: 'prose', text: content };
}

/** The change since the previous scored review of the same target; null when there is nothing to compare. */
export function scoreDelta(current: number, previous: number | null | undefined): number | null {
  return typeof previous === 'number' ? current - previous : null;
}
