// Per-viewer inbox state (#1609): archive, mute, pin. Client-safe and pure —
// the inbox loader, the state route, the notification fan-out and the unit test
// (scripts/test/conversation-state.test.mjs) all read the rules from here.
//
// WHERE IT LIVES. Three nullable timestamps on ConversationParticipant — the
// viewer's own row, so one person's choice is invisible to everyone else in
// the thread and survives a reload on any device. Nothing is ever deleted:
// archiving hides a thread behind a filter, that is all.
//
// THE RULES
//   • Pinned threads sort first (most recently active first among themselves),
//     then everything else by latest message — the order the inbox always had.
//   • Muted means "do not interrupt me about this thread": no push, no e-mail
//     mirror, no bell row, no unread digest. The unread count in the inbox
//     still counts — muting is about interruptions, not about hiding mail.
//     A mute ends at `mutedUntil`; "until I turn it back on" is a far-future
//     date so there is one column and one comparison.
//   • Archived threads leave the main list, and come back on their own when
//     someone else writes into them after they were archived — unless the
//     thread is also muted, which is how you keep a noisy room archived. That
//     return is derived here at read time, never written, so no message path
//     has to remember to unarchive anything.

export const MUTE_FOREVER = new Date('9999-12-31T00:00:00.000Z');
export const MUTE_CHOICES = ['8h', '1w', 'forever'] as const;
export type MuteChoice = (typeof MUTE_CHOICES)[number];

const HOUR = 60 * 60 * 1000;

export function muteUntil(choice: MuteChoice, now: Date = new Date()): Date {
  if (choice === '8h') return new Date(now.getTime() + 8 * HOUR);
  if (choice === '1w') return new Date(now.getTime() + 7 * 24 * HOUR);
  return MUTE_FOREVER;
}

export function isMuted(mutedUntil: Date | string | null | undefined, now: Date = new Date()): boolean {
  return mutedUntil != null && new Date(mutedUntil).getTime() > now.getTime();
}

export interface ParticipantState {
  archivedAt: Date | string | null;
  mutedUntil: Date | string | null;
  pinnedAt: Date | string | null;
}

/**
 * Is this thread archived for the viewer right now? Archived, and nobody else
 * has written since — or they have, but the thread is muted.
 */
export function isArchived(
  state: ParticipantState,
  last: { senderId: string; createdAt: Date | string } | null,
  me: string,
  now: Date = new Date(),
): boolean {
  if (!state.archivedAt) return false;
  const writtenSince = last != null && last.senderId !== me && new Date(last.createdAt).getTime() > new Date(state.archivedAt).getTime();
  return !writtenSince || isMuted(state.mutedUntil, now);
}

export const INBOX_FILTERS = ['all', 'unread', 'pinned', 'archived'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export function parseInboxFilter(raw: string | null | undefined): InboxFilter {
  return (INBOX_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as InboxFilter) : 'all';
}

interface ViewThread {
  pinned: boolean;
  archived: boolean;
  unread: number;
  last: { createdAt: Date | string } | null;
}

const lastAt = (t: ViewThread) => (t.last ? new Date(t.last.createdAt).getTime() : 0);

/** Pinned first, then by latest message; ties keep their incoming order. */
export function sortInbox<T extends ViewThread>(threads: T[]): T[] {
  return [...threads].sort((a, b) => Number(b.pinned) - Number(a.pinned) || lastAt(b) - lastAt(a));
}

/** The threads one filter chip shows. Only "Archived" shows archived threads. */
export function filterInbox<T extends ViewThread>(threads: T[], filter: InboxFilter): T[] {
  if (filter === 'archived') return threads.filter((t) => t.archived);
  const live = threads.filter((t) => !t.archived);
  if (filter === 'unread') return live.filter((t) => t.unread > 0);
  if (filter === 'pinned') return live.filter((t) => t.pinned);
  return live;
}
