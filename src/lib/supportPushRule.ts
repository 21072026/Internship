// Support-channel push (#3154, docs/mobile-push.md) — the rules, dependency-free
// so `npm run test:unit` pins them. The sending half is sendSupportPush() in
// src/lib/messagePush.ts, next to the message push it shares a body with.

/**
 * Where an admin's tap lands: the support queue. The bell row carries the same
 * path, from this constant, so the tray and the bell cannot open different
 * pages. Relative on purpose (`PushPayload.url`). The requester's side is
 * `notificationLink(role, 'support', {})`, which already gives every role
 * `/messages/support`.
 */
export const ADMIN_SUPPORT_PATH = '/admin/support';

/**
 * The support events that reach a phone: somebody wrote into a ticket and
 * somebody else is waiting for it. `support.closed` is deliberately absent. A
 * closure is bookkeeping nobody waits on, it usually follows a reply that has
 * already buzzed, and the bell keeps its row.
 *
 * Every entry is a key of the notification catalogue with category
 * `'messages'`; the unit test holds the two together, because that category is
 * the /account switch sendSupportPush passes to sendPushToUser.
 */
export const SUPPORT_PUSH_EVENTS = [
  'support.new',
  'support.newGeneric',
  'support.newMessage',
  'support.newMessageGeneric',
  'support.replied',
] as const;
export type SupportPushEvent = (typeof SUPPORT_PUSH_EVENTS)[number];

/**
 * Who is buzzed about one support message: everyone told about it, each once,
 * never the person who wrote it. An admin who opened a ticket of their own is
 * one of the admins told about it, and an admin can reply to their own ticket
 * from the queue; a push about your own words is noise either way.
 */
export function supportPushRecipients(candidateIds: readonly string[], writerId: string): string[] {
  return [...new Set(candidateIds)].filter((id) => id !== writerId);
}

/** One tray entry per ticket: a burst of messages replaces itself. */
export function supportPushTag(ticketId: string): string {
  return `support:${ticketId}`;
}

const PREVIEW_MAX = 140;

/**
 * The push body: a one-line preview, and only a preview. A push payload is
 * capped at a few KB and a lock screen shows about this much anyway; newlines
 * collapse so a multi-paragraph message does not arrive as a wall. Shared with
 * the message push, so both channels cut the same way.
 */
export function pushPreview(text: string | null | undefined): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
}
