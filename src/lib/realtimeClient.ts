'use client';

import type { UnreadCounts } from '@/lib/unreadCounts';

/**
 * Client half of the live message stream (#1464).
 *
 * One `EventSource` per browsing context, shared by every component that wants
 * live updates (the header badge, the bell, the inbox, the open thread). A hook
 * that opened its own connection would cost four sockets per tab and hit the
 * per-user cap in `realtimeBus.ts` after two tabs, so the connection is a module
 * singleton with a subscriber count and the hooks are thin wrappers over it.
 *
 * Degrading is a first-class path, not an afterthought: an SSE stream can be
 * killed by a corporate proxy, a service worker, or simply by the per-user cap.
 * When that happens this falls back to polling `/api/messages/unread` — the
 * behaviour the app had before, at a faster cadence — and retries the stream
 * later. Consumers see the same signals either way, so nothing downstream has to
 * know which mode is live.
 */

export type RealtimeSignal =
  // Counts, either as the stream's opening statement or because they changed.
  | { type: 'ready'; counts: UnreadCounts }
  | { type: 'unread'; counts: UnreadCounts }
  // A message landed in one of the viewer's threads. Carries only ids: the
  // consumer refetches the thread through the normal authorized endpoint.
  | { type: 'message'; conversationId: string | null; relationId: string | null; senderId: string | null }
  // The viewer read a thread somewhere else (another tab, the e-mail action).
  | { type: 'read'; conversationId: string | null; relationId: string | null }
  // Someone else is composing in one of the viewer's threads (#1871). Ephemeral
  // in both directions: nothing was stored server-side, and the consumer is the
  // one that expires it (there is no "stopped typing" event to wait for).
  | { type: 'typing'; conversationId: string | null; relationId: string | null; senderId: string | null }
  // Any in-app notification row was created for the viewer.
  | { type: 'notification' }
  // "Refetch whatever you are showing." Emitted on every poll while in fallback
  // mode, and whenever the tab becomes visible again — a phone suspends both the
  // socket and our timers, so coming back to the app must not wait for a beat.
  | { type: 'tick' };

type Subscriber = (signal: RealtimeSignal) => void;

const STREAM_URL = '/api/realtime/stream';
// Fallback cadence. The old header badge polled once a minute, which is what
// made a conversation feel a minute behind; 20s is the compromise between that
// and hammering the endpoint from a screen nobody is looking at (polling stops
// entirely while the tab is hidden).
const POLL_MS = 20_000;
// If the stream cannot even say hello in this long, treat it as blocked.
const READY_TIMEOUT_MS = 10_000;
// How long to stay on polling before trying the stream again.
const STREAM_RETRY_MS = 5 * 60_000;

const subscribers = new Set<Subscriber>();
let source: EventSource | null = null;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;
let streaming = false;

function emit(signal: RealtimeSignal) {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(signal);
    } catch {
      /* one bad consumer must not starve the others */
    }
  }
}

function parse(event: MessageEvent): Record<string, unknown> {
  try {
    const data = JSON.parse(event.data);
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function countsFrom(data: Record<string, unknown>): UnreadCounts {
  return {
    messages: typeof data.messages === 'number' ? data.messages : 0,
    notifications: typeof data.notifications === 'number' ? data.notifications : 0,
  };
}

async function pollOnce() {
  try {
    const res = await fetch('/api/messages/unread', { cache: 'no-store' });
    if (!res.ok) return;
    emit({ type: 'unread', counts: countsFrom(await res.json()) });
  } catch {
    /* offline — the next tick tries again */
  }
  // Polling cannot tell us *which* thread moved, so an open thread has to
  // refetch on every tick. That is what the stream exists to avoid.
  emit({ type: 'tick' });
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  if (pollTimer || subscribers.size === 0) return;
  void pollOnce();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void pollOnce();
  }, POLL_MS);
}

function closeStream() {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = null;
  source?.close();
  source = null;
  streaming = false;
}

/** Give up on SSE for a while and keep the badges fresh by polling instead. */
function fallbackToPolling() {
  closeStream();
  startPolling();
  if (retryTimer || subscribers.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (subscribers.size === 0) return;
    openStream();
  }, STREAM_RETRY_MS);
}

function openStream() {
  if (source || typeof window === 'undefined' || typeof EventSource === 'undefined') {
    if (typeof EventSource === 'undefined') startPolling();
    return;
  }
  const es = new EventSource(STREAM_URL);
  source = es;

  // Nothing proves a proxy is buffering us except silence, so time it.
  readyTimer = setTimeout(() => {
    if (!streaming) fallbackToPolling();
  }, READY_TIMEOUT_MS);

  const onReady = (event: MessageEvent) => {
    streaming = true;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    // The stream is authoritative again — drop the fallback poller.
    stopPolling();
    emit({ type: 'ready', counts: countsFrom(parse(event)) });
  };

  es.addEventListener('ready', onReady as EventListener);
  es.addEventListener('unread', ((event: MessageEvent) => {
    emit({ type: 'unread', counts: countsFrom(parse(event)) });
  }) as EventListener);
  es.addEventListener('message', ((event: MessageEvent) => {
    const d = parse(event);
    emit({
      type: 'message',
      conversationId: (d.conversationId as string) ?? null,
      relationId: (d.relationId as string) ?? null,
      senderId: (d.senderId as string) ?? null,
    });
  }) as EventListener);
  // Deliberately stream-only: there is no polling equivalent (a typing fact is
  // gone before the next 20s tick), so in fallback mode the indicator is simply
  // absent rather than late.
  es.addEventListener('typing', ((event: MessageEvent) => {
    const d = parse(event);
    emit({
      type: 'typing',
      conversationId: (d.conversationId as string) ?? null,
      relationId: (d.relationId as string) ?? null,
      senderId: (d.senderId as string) ?? null,
    });
  }) as EventListener);
  es.addEventListener('read', ((event: MessageEvent) => {
    const d = parse(event);
    emit({
      type: 'read',
      conversationId: (d.conversationId as string) ?? null,
      relationId: (d.relationId as string) ?? null,
    });
  }) as EventListener);
  es.addEventListener('notification', (() => emit({ type: 'notification' })) as EventListener);
  // The server hit its per-user connection cap: this tab gets polling.
  es.addEventListener('unavailable', (() => fallbackToPolling()) as EventListener);

  es.onerror = () => {
    // readyState CLOSED means EventSource has given up (a non-2xx answer, e.g.
    // the 503 cap or an expired session); CONNECTING means it is retrying on its
    // own and we should let it.
    if (es.readyState === EventSource.CLOSED) fallbackToPolling();
  };
}

function onVisibilityChange() {
  if (document.visibilityState !== 'visible' || subscribers.size === 0) return;
  // Coming back from the background: the socket may have died silently and the
  // timers certainly stalled, so ask for everything again right now.
  if (!source) openStream();
  if (pollTimer) void pollOnce();
  emit({ type: 'tick' });
}

/**
 * Subscribe to live signals. Returns the unsubscribe function; the underlying
 * connection is opened on the first subscriber and closed after the last one.
 */
export function subscribeRealtimeClient(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  if (!visibilityBound && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onVisibilityChange);
    visibilityBound = true;
  }
  if (!source && !pollTimer) openStream();

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    closeStream();
    stopPolling();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (visibilityBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onVisibilityChange);
      visibilityBound = false;
    }
  };
}
