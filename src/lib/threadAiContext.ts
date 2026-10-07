// What a thread catch-up or a suggested reply is allowed to read (#2048), for
// the two routes that do them. One loader, so the two cannot disagree on who
// may ask or on which messages are sent.
//
// WHO. A participant of the conversation, through the same gate opening it
// uses (getConversationIfAllowed) — and a participant only: an admin who may
// read a 1:1 thread they are not in does not get it summarised.
//
// WHAT. The latest messages as the asker sees them: never one deleted for
// everyone, never one they deleted for themselves.
//
// CONSENT. Everyone whose words are in the transcript, other than the asker,
// must have granted AI_INTERACTION_SUMMARY — the consent the interaction
// summary already asks of a mentee. One person who has not means no call.

import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { hasConsent } from '@/lib/consent';
import { getConversationIfAllowed } from '@/lib/conversations';
import { buildTranscript, THREAD_AI_MESSAGES } from '@/lib/threadAiRules';

export interface ThreadAiContext {
  conversationId: string;
  transcript: string;
  /** The cache key's thread part: the newest message and the newest edit. */
  lastMessageId: string;
  lastEditedAt: string | null;
  /** The other participants (the reply's recipients on a 1:1 thread). */
  others: { id: string; fullName: string; preferredLanguage: string | null }[];
  readerName: string;
  /** Other people whose words are in the transcript. */
  quotedUserIds: string[];
}

export type ThreadAiLoad =
  | { ok: true; ctx: ThreadAiContext }
  | { ok: false; reason: 'forbidden' | 'empty' | 'no_consent' };

export async function loadThreadAiContext(user: Session['user'], conversationId: string): Promise<ThreadAiLoad> {
  const conversation = await getConversationIfAllowed(user, conversationId);
  if (!conversation || !conversation.participants.some((p) => p.userId === user.id)) return { ok: false, reason: 'forbidden' };

  const rows = await prisma.message.findMany({
    where: { conversationId: conversation.id, deletedForEveryoneAt: null, hiddenFor: { none: { userId: user.id } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: THREAD_AI_MESSAGES,
    select: { id: true, senderId: true, body: true, createdAt: true, editedAt: true },
  });
  if (rows.length === 0) return { ok: false, reason: 'empty' };

  const names = new Map(conversation.participants.map((p) => [p.user.id, p.user.fullName]));
  const quotedUserIds = [...new Set(rows.map((r) => r.senderId))].filter((id) => id !== user.id);
  for (const id of quotedUserIds) {
    if (!(await hasConsent(id, 'AI_INTERACTION_SUMMARY'))) return { ok: false, reason: 'no_consent' };
  }
  const lastEdit = rows.reduce<Date | null>((max, r) => (r.editedAt && (!max || r.editedAt > max) ? r.editedAt : max), null);

  return {
    ok: true,
    ctx: {
      conversationId: conversation.id,
      transcript: buildTranscript(rows, (id) => names.get(id) ?? '—'),
      lastMessageId: rows[0].id,
      lastEditedAt: lastEdit ? lastEdit.toISOString() : null,
      others: conversation.participants
        .filter((p) => p.userId !== user.id)
        .map((p) => ({ id: p.user.id, fullName: p.user.fullName, preferredLanguage: p.user.preferredLanguage })),
      readerName: names.get(user.id) ?? '',
      quotedUserIds,
    },
  };
}
