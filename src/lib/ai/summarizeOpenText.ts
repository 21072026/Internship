// One engine for "what do these hundred free-text rows say?" (#2046), server
// only. The rules — what is sent, what is kept, the floor — are pure and live
// in src/lib/ai/openTextRules.ts; this file is the one prompt, the provider
// call, and the gate around them.
//
// Every caller goes through `runOpenTextSummary`, which:
//   1. refuses below the caller's floor, with nothing but the refusal (no
//      provider call, no quota, no artefact);
//   2. prepares the rows (contact details and names masked, local labels);
//   3. runs the call through runAiGated — quota, metering, the AiArtifact cache
//      (#2044) keyed on exactly the text that would be sent, so an unchanged
//      set of rows is answered from the stored summary;
//   4. returns the verified summary, with the caveats of how it was made.
// Operator-side AI: no per-person consent, the same footing as the survey
// summary (#1910) — the rows are the programme's own records, read by the
// admin who can already open each one.

import { runAiGated, type AiDenialReason, type AiArtifactRef } from '@/lib/aiGate';
import { findCachedArtifact, hashInput } from '@/lib/ai/artifacts';
import { defaultOrgId } from '@/lib/defaultOrg';
import { callModel, noteParseError } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import type { AiTaskId } from '@/lib/ai/tasks';
import type { Locale } from '@/i18n/config';
import {
  belowFloor,
  parseOpenTextSummary,
  prepareOpenText,
  type OpenTextCaveat,
  type OpenTextItem,
  type OpenTextSummary,
  type PreparedItem,
} from '@/lib/ai/openTextRules';

const LANGUAGE: Record<Locale, string> = { en: 'English', tr: 'Turkish', de: 'German' };

const SYSTEM = `You find the recurring themes in a set of short free-text rows written inside a mentoring and internship programme, for the programme team.
Each row is given as [label] text. Return ONLY JSON of the form
{"themes":[{"label":"short theme title","ids":["r1","r4"]}],"sentiment":{"r1":"positive","r2":"negative"},"quotes":[{"id":"r3","text":"exact phrase"}]}
Rules:
- 2-8 themes, most frequent first. "ids" lists EVERY row that belongs to the theme; a row may belong to more than one.
- "sentiment" gives each row exactly one of: positive, neutral, negative, unclear. Use unclear whenever the row does not make its tone plain. Never use a number.
- At most five quotes, each copied character for character from the row it names, a short phrase or sentence. Do not paraphrase inside a quote.
- Never name or identify a person, never guess who wrote a row. Text like [name], [e-mail], [phone] is masked on purpose; leave it masked.
- Say nothing the rows do not contain: no advice, no causes, no conclusions of your own.`;

async function callProviderForSummary(task: AiTaskId, purpose: string, locale: Locale, prepared: PreparedItem[], carried: OpenTextCaveat[]): Promise<OpenTextSummary | null> {
  const rows = prepared.map((p) => `[${p.label}] ${p.text}`).join('\n');
  const reply = await callModel({ task, system: SYSTEM, input: `What these rows are: ${purpose}\nWrite theme titles in ${LANGUAGE[locale]}.\n\n${wrapUntrusted('rows', rows)}` });
  const summary = parseOpenTextSummary(reply, prepared, carried);
  // Not the JSON asked for: metered as parse_error, and never kept — a stored
  // "unreadable" would answer every identical request for a day.
  if (!summary) noteParseError();
  return summary;
}

export type OpenTextOutcome =
  | { ok: true; summary: OpenTextSummary; cached: boolean; artifact: AiArtifactRef | null }
  | { ok: false; reason: 'below_floor'; caveats: OpenTextCaveat[] }
  | { ok: false; reason: 'no_rows' }
  | { ok: false; reason: AiDenialReason | 'unreadable' };

export interface OpenTextRequest {
  /** The gate scope and artefact task, e.g. 'evaluation_insights' (a registry id, #2022). */
  scope: AiTaskId;
  orgId: string | null;
  userId: string;
  items: OpenTextItem[];
  /** What the rows are, in plain English, for the prompt ("evaluation comments"). */
  purpose: string;
  locale: Locale;
  /** Fewer usable rows than this and nothing is sent. */
  floor: number;
  /** Every person who could be named in the rows; masked before sending. */
  names?: string[];
  regenerate?: boolean;
}

/** The cache key: the purpose, the language and exactly the text that would be sent. */
export function openTextInputHash(req: Pick<OpenTextRequest, 'purpose' | 'locale'>, prepared: PreparedItem[]): string {
  return hashInput({ purpose: req.purpose, locale: req.locale, rows: prepared.map((p) => [p.id, p.text]) });
}

export async function runOpenTextSummary(req: OpenTextRequest): Promise<OpenTextOutcome> {
  const refusal = belowFloor(req.items, req.floor);
  if (refusal) return { ok: false, reason: 'below_floor', caveats: [refusal] };
  const { prepared, caveats } = prepareOpenText(req.items, { names: req.names });
  if (prepared.length === 0) return { ok: false, reason: 'no_rows' };

  const gated = await runAiGated<OpenTextSummary | null>({
    scope: req.scope,
    orgId: req.orgId,
    userId: req.userId,
    call: () => callProviderForSummary(req.scope, req.purpose, req.locale, prepared, caveats),
    persist: {
      subjectUserId: null,
      createdById: req.userId,
      inputHash: openTextInputHash(req, prepared),
      force: req.regenerate,
      serialize: (r) => JSON.stringify(r),
      deserialize: (c) => {
        const v = JSON.parse(c) as OpenTextSummary;
        if (!v || !Array.isArray(v.themes)) throw new Error('stale summary');
        return v;
      },
    },
  }).catch(() => ({ ok: false as const, reason: 'provider_error' as const }));
  if (!gated.ok) return { ok: false, reason: gated.reason };
  if (!gated.result) return { ok: false, reason: 'unreadable' };
  return { ok: true, summary: gated.result, cached: !!gated.cached, artifact: gated.artifact ?? null };
}

/**
 * The stored summary for exactly these rows, if one is inside its TTL — no
 * provider call, no quota, nothing written. What a screen shows on load, so a
 * page view never spends a call (#2046: "cached rather than regenerated per
 * page view").
 */
export async function peekOpenTextSummary(req: Omit<OpenTextRequest, 'userId' | 'regenerate'>): Promise<{ summary: OpenTextSummary; artifact: AiArtifactRef } | null> {
  if (belowFloor(req.items, req.floor)) return null;
  const { prepared } = prepareOpenText(req.items, { names: req.names });
  if (prepared.length === 0) return null;
  const hit = await findCachedArtifact({
    orgId: req.orgId ?? (await defaultOrgId()),
    taskId: req.scope,
    subjectUserId: null,
    inputHash: openTextInputHash(req, prepared),
  }).catch(() => null);
  if (!hit) return null;
  try {
    const summary = JSON.parse(hit.content) as OpenTextSummary;
    if (!summary || !Array.isArray(summary.themes)) return null;
    return { summary, artifact: { id: hit.id, createdAt: hit.createdAt.toISOString(), visibility: hit.visibility } };
  } catch {
    return null;
  }
}
