import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { unreadCounts, type UnreadCounts } from '@/lib/unreadCounts';
import {
  subscribeRealtime,
  connectionCount,
  MAX_CONNECTIONS_PER_USER,
  type RealtimeEvent,
} from '@/lib/realtimeBus';
import { logger } from '@/lib/logger';

/**
 * Live message stream (#1464) — Server-Sent Events.
 *
 * Why SSE and not a WebSocket/SignalR-style channel: everything the messaging
 * screens need is one-directional (server → client "something changed, refetch"),
 * and SSE is that over plain HTTP — so it survives the Plesk/nginx reverse proxy
 * with one header, `EventSource` reconnects on its own with no client-side
 * backoff to write, and it adds no dependency and no process to run. Sending is
 * still an ordinary `POST /api/messages`, which is where the authorization,
 * validation and attachment handling already live.
 *
 * The stream carries *signals*, never message bodies: a client that hears
 * `message` refetches the thread through the normal authorized endpoint. That
 * keeps one code path for reading a thread (including its read-marking) and means
 * this route can never become a second, weaker way to read someone's messages.
 *
 * Two things keep it honest:
 *   - a heartbeat every {@link HEARTBEAT_MS}, which is also what stops an idle
 *     proxy from reaping the connection (nginx's `proxy_read_timeout` defaults to
 *     60s);
 *   - a database re-check of the unread counters on each heartbeat, so a missed
 *     bus event (a second replica, a publisher that crashed mid-write) self-heals
 *     within one beat instead of leaving a stale badge.
 */

// Route handlers holding a stream must not be statically evaluated, and the bus
// is a Node-process singleton — neither survives the edge runtime.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 25_000;
// A burst of publishes (a notification row plus the message it announces, or a
// group chat's fan-out) is answered with one counter refresh, not one per event.
const COALESCE_MS = 200;
// Browsers reconnect on their own; this is the delay we ask them to use.
const CLIENT_RETRY_MS = 10_000;
// Nothing lives forever behind a proxy. Closing the stream ourselves at a known
// age means the reconnect happens at a moment we chose, with a fresh session
// check, rather than as a surprise mid-conversation.
const MAX_STREAM_MS = 30 * 60_000;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response('Unauthorized', { status: 401 });
  const userId = session.user.id;

  // Refuse rather than hold an unbounded number of sockets for one account. The
  // client treats 503 as "stream unavailable" and falls back to polling, which
  // is exactly the right outcome for a 7th tab.
  if (connectionCount(userId) >= MAX_CONNECTIONS_PER_USER) {
    return new Response('Too many streams', { status: 503, headers: { 'Retry-After': '60' } });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Declared before cleanup() so the teardown can cancel a coalesced
      // counts refresh that is still waiting on its timer.
      let countsPending: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        if (countsPending) clearTimeout(countsPending);
        try {
          controller.close();
        } catch {
          /* already closed by the client going away */
        }
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client is gone and the stream was torn down under us.
          cleanup();
        }
      };

      const emit = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Last counts we told this client, so the heartbeat only speaks when
      // something actually moved.
      let lastCounts: UnreadCounts | null = null;
      const readCounts = async (reason: 'ready' | 'sync') => {
        try {
          const counts = await unreadCounts(userId);
          if (
            reason === 'ready' ||
            !lastCounts ||
            counts.messages !== lastCounts.messages ||
            counts.notifications !== lastCounts.notifications
          ) {
            lastCounts = counts;
            emit(reason === 'ready' ? 'ready' : 'unread', counts);
          }
        } catch (e) {
          logger.error('Realtime stream failed to read unread counts', { error: String(e) });
        }
      };

      // One new message publishes two events (the notification row, then the
      // message itself), and a group chat can publish a burst. Coalescing means
      // that costs one pair of COUNTs instead of one per event.
      const pushCounts = (reason: 'ready' | 'sync') => {
        if (reason === 'ready') {
          void readCounts('ready');
          return;
        }
        if (countsPending) return;
        countsPending = setTimeout(() => {
          countsPending = null;
          void readCounts('sync');
        }, COALESCE_MS);
      };

      write(`retry: ${CLIENT_RETRY_MS}\n\n`);
      pushCounts('ready');

      unsubscribe = subscribeRealtime(userId, (event: RealtimeEvent) => {
        // Forward the signal first — the open thread should repaint before we
        // have finished counting badges — then refresh the counters.
        emit(event.type, {
          conversationId: event.conversationId ?? null,
          relationId: event.relationId ?? null,
          senderId: event.senderId ?? null,
        });
        pushCounts('sync');
      });
      // Lost the race against the per-user cap between the check above and here.
      if (!unsubscribe) {
        emit('unavailable', { reason: 'too-many-streams' });
        cleanup();
        return;
      }

      heartbeat = setInterval(() => {
        // A comment line is a no-op for EventSource but real bytes on the wire,
        // which is what keeps proxies and phone radios from dropping us.
        write(`: ping\n\n`);
        pushCounts('sync');
      }, HEARTBEAT_MS);

      lifetime = setTimeout(cleanup, MAX_STREAM_MS);
      request.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      if (lifetime) clearTimeout(lifetime);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // `no-transform` is doing real work here: Next's response compression
      // honours it, and without that the whole stream sits in a gzip buffer.
      'Cache-Control': 'private, no-cache, no-store, no-transform, must-revalidate',
      Connection: 'keep-alive',
      // nginx (Plesk's reverse proxy) buffers proxied responses by default,
      // which turns an SSE stream into a request that simply never answers.
      'X-Accel-Buffering': 'no',
    },
  });
}
