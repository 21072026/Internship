// The broker half of the realtime bus (#1698): Redis pub/sub on one channel,
// so an event published in one replica reaches SSE connections held by another.
//
// Same stance as the shared rate-limit store (src/lib/rateLimitRedis.ts, whose
// RESP encoder/parser this reuses): no client library — PUBLISH, SUBSCRIBE,
// AUTH and SELECT on two plain sockets are the whole surface — and the broker
// can never take the app down. A publish while disconnected is dropped (the
// publishing replica already delivered locally, and every stream re-checks its
// counters against the database on each heartbeat); a dead connection redials
// with backoff; the degrade is logged once, the recovery once.
//
// Loaded lazily by realtimeBus.ts only when REALTIME_REDIS_URL is set, so an
// install without a broker never imports node:net.
import net from 'node:net';
import tls from 'node:tls';
import { encodeCommand, parseReply } from './rateLimitRedis';
import { reconnectDelayMs } from './realtimeBrokerRule';

const CONNECT_TIMEOUT_MS = 2_000;

export interface RealtimeBrokerLogger {
  warning(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

export interface RealtimeBrokerOptions {
  url: string;
  channel: string;
  /** Called with the raw payload of every message on the channel (our own included). */
  onMessage: (payload: string) => void;
  logger?: RealtimeBrokerLogger;
  connectTimeoutMs?: number;
}

export interface RealtimeBroker {
  /** Fire and forget; dropped while disconnected. */
  publish(payload: string): void;
  /** True while both the publishing and the subscribed connection are up. */
  connected(): boolean;
  close(): void;
}

/** Never the URL itself — it carries the password. */
function redact(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/rediss?:\/\/\S+/gi, 'redis://[redacted]').slice(0, 200);
}

interface Conn {
  socket: net.Socket;
  ready: Promise<void>;
}

/** Opens one socket, runs AUTH/SELECT, resolves when it is usable. `onPush` sees every later reply. */
function openConn(url: string, timeoutMs: number, onPush: (value: unknown) => void, onDown: (err: Error) => void): Conn {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'rediss:';
  const host = parsed.hostname || '127.0.0.1';
  const port = Number(parsed.port || 6379);
  const username = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  const db = parsed.pathname.replace(/^\//, '');
  const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  socket.setNoDelay(true);
  // The broker must never hold `next build` or a one-shot script open.
  socket.unref();

  const handshake: string[][] = [];
  if (password) handshake.push(username ? ['AUTH', username, password] : ['AUTH', password]);
  if (db && db !== '0') handshake.push(['SELECT', db]);
  let awaiting = handshake.length;
  let buffer: Buffer = Buffer.alloc(0);
  let down = false;

  let settle!: (err?: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve());
  });
  ready.catch(() => {});
  const timer = setTimeout(() => fail(new Error(`realtime broker connect timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref();

  function fail(err: Error) {
    if (down) return;
    down = true;
    clearTimeout(timer);
    settle(err);
    socket.destroy();
    onDown(err);
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      let next;
      try {
        next = parseReply(buffer, 0);
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (!next) return;
      buffer = buffer.subarray(next.next);
      if (awaiting > 0) {
        awaiting -= 1;
        if (next.value instanceof Error) return fail(next.value);
        if (awaiting === 0) {
          clearTimeout(timer);
          settle();
        }
        continue;
      }
      onPush(next.value);
    }
  });
  socket.on('error', (e: Error) => fail(e));
  socket.on('close', () => fail(new Error('realtime broker connection closed')));
  socket.on(secure ? 'secureConnect' : 'connect', () => {
    if (handshake.length === 0) {
      clearTimeout(timer);
      settle();
      return;
    }
    socket.write(Buffer.concat(handshake.map(encodeCommand)));
  });
  return { socket, ready };
}

export function startRealtimeBroker(opts: RealtimeBrokerOptions): RealtimeBroker {
  const timeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  let pub: Conn | null = null;
  let sub: Conn | null = null;
  let up = false;
  let closed = false;
  let failures = 0;
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const teardown = () => {
    pub?.socket.destroy();
    sub?.socket.destroy();
    pub = sub = null;
    up = false;
  };

  const down = (gen: number, err: Error) => {
    if (gen !== generation || closed) return;
    generation += 1; // the other socket's close must not schedule a second redial
    const wasUp = up;
    teardown();
    failures += 1;
    if (wasUp || failures === 1) {
      opts.logger?.warning('realtime broker unavailable — delivery is local to this replica until it returns', {
        error: redact(err),
      });
    }
    retry = setTimeout(connect, reconnectDelayMs(failures));
    retry.unref();
  };

  function connect() {
    if (closed) return;
    const gen = ++generation;
    const onDown = (err: Error) => down(gen, err);
    pub = openConn(opts.url, timeoutMs, () => {}, onDown);
    sub = openConn(
      opts.url,
      timeoutMs,
      (value) => {
        // A pub/sub push is ['message', channel, payload]; the SUBSCRIBE ack is ['subscribe', …].
        if (Array.isArray(value) && value[0] === 'message' && typeof value[2] === 'string') {
          try {
            opts.onMessage(value[2]);
          } catch {
            /* a bad listener must not kill the subscription */
          }
        }
      },
      onDown,
    );
    Promise.all([pub.ready, sub.ready]).then(
      () => {
        if (gen !== generation || closed) return;
        sub!.socket.write(encodeCommand(['SUBSCRIBE', opts.channel]));
        up = true;
        if (failures > 0) opts.logger?.info('realtime broker reconnected — cross-replica delivery restored');
        failures = 0;
      },
      () => {
        /* onDown already scheduled the redial */
      },
    );
  }

  connect();

  return {
    publish(payload) {
      if (!up || !pub) return;
      pub.socket.write(encodeCommand(['PUBLISH', opts.channel, payload]));
    },
    connected: () => up,
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      teardown();
    },
  };
}
