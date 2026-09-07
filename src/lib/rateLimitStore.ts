// The rate limiter's counter store (#1696).
//
// `src/lib/rateLimit.ts` owns the *decision* (fixed window, {ok, retryAfter});
// this module owns *where the count lives*. Two implementations:
//
//   memory  — a per-process `Map`. The default, and what a single-container
//             self-host gets with no configuration at all: the app must never
//             require a service the operator did not sign up for.
//   shared  — the same window arithmetic, but the authoritative count is an
//             INCR on a Redis the replicas have in common. Configured with
//             `RATE_LIMIT_REDIS_URL`; unset means "memory", exactly as before.
//
// Why it matters: the counter used to be per-process, so the moment a second
// replica exists every limit silently doubles (5 sign-in attempts becomes 10)
// and a redeploy resets them all to zero.
//
// TWO RULES THIS MODULE OBEYS
//
// 1. FAIL OPEN ON AVAILABILITY, NEVER ON CORRECTNESS. A store that is down must
//    not 500 a request and must not lock anyone out of sign-in. Every command
//    is fire-and-forget; a failure drops back to the in-memory mirror, which is
//    precisely today's behaviour. It is a degradation, so it is LOGGED — once
//    per outage, not per request. A limiter that quietly degrades is how a
//    brute-force window opens.
// 2. THE SIGNATURE STAYS SYNCHRONOUS. `rateLimit()` is called from synchronous
//    route guards in ~30 places. The shared store therefore decides from a
//    local mirror and reconciles it with the shared count on the reply, rather
//    than awaiting a round trip on the sign-in hot path. The cost of that is
//    bounded and known: a replica that has never seen a key can let through up
//    to one request before the first reply lands (per key, per window, per
//    replica). Two replicas with a limit of 5 therefore allow ~6, not 10.
//
// This module deliberately has NO imports: `scripts/test/rate-limit-store.test.mjs`
// loads it directly with `node --test --experimental-strip-types`, which resolves
// neither the `@/` alias nor an extensionless relative TypeScript path. The
// logger is therefore injected — `rateLimit.ts` wires the app's real one in at
// import time, and the console fallback below keeps a degradation loud even if
// some future caller forgets to.

export interface RateLimitStoreLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warning(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

let logger: RateLimitStoreLogger = {
  info: (message, context) => console.log(`[INFO] ${message}`, context ?? {}),
  warning: (message, context) => console.warn(`[WARNING] ${message}`, context ?? {}),
  error: (message, context) => console.error(`[ERROR] ${message}`, context ?? {}),
};

export function setRateLimitStoreLogger(next: RateLimitStoreLogger): void {
  logger = next;
}

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitStoreStatus {
  backend: 'memory' | 'shared';
  /** True while the shared store is unreachable and counting is per-process. */
  degraded: boolean;
  degradedSince: string | null;
  /** Sanitised transport error — never the URL, which carries credentials. */
  lastError: string | null;
}

/**
 * A counter store. Synchronous on purpose — see rule 2 above. A network-backed
 * implementation reads through a local mirror and writes behind it rather than
 * awaiting each hit.
 */
export interface RateLimitStore {
  get(key: string): RateLimitEntry | undefined;
  set(key: string, entry: RateLimitEntry): void;
  delete(key: string): void;
  size(): number;
  /** Drop entries whose window closed at or before `now`. */
  sweep(now: number): void;
  /** Operational state, for /api/health. Optional so test doubles stay tiny. */
  status?(): RateLimitStoreStatus;
}

const MEMORY_STATUS: RateLimitStoreStatus = {
  backend: 'memory',
  degraded: false,
  degradedSince: null,
  lastError: null,
};

export function createMemoryRateLimitStore(): RateLimitStore {
  const map = new Map<string, RateLimitEntry>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => void map.set(key, entry),
    delete: (key) => void map.delete(key),
    size: () => map.size,
    sweep: (now) => {
      for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
    },
    status: () => MEMORY_STATUS,
  };
}

/**
 * The fixed-window arithmetic, lifted out of `rateLimit()` unchanged so it can
 * be unit-tested against either store without pulling in `next/server`.
 */
