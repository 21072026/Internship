// Grounded outreach drafts (#2048, part 2): the prompts only. Client, model,
// timeout and caps are callModel's (#2022, tasks `outreach_draft` and
// `bulk_draft`). Callers MUST go through runAiGated.
//
// Every function here RETURNS TEXT. Nothing in this file — or in the routes
// that call it — sends, posts or logs a message: a person reads the draft in a
// composer and presses Send. scripts/test/ai-never-autosend.test.mjs keeps it
// that way (no mail or message write in here; no AI import in the crons).

import { callModel } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import { languageName } from '@/lib/threadAiRules';
import { NAME_FIELD, factsBlock, parseDraft, type Draft, type OutreachFacts, type OutreachMoment } from '@/lib/outreachRules';

export type { Draft };

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
} as const;

const MOMENT: Record<OutreachMoment, string> = {
  first_message:
    'This is the mentor\'s FIRST message to a new mentee: introduce yourself as their mentor, say what the first step will be, and invite a short call. Warm, three to five sentences.',
  dormant_nudge:
    'The mentee has gone quiet after earlier contact. Write ONE short, low-pressure check-in: ask whether they are still interested and make replying easy. No guilt, no deadline, two to four sentences.',
  outcome_note:
    'The relation has reached an outcome (see "Outcome"). "noMatch" means no placement this round; "placedElsewhere" means they found something elsewhere. Write a kind, honest note: thank them, state the outcome plainly without blame, and leave the door open. Never promise anything. Four to six sentences.',
};

export async function aiDraftOutreach(input: { moment: OutreachMoment; facts: OutreachFacts; locale: string; mentorName: string }): Promise<Draft> {
  const reply = await callModel({
    task: 'outreach_draft',
    jsonSchema: DRAFT_SCHEMA,
    system:
      `You draft a message from the mentor (named in the "mentor" block) to their mentee. Write it in ${languageName(input.locale)}. ` +
      `${MOMENT[input.moment]} Ground it ONLY in the facts given; mention a goal or the last meeting only if it is listed. ` +
      'Never invent dates, links, companies, promises or facts. No signature placeholder. ' +
      'Return JSON: a short email subject and the message body.',
    // The name and the goal titles in the facts are user-authored: data, not prompt (#2026).
    input: `Mentor:\n${wrapUntrusted('mentor', input.mentorName)}\n\nFacts:\n${wrapUntrusted('facts', factsBlock(input.facts))}`,
  });
  return parseDraft(reply);
}

export async function aiDraftBulk(input: { purpose: string; locale: string; authorName: string; recipientCount: number }): Promise<Draft> {
  const reply = await callModel({
    task: 'bulk_draft',
    jsonSchema: DRAFT_SCHEMA,
    system:
      `You draft ONE email that the sender (named in the "sender" block) will send to ${input.recipientCount} mentees, each receiving a personal copy. Write it in ${languageName(input.locale)}. ` +
      `Address the reader with the merge field ${NAME_FIELD} exactly as written (it is replaced by each person's first name) — never a made-up name. ` +
      'Keep it to what the purpose says; never invent dates, links or promises. No signature placeholder. ' +
      'Return JSON: a short subject and the body.',
    input: `Sender:\n${wrapUntrusted('sender', input.authorName)}\n\nPurpose of the email (from the sender):\n${wrapUntrusted('purpose', input.purpose)}`,
  });
  return parseDraft(reply);
}
