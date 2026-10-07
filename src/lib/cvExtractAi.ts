// AI-assisted CV extraction (EPIC B3). Sends already-extracted CV *text* (never
// the file) to Claude with a strict JSON schema, returning richer profile
// suggestions than the local heuristics (name, city, university, department,
// target position, in addition to contact links and skills).
//
// Gated upstream by explicit consent (B2) and only active when ANTHROPIC_API_KEY
// is configured — otherwise isAiConfigured() is false and callers return a
// clear "not configured" response. Nothing here runs without both.
//
// This module holds the prompt and the parser only. The client, the model, the
// timeout and the input cap are the provider module's (src/lib/ai/provider.ts,
// #2022), under the `cv_extract` registry entry (src/lib/ai/tasks.ts).

import { capSkills } from '@/lib/skills';
import { z } from 'zod';
import { callModel, isAiConfigured as providerConfigured, safeParseModelJson } from '@/lib/ai/provider';

// The reply's shape, loosely: every field optional, so a partial answer still
// yields what it has.
const CV_REPLY = z
  .object({
    fullName: z.string(), city: z.string(), university: z.string(), department: z.string(), targetPosition: z.string(),
    phone: z.string(), linkedinUrl: z.string(), githubUrl: z.string(), portfolioUrl: z.string(), skills: z.array(z.string()),
  })
  .partial();

export interface AiCvSuggestions {
  fullName: string;
  city: string;
  university: string;
  department: string;
  targetPosition: string;
  phone: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  skills: string[];
}

/**
 * @deprecated since #2022 — import it from '@/lib/ai/provider', where the
 * credential lives. Re-exported here for one release so no caller breaks.
 */
export const isAiConfigured = providerConfigured;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fullName: { type: 'string' },
    city: { type: 'string' },
    university: { type: 'string' },
    department: { type: 'string' },
    targetPosition: { type: 'string' },
    phone: { type: 'string' },
    linkedinUrl: { type: 'string' },
    githubUrl: { type: 'string' },
    portfolioUrl: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'fullName', 'city', 'university', 'department', 'targetPosition',
    'phone', 'linkedinUrl', 'githubUrl', 'portfolioUrl', 'skills',
  ],
} as const;

const SYSTEM = `You extract structured profile fields from a CV/résumé. Return ONLY fields you can find in the text. For any field you cannot find, return an empty string (or an empty array for skills). Do not invent or infer values that are not present. Keep values concise (e.g. a city name, a single phone number, canonical skill names).`;

/**
 * Extract profile suggestions from CV text via Claude. Assumes the caller has
 * already verified consent and isAiConfigured(). Throws on API failure.
 */
export async function aiExtractFromText(text: string): Promise<AiCvSuggestions> {
  const reply = await callModel({ task: 'cv_extract', system: SYSTEM, input: `CV text:\n\n${text}`, jsonSchema: SCHEMA });
  // A reply that is not the JSON asked for falls back to "no suggestions" and
  // is recorded as parse_error (#2024) — never a thrown 500.
  const parsed: Partial<AiCvSuggestions> = safeParseModelJson(reply, CV_REPLY, {});

  return {
    fullName: parsed.fullName ?? '',
    city: parsed.city ?? '',
    university: parsed.university ?? '',
    department: parsed.department ?? '',
    targetPosition: parsed.targetPosition ?? '',
    phone: parsed.phone ?? '',
    linkedinUrl: parsed.linkedinUrl ?? '',
    githubUrl: parsed.githubUrl ?? '',
    portfolioUrl: parsed.portfolioUrl ?? '',
    // Split and capped: a model asked for "canonical skill names" still
    // occasionally answers with one comma-joined line or a whole phrase, and
    // this list is offered to the user as one-click chips (@/lib/skills, #2314).
    skills: capSkills(Array.isArray(parsed.skills) ? parsed.skills : []),
  };
}