export function countRequest(
  store: RateLimitStore,
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
  now: number = Date.now()
): { ok: boolean; retryAfter: number } {
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  entry.count += 1;
  // Written back explicitly: the memory store hands out the live object, but a
  // store that returns a copy (any out-of-process one) would otherwise lose it.
  store.set(key, entry);
  if (entry.count > limit) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/** A Redis reply we care about: an integer, a status/bulk string, or nil. */
export type RateLimitCommandReply = number | string | null;

/**
 * The wire, kept behind an interface so the store's logic is testable without a
 * socket — and so a different backend could be dropped in without touching the
 * fallback machinery.
 */
export interface RateLimitTransport {
  /** Run a pipeline; resolves to one reply per command, rejects on failure. */
  pipeline(commands: string[][]): Promise<RateLimitCommandReply[]>;
  close(): void;
}

export interface SharedRateLimitStoreOptions {
  connect: () => Promise<RateLimitTransport>;
  keyPrefix?: string;
  now?: () => number;
  /** Wait this long after a failed connect before dialling again. */
  reconnectDelayMs?: number;
  /** Test hook: fires alongside the log line, once per state change. */
  onEvent?: (event: { type: 'degraded' | 'recovered'; error?: string }) => void;
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Bounded and stripped of anything URL-shaped: this reaches /api/health.
  return raw.replace(/rediss?:\/\/\S+/gi, 'redis://[redacted]').slice(0, 200);
}

export function createSharedRateLimitStore(opts: SharedRateLimitStoreOptions): RateLimitStore {
  const mirror = createMemoryRateLimitStore();
  const now = opts.now ?? (() => Date.now());
  const prefix = opts.keyPrefix ?? 'rl:';
  const reconnectDelayMs = opts.reconnectDelayMs ?? 5_000;

  let transport: RateLimitTransport | null = null;
  let connecting: Promise<RateLimitTransport | null> | null = null;
  let nextConnectAt = 0;
  let degradedSince: number | null = null;
  let lastError: string | null = null;

  function degrade(err: unknown) {
    lastError = errorText(err);
    if (degradedSince === null) {
      degradedSince = now();
      logger.warning('Rate limit store unreachable — counting per-process until it returns', {
        error: lastError,
      });
      opts.onEvent?.({ type: 'degraded', error: lastError });
    }
    if (transport) {
      try {
        transport.close();
      } catch {
        // closing a dead socket is not news
      }
      transport = null;
    }
    nextConnectAt = now() + reconnectDelayMs;
  }

  function recover() {
    if (degradedSince === null) return;
    logger.info('Rate limit store reachable again — counters are shared once more', {
      degradedForMs: now() - degradedSince,
    });
    opts.onEvent?.({ type: 'recovered' });
    degradedSince = null;
    lastError = null;
  }

  function ensure(): Promise<RateLimitTransport | null> {
    if (transport) return Promise.resolve(transport);
    if (connecting) return connecting;
    // Back off between dials so a down store costs one connect per interval,
    // not one per request.
    if (now() < nextConnectAt) return Promise.resolve(null);
    connecting = opts
      .connect()
      .then((t) => {
        transport = t;
        recover();
        return t;
      })
      .catch((err) => {
        degrade(err);
        return null;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  }

  /** Never rejects: a store outage is invisible to the request that caused it. */
  async function run(commands: string[][]): Promise<RateLimitCommandReply[] | null> {
    const t = await ensure();
    if (!t) return null;
    try {
      const replies = await t.pipeline(commands);
      recover();
      return replies;
    } catch (err) {
      degrade(err);
      return null;
    }
  }

  function push(key: string, entry: RateLimitEntry) {
    const k = prefix + key;
    const ttl = Math.max(1, Math.round(entry.resetAt - now()));
    // One round trip, three commands: SET…NX opens the window (and only the
    // first replica to arrive wins, so the window stays fixed rather than
    // sliding), INCR is the authoritative count, PTTL tells every replica when
    // the window closes.
    void run([
      ['SET', k, '0', 'PX', String(ttl), 'NX'],
      ['INCR', k],
      ['PTTL', k],
    ]).then((replies) => {
      if (!replies) return;
      // Identity check: `entry` is the object that represents THIS window. A
      // reply that arrives after the window rolled (or after a successful login
      // cleared the key) must not resurrect a stale count.
      if (mirror.get(key) !== entry) return;
      const shared = Number(replies[1]);
      const pttl = Number(replies[2]);
      if (Number.isFinite(shared) && shared > entry.count) entry.count = shared;
      if (Number.isFinite(pttl) && pttl > 0) entry.resetAt = now() + pttl;
    });
  }

  return {
    get: (key) => mirror.get(key),
    set: (key, entry) => {
      mirror.set(key, entry);
      push(key, entry);
    },
    delete: (key) => {
      mirror.delete(key);
      // A successful login clears the failure counter — it has to clear the
      // shared one too, or the other replicas keep counting a user who is in.
      void run([['DEL', prefix + key]]);
    },
    size: () => mirror.size(),
    sweep: (n) => mirror.sweep(n),
    status: () => ({
      backend: 'shared',
      degraded: degradedSince !== null,
      degradedSince: degradedSince === null ? null : new Date(degradedSince).toISOString(),
      lastError,
    }),
  };
}

export interface RateLimitStoreSelection {
  backend: 'memory' | 'shared';
  store: RateLimitStore;
}

export interface SelectRateLimitStoreOverrides {
  /** Injected by the unit tests in place of a real socket. */
  connect?: (url: string) => Promise<RateLimitTransport>;
  shared?: Omit<SharedRateLimitStoreOptions, 'connect'>;
}

/**
 * Pick the backend from configuration.
 *
 * No URL → memory, which is byte-for-byte the old behaviour. A URL that is not
 * a redis one is a configuration mistake, not a reason to refuse traffic: it is
 * logged loudly and the limiter keeps working per-process.
 */
export function selectRateLimitStore(
  env: Record<string, string | undefined> = process.env,
  overrides: SelectRateLimitStoreOverrides = {}
): RateLimitStoreSelection {
  const url = (env.RATE_LIMIT_REDIS_URL || '').trim();
  if (!url) return { backend: 'memory', store: createMemoryRateLimitStore() };

  if (!/^rediss?:\/\//i.test(url)) {
    // Deliberately without the value: it carries a password.
    logger.error('RATE_LIMIT_REDIS_URL is not a redis:// or rediss:// URL — rate limits stay per-process');
    return { backend: 'memory', store: createMemoryRateLimitStore() };
  }

  const connect =
    overrides.connect ??
    // Loaded lazily so an install with no shared store never pays for the
    // socket client at all.
    ((u: string) => import('./rateLimitRedis').then((m) => m.connectRedisTransport(u)));

  return {
    backend: 'shared',
    store: createSharedRateLimitStore({ ...overrides.shared, connect: () => connect(url) }),
  };
}
