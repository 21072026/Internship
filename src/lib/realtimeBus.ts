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
 * In-process first. Every publish is delivered to this process's listeners
 * directly, always — so with no broker configured this is exactly the bus it
 * always was, and the stream ALSO re-checks the unread counters against the
 * database on every heartbeat: the bus makes delivery instant, the re-check is
 * what makes it correct.
 *
 * Across replicas (#1698): with REALTIME_REDIS_URL set, the same publish also
 * goes out on a Redis pub/sub channel (src/lib/realtimeBroker.ts), and every
 * other replica delivers it to ITS listeners; a replica ignores its own echo.
 * What crosses the broker is the signal only — type, ids, recipients — checked
 * on both ends by src/lib/realtimeBrokerRule.ts; never a message body. A broker
 * outage degrades to the single-replica behaviour above, never to silence.
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
  | 'typing'
  // A session agenda of a mentorship this user is in changed (#1843): an item
  // was ticked, added, removed or carried over. Carries the relationId; the
  // panel refetches through the authorized endpoint. Moves no unread counter.
  | 'agenda'
  // The pair's shared minutes changed (#1847) — same shape and same rules as
  // `agenda`: relationId only, the panel refetches, no counter moves.
  | 'sessionNote';

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

// ── The broker (#1698) ───────────────────────────────────────────────────────
// Started lazily on first use, once per process (on globalThis, like the
// listener map), and only when REALTIME_REDIS_URL is a redis:// URL — so an
// install without one never imports node:net and behaves exactly as before.
const globalForBroker = globalThis as unknown as {
  realtimeBroker?: { publish(payload: string): void } | null;
  realtimeBrokerOrigin?: string;
};
const origin = (globalForBroker.realtimeBrokerOrigin ??= `r${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`);

function ensureBroker(): void {
  if (globalForBroker.realtimeBroker !== undefined) return;
  const url = (process.env.REALTIME_REDIS_URL || '').trim();
  if (!/^rediss?:\/\//i.test(url)) {
    globalForBroker.realtimeBroker = null;
    return;
  }
  // Publishes made before the connection is up are local-only, like an outage.
  globalForBroker.realtimeBroker = null;
  void Promise.all([import('./realtimeBroker'), import('./realtimeBrokerRule'), import('./logger')])
    .then(([{ startRealtimeBroker }, { decodeEnvelope, realtimeChannel }, { logger }]) => {
      globalForBroker.realtimeBroker = startRealtimeBroker({
        url,
        channel: realtimeChannel(process.env),
        logger,
        onMessage: (payload) => {
          const envelope = decodeEnvelope(payload);
          if (envelope && envelope.o !== origin) deliverLocal(envelope.u, envelope.e);
        },
      });
    })
    .catch(() => {
      /* no broker: in-process delivery, as before */
    });
}

/** How many live connections this user currently holds in this process. */
export function connectionCount(userId: string): number {
  return listeners.get(userId)?.size ?? 0;
}

/**
 * Register a listener for one user. Returns the unsubscribe function, or null
 * when the user is already at {@link MAX_CONNECTIONS_PER_USER}.
 */
export function subscribeRealtime(userId: string, listener: Listener): (() => void) | null {
  ensureBroker();
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
  const recipients = [...new Set(userIds)];
  deliverLocal(recipients, event);
  ensureBroker();
  const broker = globalForBroker.realtimeBroker;
  if (!broker || recipients.length === 0) return;
  void import('./realtimeBrokerRule')
    .then(({ encodeEnvelope }) => {
      const payload = encodeEnvelope(origin, recipients, event);
      if (payload) broker.publish(payload);
    })
    .catch(() => {});
}

function deliverLocal(userIds: Iterable<string>, event: RealtimeEvent): void {
  for (const userId of userIds) {
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
