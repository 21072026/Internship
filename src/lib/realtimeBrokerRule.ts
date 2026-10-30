// The cross-replica realtime envelope (#1698) — dependency-free so the bus, the
// broker transport and the unit test share one definition of what may travel.
//
// WHAT CROSSES THE BROKER: the same signal the in-process bus already carries —
// an event type, at most three ids, and the user ids it is addressed to — plus
// the publishing replica's origin id so a replica ignores its own echo (it has
// already delivered locally). NEVER a message body, a subject, a name or an
// address: the stream is signals only (src/app/api/realtime/stream/route.ts) and
// a client that hears one refetches through the authorized endpoint. A broker
// that carried content would be a second, weaker read path for someone's
// messages; this module refuses to encode or decode anything else.

import type { RealtimeEvent, RealtimeEventType } from './realtimeBus';

export const REALTIME_EVENT_TYPES: readonly RealtimeEventType[] = [
  'message',
  'read',
  'notification',
  'typing',
  'agenda',
  'sessionNote',
];

/** Enough for any cuid/uuid; anything longer is not an id this app minted. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A fan-out wider than this is not a realtime signal (group chats are far smaller). */
export const MAX_RECIPIENTS = 500;

export interface RealtimeEnvelope {
  /** The publishing replica's id for this process — its own echo is ignored. */
  o: string;
  /** Recipient user ids. */
  u: string[];
  e: RealtimeEvent;
}

const idOrNull = (v: unknown): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : typeof v === 'string' && ID.test(v) ? v : undefined;

/** The event reduced to its allowed keys, or null when its type is unknown. */
export function sanitizeEvent(raw: unknown): RealtimeEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!REALTIME_EVENT_TYPES.includes(r.type as RealtimeEventType)) return null;
  const out: RealtimeEvent = { type: r.type as RealtimeEventType };
  for (const key of ['conversationId', 'relationId', 'senderId'] as const) {
    const v = idOrNull(r[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The wire form of one publish, or null when nothing valid is left to send. */
export function encodeEnvelope(origin: string, userIds: Iterable<string>, event: RealtimeEvent): string | null {
  const e = sanitizeEvent(event);
  const u = [...new Set(userIds)].filter((id) => ID.test(id)).slice(0, MAX_RECIPIENTS);
  if (!e || u.length === 0 || !ID.test(origin)) return null;
  return JSON.stringify({ o: origin, u, e } satisfies RealtimeEnvelope);
}

/** A received payload, validated as strictly as it was encoded; null for anything else. */
export function decodeEnvelope(payload: string): RealtimeEnvelope | null {
  if (payload.length > 64 * 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.o !== 'string' || !ID.test(r.o) || !Array.isArray(r.u)) return null;
  const e = sanitizeEvent(r.e);
  const u = r.u.filter((id): id is string => typeof id === 'string' && ID.test(id)).slice(0, MAX_RECIPIENTS);
  if (!e || u.length === 0) return null;
  return { o: r.o, u, e };
}

/**
 * The pub/sub channel. Scoped per deployment, so a Redis shared by production
 * and preview never hands one environment's signals to the other: an explicit
 * REALTIME_CHANNEL wins, else the NEXTAUTH_URL host, else 'default'.
 */
export function realtimeChannel(env: Record<string, string | undefined>): string {
  const explicit = (env.REALTIME_CHANNEL || '').trim();
  if (/^[A-Za-z0-9._:-]{1,100}$/.test(explicit)) return `realtime:${explicit}`;
  try {
    const host = new URL(env.NEXTAUTH_URL || '').hostname;
    if (host) return `realtime:${host}`;
  } catch {
    /* fall through */
  }
  return 'realtime:default';
}

/** Reconnect delay after `failures` consecutive failures: 1 s doubling to 60 s. */
export function reconnectDelayMs(failures: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, failures - 1));
}
