/**
 * In-process pub/sub for the live message stream (#1464).
 *
 * The messaging screens used to learn about a new message only by polling, so a
 * chat was up to a minute behind the person typing into it. This is the server
 * half of the fix: whoever writes a row (the message POST, the inbound-mail
 * bridge, `notify()`) publishes a one-line event addressed to the user ids that
 * care, and every SSE connection those users hold picks it up and forwards it
 * (see src/app/api/realtime/stream/route.ts).
 *
 * Deliberately in-process, with no Redis/SignalR-style broker behind it: the app
 * is one Node process per environment (one container, see the deployment table in
 * CLAUDE.md), so a broker would be infrastructure to run and monitor for zero
 * additional reach. The cost of that choice is that an event published in one
 * replica cannot reach a listener in another — which is why the stream ALSO
 * re-checks the unread counters against the database on every heartbeat. The bus
 * makes delivery instant; the database re-check is what makes it correct. Adding
 * replicas later degrades this to "correct within one heartbeat" rather than
 * breaking it.
 */

export type RealtimeEventType =
  // A message was written into a thread this user is in.
  | 'message'
  // This user read a thread (published to *themselves*, so their other tabs
  // drop the badge instead of waiting for the next heartbeat).
  | 'read'
  // Any in-app notification row was created for this user.
  | 'notification'
  // Someone in a thread this user is in is composing a reply. Purely
  // ephemeral: nothing is stored, nothing is counted, and a listener that was
  // not connected at the moment it was published has missed nothing that
  // matters — which is why the stream deliberately does *not* re-check the
  // unread counters for this one (#1871).
  | 'typing';

export interface RealtimeEvent {
  type: RealtimeEventType;
  /** Which thread this is about, when it is about one. */
  conversationId?: string | null;
  relationId?: string | null;
  senderId?: string | null;
}

type Listener = (event: RealtimeEvent) => void;

// One browser can legitimately hold a few connections (several tabs, plus the
// installed PWA). Past that it is a leak or an attempt to pin server memory, so
// the stream route turns a refusal here into a polling fallback rather than
// holding an unbounded number of sockets open per account.
export const MAX_CONNECTIONS_PER_USER = 6;

const globalForBus = globalThis as unknown as {
  realtimeListeners: Map<string, Set<Listener>> | undefined;
};

// Survives HMR in dev for the same reason the Prisma client does: a fresh Map on
// every module reload would orphan the connections held by the previous one.
const listeners: Map<string, Set<Listener>> = (globalForBus.realtimeListeners ??= new Map());

/** How many live connections this user currently holds in this process. */
export function connectionCount(userId: string): number {
  return listeners.get(userId)?.size ?? 0;
}

/**
 * Register a listener for one user. Returns the unsubscribe function, or null
 * when the user is already at {@link MAX_CONNECTIONS_PER_USER}.
 */
export function subscribeRealtime(userId: string, listener: Listener): (() => void) | null {
  const set = listeners.get(userId) ?? new Set<Listener>();
  if (set.size >= MAX_CONNECTIONS_PER_USER) return null;
  set.add(listener);
  listeners.set(userId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(userId);
  };
}

/**
 * Deliver an event to every connection these users hold. Never throws: a
 * publisher is always in the middle of an action that matters more than the
 * live update (writing the message), so a broken listener must not surface as a
 * failed request.
 */
export function publishRealtime(userIds: Iterable<string>, event: RealtimeEvent): void {
  for (const userId of new Set(userIds)) {
    const set = listeners.get(userId);
    if (!set) continue;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        /* a dead connection is dropped by its own cleanup — ignore */
      }
    }
  }
}
