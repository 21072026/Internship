// AI-written fit reasons for a requisition's top candidates (#2042).
//
// Callers MUST go through runAiGated (task `requisition_fit`, operator — the
// company's AI pack). The payload comes from buildFitReasonPayload()
// (src/lib/matching/fitReason.ts), which is anonymous by construction: role
// facts plus per-label skill lists and booleans, never a person. The model
// writes ONE sentence per label; the ORDER is the deterministic fit score and
// is never taken from the reply — a label the model invents is ignored, a label
// it skips keeps its rule-based sentence.

import { z } from 'zod';
import { callModel, safeParseModelJson } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import type { FitReasonPayload } from '@/lib/matching/fitReason';

const REPLY = z.object({ reasons: z.array(z.object({ label: z.string(), reason: z.string() })) });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { label: { type: 'string' }, reason: { type: 'string' } },
        required: ['label', 'reason'],
      },
    },
  },
  required: ['reasons'],
} as const;

const LANGUAGE: Record<string, string> = { en: 'English', tr: 'Turkish', de: 'German' };

const system = (locale: string) =>
  `You explain to a hiring company, in ONE short factual sentence per candidate, why an anonymous candidate fits a role. ` +
  `Use only the provided facts (matched and missing skills, whether they aim for this kind of role, whether location fits). ` +
  `Do not rank, score, compare candidates, recommend rejection, or speculate about the person. ` +
  `Write in ${LANGUAGE[locale] ?? 'English'}. Return every label you were given, each exactly once.`;

export async function aiFitReasons(payload: FitReasonPayload, locale: string): Promise<Map<string, string>> {
  const reply = await callModel({
    task: 'requisition_fit',
    system: system(locale),
    input: `Role and candidates (JSON):\n${wrapUntrusted('candidates', JSON.stringify(payload))}`,
    jsonSchema: SCHEMA,
  });
  const parsed = safeParseModelJson(reply, REPLY, { reasons: [] });
  const known = new Set(payload.candidates.map((c) => c.label));
  const out = new Map<string, string>();
  for (const r of parsed.reasons) {
    const reason = r.reason.trim().slice(0, 400);
    if (known.has(r.label) && reason && !out.has(r.label)) out.set(r.label, reason);
  }
  return out;
}

export function encodeReasons(m: Map<string, string>): string {
  return JSON.stringify(Array.from(m));
}

export function decodeReasons(s: string): Map<string, string> {
  const rows = JSON.parse(s) as unknown;
  if (!Array.isArray(rows)) throw new Error('bad artefact');
  return new Map(rows.filter((r): r is [string, string] => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string'));
}
