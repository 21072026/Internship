// The socket half of the shared rate-limit store (#1696): just enough RESP to
// run `SET … NX PX`, `INCR`, `PTTL` and `DEL`.
//
// Why not a client library: the whole surface this app needs is four commands
// on one connection, and a rate limiter must not be able to take the app down.
// A dependency here would be ~1 MB of reconnect/cluster/pubsub machinery whose
// failure modes we would then own anyway — the store above already has the only
// policy that matters (fail open, log once, retry later). Node's `net`/`tls` and
// ~150 lines are the smaller thing to reason about, and they are exercised by
// `scripts/test/rate-limit-store.test.mjs` against a real in-process server.
//
// Loaded lazily by `selectRateLimitStore()`, so an install with no
// `RATE_LIMIT_REDIS_URL` never imports it.
import net from 'node:net';
import tls from 'node:tls';
import type { RateLimitCommandReply, RateLimitTransport } from './rateLimitStore';

// This sits in front of sign-in. A store that is slow is worse than one that is
// absent, so both budgets are short and a breach degrades to the memory mirror.
const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 1_000;

function encodeCommand(command: string[]): Buffer {
  let out = `*${command.length}\r\n`;
  for (const arg of command) out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  return Buffer.from(out);
}

type ParsedValue = RateLimitCommandReply | Error | ParsedValue[];

/**
 * Parse one reply starting at `offset`. Returns null when the buffer holds a
 * partial reply (the socket will deliver the rest), and an `Error` *value* for
 * a `-ERR` line — that rejects one command, not the connection.
 */
function parseReply(buf: Buffer, offset: number): { value: ParsedValue; next: number } | null {
  if (offset >= buf.length) return null;
  const end = buf.indexOf('\r\n', offset);
  if (end === -1) return null;
  const type = buf[offset];
  const line = buf.toString('utf8', offset + 1, end);

  switch (type) {
    case 0x2b: // '+' simple string
      return { value: line, next: end + 2 };
    case 0x2d: // '-' error
      return { value: new Error(line), next: end + 2 };
    case 0x3a: // ':' integer
      return { value: Number(line), next: end + 2 };
    case 0x24: {
      // '$' bulk string
      const len = Number(line);
      if (len === -1) return { value: null, next: end + 2 };
      const start = end + 2;
      if (buf.length < start + len + 2) return null;
      return { value: buf.toString('utf8', start, start + len), next: start + len + 2 };
    }
    case 0x2a: {
      // '*' array — nothing we send returns one, but parsing it keeps a
      // surprise reply from desynchronising the queue.
      const count = Number(line);
      if (count === -1) return { value: null, next: end + 2 };
      const items: ParsedValue[] = [];
      let cursor = end + 2;
      for (let i = 0; i < count; i += 1) {
        const item = parseReply(buf, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`unexpected reply byte 0x${(type ?? 0).toString(16)}`);
  }
}

interface Pending {
  resolve: (value: RateLimitCommandReply) => void;
  reject: (err: Error) => void;
}

export function connectRedisTransport(
  url: string,
  opts: { connectTimeoutMs?: number; commandTimeoutMs?: number } = {}
): Promise<RateLimitTransport> {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'rediss:';
  const host = parsed.hostname || '127.0.0.1';
  const port = Number(parsed.port || 6379);
  const username = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  const db = parsed.pathname.replace(/^\//, '');
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const commandTimeoutMs = opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;

  return new Promise<RateLimitTransport>((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    socket.setNoDelay(true);
    // Never hold the process open for a counter: `next build`, a seed script or
    // a cron one-shot must still be able to exit.
    socket.unref();

    const pending: Pending[] = [];
    let buffer: Buffer = Buffer.alloc(0);
    let failure: Error | null = null;

    const connectTimer = setTimeout(
      () => fail(new Error(`rate limit store connect timed out after ${connectTimeoutMs}ms`)),
      connectTimeoutMs
    );
    connectTimer.unref();

    function fail(err: Error) {
      if (failure) return;
      failure = err;
      clearTimeout(connectTimer);
      while (pending.length) pending.shift()?.reject(err);
      socket.destroy();
      // A no-op once the transport has been handed out; the store notices
      // through the rejected pipeline instead.
      reject(err);
    }

    function drain() {
      for (;;) {
        let next: { value: ParsedValue; next: number } | null;
        try {
          next = parseReply(buffer, 0);
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (!next) return;
        buffer = buffer.subarray(next.next);
        const waiter = pending.shift();
        if (!waiter) continue; // unsolicited (e.g. a push message) — ignore
        if (next.value instanceof Error) waiter.reject(next.value);
        else waiter.resolve(Array.isArray(next.value) ? null : next.value);
      }
    }

    function pipeline(commands: string[][]): Promise<RateLimitCommandReply[]> {
      if (failure) return Promise.reject(failure);
      const replies = commands.map(
        () =>
          new Promise<RateLimitCommandReply>((res, rej) => {
            pending.push({ resolve: res, reject: rej });
          })
      );
      socket.write(Buffer.concat(commands.map(encodeCommand)));
      return new Promise<RateLimitCommandReply[]>((res, rej) => {
        const timer = setTimeout(() => {
          // A hung store is a dead store: drop the connection so the caller
          // degrades and the next window redials.
          fail(new Error(`rate limit store command timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
        timer.unref();
        Promise.all(replies).then(
          (value) => {
            clearTimeout(timer);
            res(value);
          },
          (err) => {
            clearTimeout(timer);
            rej(err);
          }
        );
      });
    }

    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      drain();
    });
    socket.on('error', (err: Error) => fail(err));
    socket.on('close', () => fail(new Error('rate limit store connection closed')));

    socket.on(secure ? 'secureConnect' : 'connect', () => {
      const handshake: Promise<unknown>[] = [];
      if (password) handshake.push(pipeline([username ? ['AUTH', username, password] : ['AUTH', password]]));
      if (db && db !== '0') handshake.push(pipeline([['SELECT', db]]));
      Promise.all(handshake).then(
        () => {
          clearTimeout(connectTimer);
          if (failure) return;
          resolve({ pipeline, close: () => socket.destroy() });
        },
        (err: unknown) => fail(err instanceof Error ? err : new Error(String(err)))
      );
    });
  });
}
