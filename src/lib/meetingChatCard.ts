// The chat card of a meeting (#1942): which subject its cards share, and the
// join button. Dependency-free.
//
// A bulk schedule writes one Meeting row per invitee sharing ONE room, under
// one `batchKey` (#1980) — so the subject is the batch when there is one: the
// mentor holds a reminder card per row, and cancelling the session must
// rewrite all of them, not just the one row the cancel notice happened to read.

import type { ChatCard } from '@/lib/notifications/adapters/types';

export function meetingChatSubject(meeting: { id: string; batchKey?: string | null }): string {
  return `meeting:${meeting.batchKey || meeting.id}`.slice(0, 64);
}

/** The join link as a button — only an https room; a cancelled meeting gets none. */
export function meetingChatCard(
  meeting: { id: string; batchKey?: string | null; meetLink?: string | null },
  kind: 'invite' | 'reminder' | 'moved' | 'cancelled',
): ChatCard {
  const link = meeting.meetLink?.startsWith('https://') ? meeting.meetLink : null;
  return {
    subjectKey: meetingChatSubject(meeting),
    actionUrl: kind === 'cancelled' ? null : link,
    supersede: kind === 'moved' || kind === 'cancelled',
  };
}
