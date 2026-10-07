// AI-suggested next steps for one relation (#2875). Server-only; the client,
// model and caps are callModel's (task `next_step_suggest`). Callers MUST go
// through runAiGated — the MENTEE's AI_INTERACTION_SUMMARY consent gates the
// call, because the input is the same interaction log the summary task reads.
//
// What goes out: the stage (its English key and the label the mentor sees),
// how many days the record has sat there, the newest log entries (date, type,
// subject, notes — contact details masked by callModel, #2026) and the note
// the owner already wrote. What never goes out: names, e-mail addresses,
// files, the company's contact data. The reply is a PROPOSAL — three short
// lines the owner may click into the follow-up field and edit; nothing here
// saves anything.

import { z } from 'zod';
import { callModel, safeParseModelJson } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import { NEXT_ACTION_NOTE_MAX } from '@/lib/nextActionRule';
import { NEXT_STEP_LINE_MAX } from '@/lib/nextStepSuggestions';

export interface NextStepInteraction {
  date: Date;
  type: string;
  subject?: string | null;
  notes: string;
}

export interface NextStepInput {
  /** The canonical stage key — `APPLICATION_100`, never a label. */
  stageKey: string;
  /** The label the owner sees, in their own locale. */
  stageLabel: string;
  daysInStage: number;
  /** `en` / `tr` / `de` — the language the suggestions are written in. */
  locale: string;
  currentNote: string | null;
  interactions: NextStepInteraction[];
}

/** How many suggestions one call returns. The panel renders exactly these. */
export const NEXT_STEP_SUGGESTION_COUNT = 3;

const REPLY = z.object({ suggestions: z.array(z.string()) }).partial();

const SYSTEM =
  'You help a mentor in an internship programme decide the single next step with one mentee. ' +
  `Given the pipeline stage, how long the record has been there, and the newest interaction log entries, propose exactly ${NEXT_STEP_SUGGESTION_COUNT} concrete next steps the MENTOR takes next — each an imperative of at most ${NEXT_STEP_LINE_MAX} characters, specific to what the log says, no two alike. ` +
  'Prefer the step that unblocks the stage. Never invent facts, dates, names or promises; if the log is thin, fall back to what is usually next at this stage. ' +
  'Write in the language named by "locale" (en = English, tr = Turkish, de = German). Return ONLY JSON {"suggestions": ["...", "...", "..."]}.';

/** Three short next-step proposals for the owner to click into the follow-up field. */
export async function aiNextStepSuggestions(input: NextStepInput): Promise<string[]> {
  const log = input.interactions
    .map((i) => `${i.date.toISOString().slice(0, 10)} · ${i.type}${i.subject ? ` · ${i.subject}` : ''}\n${i.notes}`)
    .join('\n---\n');
  const reply = await callModel({
    task: 'next_step_suggest',
    system: SYSTEM,
    input:
      `locale: ${input.locale}\n` +
      `stage: ${input.stageKey} (${input.stageLabel})\n` +
      `days in this stage: ${input.daysInStage}\n` +
      (input.currentNote ? `current follow-up note (may be stale):\n${wrapUntrusted('note', input.currentNote)}\n` : '') +
      `\nInteraction log (newest first):\n\n${wrapUntrusted('log', log)}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { suggestions: { type: 'array', items: { type: 'string' } } },
      required: ['suggestions'],
    },
  });
  const parsed = safeParseModelJson(reply, REPLY, {});
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(parsed.suggestions) ? parsed.suggestions : []) {
    const line = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, Math.min(NEXT_STEP_LINE_MAX, NEXT_ACTION_NOTE_MAX));
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
    if (out.length === NEXT_STEP_SUGGESTION_COUNT) break;
  }
  return out;
}
