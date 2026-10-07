// Thread catch-up and suggested replies (#2048): the prompts only. The client,
// model, timeout and input cap are callModel's (#2022, tasks `thread_summary`
// and `suggested_reply`). Sends only the transcript (dates, names, message
// text), never attachments or contact data. Callers MUST go through
// runAiGated (consent + quota + cache); the transcript and the language are
// decided in src/lib/threadAiRules.ts.
//
// A suggested reply is TEXT FOR A HUMAN TO EDIT: the route returns it, the
// composer shows it, and only a person pressing Send turns it into a message.
// Nothing in this module or its route can post one.

import { callModel } from '@/lib/ai/provider';
import { languageName, type ReplyTone } from '@/lib/threadAiRules';
import { wrapUntrusted } from '@/lib/ai/untrusted';

/** "What happened here", for the participant who asked, in their language. */
export async function aiCatchUp(input: { transcript: string; readerName: string; locale: string }): Promise<string> {
  const reply = await callModel({
    task: 'thread_summary',
    system:
      `You help one participant catch up on a conversation they are part of. Write for the reader named in the "reader" block, in ${languageName(input.locale)}. ` +
      'Return 3-6 short bullet lines: what was discussed, what was agreed or decided, questions or tasks still waiting (say who they wait on), and the next step if there is one. ' +
      'Use only what the messages say; never invent dates, commitments or facts. Do not quote whole messages.',
    // Names are user-authored too, so they travel as data, never in the system prompt (#2026).
    input: `Reader:\n${wrapUntrusted('reader', input.readerName)}\n\nConversation (oldest first):\n\n${wrapUntrusted('conversation', input.transcript)}`,
  });
  return reply.trim();
}

const TONE: Record<ReplyTone, string> = {
  brief: 'brief: one or two short sentences',
  warm: 'warm: friendly and encouraging, two to four sentences',
  formal: 'formal: polite and professional, two to four sentences',
};

/** One draft reply for the author to edit — never sent from here. */
export async function aiSuggestReply(input: { transcript: string; authorName: string; recipientName: string; locale: string; tone: ReplyTone }): Promise<string> {
  const reply = await callModel({
    task: 'suggested_reply',
    system:
      'You draft the next message the author (the "author" block) could send to the recipient (the "recipient" block) in this conversation. ' +
      `Write it in ${languageName(input.locale)}. Tone — ${TONE[input.tone]}. ` +
      'Answer the latest message that is waiting on the author; if nothing is waiting, move the conversation one useful step forward. ' +
      'Return ONLY the message text: no preface, no quotation marks, no subject line, no signature placeholder. ' +
      'Never invent dates, times, links, promises or facts that the conversation does not contain.',
    input: `Author:\n${wrapUntrusted('author', input.authorName)}\nRecipient:\n${wrapUntrusted('recipient', input.recipientName)}\n\nConversation (oldest first):\n\n${wrapUntrusted('conversation', input.transcript)}`,
  });
  return reply.trim();
}
