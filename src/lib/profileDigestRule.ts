/**
 * The profile digest's rules (#2038) — pure, so they are unit-tested without a
 * database or a provider. The server half is `src/lib/profileDigest.ts`.
 *
 * What a digest is made from is the person's OWN free text, labelled: their
 * bio, interests, target position, skills and the titles of their goals. No
 * name, e-mail, phone or id ever enters it (contact details a person typed
 * into their bio are masked again by `callModel()`, src/lib/ai/redact.ts).
 * Every field is cut to its own bound, so one long bio cannot crowd out the
 * rest, and the whole text is what `sourceHash` is computed over: the digest
 * is regenerated only when that text actually changed.
 *
 * Themes are asked for in ENGLISH, whatever language the profile is written
 * in, so a German mentor and a Turkish mentee can share one — the comparison
 * itself (`semanticAffinity`, src/lib/matching/semantic.ts) is plain token
 * arithmetic and has no notion of translation.
 */

import { normalizeThemes } from '@/lib/matching/semantic';

export const DIGEST_MAX_CHARS = 600;
/** Asked of the model; `normalizeThemes()` bounds the stored list again. */
export const DIGEST_MAX_THEMES = 12;
/** How many model calls one nightly sweep makes at most — the AI quota is the real ceiling. */
export const DIGEST_SWEEP_BATCH = 50;
/** How many people one sweep checks (reads only; an unchanged text costs no call). */
export const DIGEST_SCAN_LIMIT = 500;

const FIELD_LIMITS = { bio: 2000, interests: 600, targetPosition: 200, skills: 600, goals: 1200 } as const;
const MAX_GOALS = 10;

export interface DigestSourceInput {
  bio?: string | null;
  interests?: string | null;
  targetPosition?: string | null;
  skills?: unknown;
  goalTitles?: readonly string[];
}

const clean = (v: string | null | undefined, max: number) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The labelled text a digest is made from, or '' when the person has written
 * nothing worth summarising — then no digest is made, and an existing one is
 * removed (it would describe text that is gone).
 */
export function digestSourceText(input: DigestSourceInput): string {
  const skills = Array.isArray(input.skills) ? input.skills.filter((s): s is string => typeof s === 'string') : [];
  const goals = (input.goalTitles ?? []).slice(0, MAX_GOALS).map((g) => clean(g, 200)).filter(Boolean);
  const parts: [string, string][] = [
    ['About', clean(input.bio, FIELD_LIMITS.bio)],
    ['Interests', clean(input.interests, FIELD_LIMITS.interests)],
    ['Target position', clean(input.targetPosition, FIELD_LIMITS.targetPosition)],
    ['Skills', clean(skills.join(', '), FIELD_LIMITS.skills)],
    ['Goals', clean(goals.join('; '), FIELD_LIMITS.goals)],
  ];
  // Skills alone are already scored by the `skills` dimension; a digest of a
  // bare skill list would only count them twice.
  if (!parts.some(([label, text]) => label !== 'Skills' && text)) return '';
  return parts.filter(([, text]) => text).map(([label, text]) => `${label}: ${text}`).join('\n');
}

/** The model's reply, read defensively: a bounded paragraph and normalised themes. */
export function readDigestReply(reply: { digest?: unknown; themes?: unknown }): { digest: string; themes: string[] } | null {
  const digest = typeof reply.digest === 'string' ? reply.digest.replace(/\s+/g, ' ').trim().slice(0, DIGEST_MAX_CHARS) : '';
  const themes = normalizeThemes(reply.themes).slice(0, DIGEST_MAX_THEMES);
  if (!digest || themes.length === 0) return null;
  return { digest, themes };
}

export type DigestPlan = 'remove' | 'unchanged' | 'generate';

/** What a refresh must do, given the current source hash and the stored one. */
export function planDigestRefresh(sourceHash: string | null, storedHash: string | null, force = false): DigestPlan {
  if (sourceHash === null) return storedHash === null ? 'unchanged' : 'remove';
  if (!force && storedHash === sourceHash) return 'unchanged';
  return 'generate';
}
