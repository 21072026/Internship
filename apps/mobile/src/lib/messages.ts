// Native messaging (#2775): the shapes of GET /api/conversations (the inbox,
// src/lib/inbox.ts on the server) and GET /api/messages?conversationId=, and
// the small rules the screens share. Dependency-free so `npm test` pins it.

export interface InboxThread {
  conversationId: string;
  type: 'DIRECT' | 'GROUP';
  name: string;
  otherId: string | null;
  last: { body: string; createdAt: string; senderId: string } | null;
  unread: number;
}

export interface Inbox {
  threads: InboxThread[];
  supportUnread: number;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ThreadMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  attachments: Attachment[];
}

export interface Thread {
  conversationId: string;
  type?: 'DIRECT' | 'GROUP';
  participants?: { id: string; fullName: string }[];
  projectName?: string | null;
  canPost?: boolean;
  messages: ThreadMessage[];
}

/** The server's own limit (src/app/api/messages/route.ts, `body` max 5000). */
export const MAX_BODY = 5000;

/** How often an open thread asks for new messages. Native push replaces this later. */
export const THREAD_POLL_MS = 5_000;

/** What the composer may send: trimmed, non-empty, within the server limit. */
export function sendableBody(input: string): string | null {
  const body = input.trim();
  if (!body || body.length > MAX_BODY) return null;
  return body;
}

/** The inbox row's second line: "You: …" for the viewer's own last message. */
export function previewLine(thread: InboxThread, me: string, you: string, empty: string): string {
  if (!thread.last) return empty;
  const text = thread.last.body.replace(/\s+/g, ' ').trim();
  return thread.last.senderId === me ? `${you}: ${text}` : text;
}

/**
 * The header of a thread opened without a name — from a link inside a web page
 * or a notification, not from the inbox row that knows it: the other person in
 * a 1:1, the project in a group room.
 */
export function threadTitle(thread: Pick<Thread, 'type' | 'participants' | 'projectName'>, me: string): string {
  if (thread.type === 'GROUP') return thread.projectName ?? '';
  return thread.participants?.find((p) => p.id !== me)?.fullName ?? '';
}

/** Sender label inside a group room; a 1:1 thread needs none. */
export function senderName(thread: Pick<Thread, 'type' | 'participants'>, senderId: string): string | null {
  if (thread.type !== 'GROUP') return null;
  return thread.participants?.find((p) => p.id === senderId)?.fullName ?? null;
}

/**
 * Whether a freshly polled thread differs from what is on screen — compared by
 * the last message's id and the count, so an unchanged poll does not re-render
 * (and does not yank a reader who scrolled up).
 */
export function threadChanged(current: ThreadMessage[], next: ThreadMessage[]): boolean {
  if (current.length !== next.length) return true;
  const a = current.at(-1);
  const b = next.at(-1);
  return a?.id !== b?.id || a?.body !== b?.body || a?.deleted !== b?.deleted;
}
