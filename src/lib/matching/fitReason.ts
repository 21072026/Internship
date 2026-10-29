/**
 * The written half of the requisition fit (#2042): a sentence a COMPANY reads
 * beside an applicant, and the anonymous payload an AI may turn into a better
 * one. PURE — no Prisma, no provider — so both are unit-tested.
 *
 * WHAT A COMPANY GETS, AND WHAT IT NEVER DOES:
 *   · a sentence, never the number. The score, the weights and the breakdown
 *     are the operator's (admin) view; a company reads why, in words.
 *   · nothing about the programme's internals: the stage dimension (how far
 *     along the programme a candidate is) is left out of both the sentence and
 *     the payload, because it is the programme's record of a person, not a
 *     job-related fact the company supplied.
 *
 * THE AI PAYLOAD IS ANONYMOUS BY CONSTRUCTION: `buildFitReasonPayload` reads
 * ONLY the deterministic breakdown (skill ids → labels, booleans) and the
 * role's own title and skills. It never receives a candidate object, so an id,
 * a name, an e-mail, a photo or a protected characteristic cannot reach it —
 * the unit test hands it all of those and asserts none comes out. Candidates
 * are positions (A, B, C …) in the deterministic order; the AI writes one
 * sentence per label and never reorders anything.
 */

import type { FitScore } from './requisitionFit';

export interface FitReasonText {
  /** '{n} of {total} required skills: {skills}' */
  required: string;
  /** '{n} of {total} required skills' — when no skill is matched */
  requiredNone: string;
  /** 'also {skills}' */
  nice: string;
  /** 'aims for this kind of role' */
  title: string;
  /** "based in the role's city" */
  location: string;
  /** 'open to a remote role' */
  remote: string;
  /** 'Listed as a matching candidate.' — when nothing else applies */
  fallback: string;
}

export interface FitReasonRole {
  title: string;
  requiredSkillIds: readonly string[];
  niceSkillIds: readonly string[];
  remote: boolean;
}

const entry = (fit: FitScore, dimension: string) => fit.breakdown.find((b) => b.dimension === dimension);

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));

/** The deterministic sentence — always available, with or without AI. */
export function ruleFitReason(
  fit: FitScore,
  role: FitReasonRole,
  label: (skillId: string) => string,
  text: FitReasonText
): string {
  const parts: string[] = [];
  const required = entry(fit, 'requiredSkills');
  const totalRequired = role.requiredSkillIds.filter((id) => !role.niceSkillIds.includes(id)).length;
  if (required && totalRequired > 0) {
    const covered = required.detail;
    parts.push(
      covered.length > 0
        ? fill(text.required, { n: String(covered.length), total: String(totalRequired), skills: covered.map(label).join(', ') })
        : fill(text.requiredNone, { n: '0', total: String(totalRequired) })
    );
  }
  const nice = entry(fit, 'niceSkills');
  if (nice && nice.detail.length > 0) parts.push(fill(text.nice, { skills: nice.detail.map(label).join(', ') }));
  if (entry(fit, 'title')?.passed) parts.push(text.title);
  if (entry(fit, 'location')?.passed) parts.push(role.remote ? text.remote : text.location);
  if (parts.length === 0) return text.fallback;
  const sentence = parts.join('; ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

export interface FitReasonPayload {
  role: { title: string; requiredSkills: string[]; niceSkills: string[]; remote: boolean };
  candidates: {
    label: string;
    requiredMatched: string[];
    requiredMissing: string[];
    niceMatched: string[];
    targetsRole: boolean;
    locationFits: boolean;
  }[];
}

/** 'A' … 'Z', then 'AA' … — positions, never identities. */
export const anonLabel = (i: number): string =>
  i < 26 ? String.fromCharCode(65 + i) : anonLabel(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));

/**
 * The anonymous payload for the top candidates, in the deterministic order.
 * Takes FIT SCORES, not candidates: there is no field through which a person
 * could leak.
 */
export function buildFitReasonPayload(
  role: FitReasonRole,
  fits: readonly FitScore[],
  label: (skillId: string) => string
): FitReasonPayload {
  const required = role.requiredSkillIds.filter((id) => !role.niceSkillIds.includes(id));
  return {
    role: { title: role.title, requiredSkills: required.map(label), niceSkills: role.niceSkillIds.map(label), remote: role.remote },
    candidates: fits.map((fit, i) => {
      const covered = entry(fit, 'requiredSkills')?.detail ?? [];
      return {
        label: anonLabel(i),
        requiredMatched: covered.map(label),
        requiredMissing: required.filter((id) => !covered.includes(id)).map(label),
        niceMatched: (entry(fit, 'niceSkills')?.detail ?? []).map(label),
        targetsRole: !!entry(fit, 'title')?.passed,
        locationFits: !!entry(fit, 'location')?.passed,
      };
    }),
  };
}
