// AI-assisted CV extraction (EPIC B3). Sends already-extracted CV *text* (never
// the file) to Claude with a strict JSON schema, returning richer profile
// suggestions than the local heuristics (name, city, university, department,
// target position, in addition to contact links and skills).
//
// Gated upstream by explicit consent (B2) and only active when ANTHROPIC_API_KEY
// is configured — otherwise isAiConfigured() is false and callers return a
// clear "not configured" response. Nothing here runs without both.

import Anthropic from '@anthropic-ai/sdk';

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

// Default to the current flagship; overridable for cost tuning by the operator.
const MODEL = process.env.ANTHROPIC_CV_MODEL || 'claude-opus-4-8';
const MAX_INPUT_CHARS = 24_000; // keep requests bounded regardless of CV size

export function isAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

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
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const trimmed = text.slice(0, MAX_INPUT_CHARS);

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `CV text:\n\n${trimmed}` }],
  });

  const block = res.content.find((b) => b.type === 'text');
  const raw = block && block.type === 'text' ? block.text : '{}';
  const parsed = JSON.parse(raw) as Partial<AiCvSuggestions>;

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
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
  };
}
