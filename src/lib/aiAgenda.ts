// The AI-personalised session agenda (#1845). Server-only; the client, model
// and caps are callModel's (task `agenda_personalize`). Callers MUST go through
// runAiGated — the MENTEE's AI_INTERACTION_SUMMARY consent gates the call,
// because the newest interaction log entries are part of what goes out, the
// same text the summary task reads. Participant AI: free, never behind the
// pack (docs/ai.md § Who the task is for).
//
// What goes out and what never does is the contract of
// src/lib/aiAgendaRule.ts (unit-tested). The reply is a PROPOSAL — 4-7 lines
// the pair may add to the agenda, edit or discard; nothing here saves anything.

import { z } from 'zod';
import { callModel, safeParseModelJson } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import {
  AGENDA_PROPOSAL_LINE_MAX,
  AGENDA_PROPOSAL_MAX,
  AGENDA_PROPOSAL_MIN,
  buildAgendaPayload,
  normalizeAgendaProposal,
  type AgendaPayloadInput,
} from '@/lib/aiAgendaRule';

const REPLY = z.object({ items: z.array(z.string()) }).partial();

const SYSTEM =
  'You help a mentoring pair in an internship programme plan their next session. ' +
  `Given the guide they chose (if any), what is already on the agenda, the pair's open goals, the previous session's lines and the newest log entries, propose between ${AGENDA_PROPOSAL_MIN} and ${AGENDA_PROPOSAL_MAX} ordered agenda lines for THIS session — each a question or a topic of at most ${AGENDA_PROPOSAL_LINE_MAX} characters, specific to where this pair actually is, no two alike, none repeating a line already on the agenda. ` +
  'Adapt the guide rather than replacing it: keep its intent, make each prompt concrete with what the goals and the log say, drop prompts the pair has already covered, and bring an open line from the previous session forward when it still matters. ' +
  'Never invent facts, dates, names or promises; if the context is thin, stay close to the guide. ' +
  'Write in the language named by "locale" (en = English, tr = Turkish, de = German). Return ONLY JSON {"items": ["...", "..."]}.';

/** 4-7 proposed agenda lines for one session, in the caller's language. */
export async function aiProposeAgenda(input: AgendaPayloadInput): Promise<string[]> {
  const reply = await callModel({
    task: 'agenda_personalize',
    system: SYSTEM,
    // Every person-written block is fenced here, where the model is called (#2026).
    input: buildAgendaPayload(input, (label, text) => wrapUntrusted(label, text)),
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { items: { type: 'array', items: { type: 'string' } } },
      required: ['items'],
    },
  });
  const parsed = safeParseModelJson(reply, REPLY, {});
  return normalizeAgendaProposal(parsed.items, input.existingLines);
}
