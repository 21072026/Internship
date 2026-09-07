// Single-owner leases for background work (#1701).
//
// The problem, stated once: two app replicas run the same code, so every piece
// of in-process background work runs TWICE. For the request path and for the
// job worker that is fine or even desirable (`SKIP LOCKED` means more workers
// are better). For two jobs it is a bug you cannot take back:
//
//   'scheduler'   — two crons send every reminder twice.
//   'imap-bridge' — two pollers race over the `\Seen` flag on one mailbox, so a
//                   reply is imported twice or silently dropped.
//
// A lease gives those exactly one owner, with no election protocol and no new
// service: one `JobLease` row per NAME (the primary key), a `holder`, and an
// `expiresAt` a short way into the future. This module owns the RULES; the row
// access sits behind `LeaseStore` so the rules can be unit-tested without a
// database (`scripts/test/job-lease.test.mjs`).
//
// FOUR RULES, and each one exists because the obvious alternative is wrong.
//
// 1. EXPIRY, NEVER A MANUAL RELEASE. A replica that is SIGKILLed, OOM-killed or
//    merely wedged releases nothing — a lease that only a `finally` block can
//    free is a lease that is held forever the first time a container dies. So
//    the lease expires on its own and the holder keeps it by RENEWING well
//    inside the TTL. `releaseLease()` exists for the graceful case and is an
//    optimisation, not the mechanism.
// 2. ONE CONDITIONAL UPDATE, NEVER read-then-write. Every transition is a
//    single `UPDATE … WHERE name = ? AND <precondition>`; the precondition is
//    the thing that makes it safe ("still mine" for a renewal, "expired" for a
//    steal). MySQL locks the row for the update and re-evaluates the WHERE
//    against the committed value, so of two contenders exactly one can match —
//    the same shape as the trusted-device token rotation. A read followed by an
//    unconditional write lets both replicas believe they won.
// 3. LOSING IS QUIET. A replica that does not hold the lease does NOTHING: no
//    throw, no error log, no 500. Exactly one replica is *supposed* to lose, so
//    a lost lease is normal operation and must not page anyone. Only a
//    transition (took it / lost it) is worth a line in the log.
// 4. FAILING TO REACH THE DATABASE MEANS "NOT THE HOLDER". If the store errors,
//    `holdsLease()` answers false and the work is skipped. That is the safe
//    direction for both jobs here: a skipped reminder mails late, a duplicate
//    reminder cannot be unmailed.
//
// SCOPE NOTE (#1676): #1701 was written expecting #1676 to land this primitive
// first, under the name 'scheduler'. It has not, so the primitive lives here
// with both names reserved — #1676 keeps the *schedule registry* and simply
// calls `holdsLease(SCHEDULER_LEASE, …)` around the tick it already registers.
// There must never be a second lease table or a second election mechanism.
//
// This module deliberately has NO static imports, for the same reason
// `src/lib/rateLimitStore.ts` has none: the unit test loads it directly with
// `node --test --experimental-strip-types`, which resolves neither the `@/`
// alias nor an extensionless relative TypeScript path. The Prisma-backed store
// is loaded lazily, and the logger is injected.

export interface LeaseLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warning(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

let logger: LeaseLogger = {
  info: (message, context) => console.log(`[INFO] ${message}`, context ?? {}),
  warning: (message, context) => console.warn(`[WARNING] ${message}`, context ?? {}),
  error: (message, context) => console.error(`[ERROR] ${message}`, context ?? {}),
};

export function setLeaseLogger(next: LeaseLogger): void {
  logger = next;
}

/** The two names that exist. A third one needs a reason, not just a string. */
export const SCHEDULER_LEASE = 'scheduler';
export const IMAP_BRIDGE_LEASE = 'imap-bridge';

export interface LeaseRow {
  name: string;
  holder: string;
  acquiredAt: Date;
  renewedAt: Date;
  expiresAt: Date;
  generation: number;
}

/** The WHERE clause of a conditional update, one optional AND per field. */
export interface LeaseCondition {
  holder?: string;
  notExpiredAt?: Date;
  expiredAt?: Date;
}

/**
 * Row access, kept to three primitives that map 1:1 onto SQL so the rules above
 * can be read off this interface.
 */
export interface LeaseStore {
  /** The row as it is, expired or not. Read-only; never used to decide a write. */
  read(name: string): Promise<LeaseRow | null>;
  /**
   * `INSERT` the first row for a lease. Resolves false — never throws — when a
   * row for that name already exists, which is how two replicas racing on an
   * empty table settle it: the primary key decides.
   */
  insert(row: LeaseRow): Promise<boolean>;
  /**
   * ONE conditional `UPDATE … WHERE name = ? AND <every given cond>`, resolving
   * true when it changed exactly one row. Every field is an AND clause, and the
   * clock always arrives as a parameter so the rules can be tested on a fake
   * one:
   *
   *   `holder`       — the row must still name this holder.
   *   `notExpiredAt` — `expiresAt > this instant` (the lease is still live).
   *   `expiredAt`    — `expiresAt <= this instant` (the lease is stealable).
   */
  update(
    name: string,
    cond: LeaseCondition,
    next: Partial<Omit<LeaseRow, 'name'>> & { bumpGeneration?: boolean }
  ): Promise<boolean>;
  /** Every lease this holder currently holds, for /api/health. */
  heldBy?(holder: string, now: Date): Promise<LeaseRow[]>;
}

export interface LeaseOptions {
  store?: LeaseStore;
  now?: () => number;
}

// ── Replica identity ────────────────────────────────────────────────────────
// "Which process holds the scheduler right now?" has to be answerable from
// outside, so the holder string has to identify a process and not just a host.
//
// REPLICA_ID is set by the deploy to the container name (`internship-crm`,
// `internship-crm-2`); under `--network=host` the container's hostname is the
// HOST's, so `os.hostname()` alone cannot tell two replicas apart. The pid is
// appended because a restarted container is a different holder: the lease it
// held before the restart must expire rather than be silently inherited by a
// process that knows nothing about the work in flight.
let cachedReplicaId: string | null = null;

export function replicaId(env: Record<string, string | undefined> = process.env): string {
  if (cachedReplicaId && env === process.env) return cachedReplicaId;
  const named = (env.REPLICA_ID || env.HOSTNAME || 'app').trim() || 'app';
  // VarChar(190); the pid suffix is what must survive a truncation.
  const id = `${named.slice(0, 160)}#${process.pid}`;
  if (env === process.env) cachedReplicaId = id;
  return id;
}

/** Just the replica's name, without the pid — what an operator recognises. */
export function replicaName(env: Record<string, string | undefined> = process.env): string {
  return (env.REPLICA_ID || env.HOSTNAME || 'app').trim() || 'app';
}

// ── The rules ───────────────────────────────────────────────────────────────

async function resolveStore(opts: LeaseOptions): Promise<LeaseStore> {
  if (opts.store) return opts.store;
  // Lazy so the unit test (which always injects a store) never resolves Prisma.
  const mod = await import('./leaseStore');
  return mod.prismaLeaseStore();
}

/**
 * Take the lease if it is free or expired; keep it if it is already ours.
 *
 * This is the whole API a tick-based job needs: call it at the top of every
 * tick and do the work only when it answers true. Renewal is not a separate
 * timer — the tick IS the renewal, which is why the TTL must comfortably exceed
 * the tick interval (`leaseTtlMs()` below).
 */
export async function holdsLease(
  name: string,
  holder: string,
  ttlMs: number,
  opts: LeaseOptions = {}
): Promise<boolean> {
  const now = new Date(opts.now ? opts.now() : Date.now());
  const expiresAt = new Date(now.getTime() + ttlMs);

  let store: LeaseStore;
  try {
    store = await resolveStore(opts);
  } catch (err) {
    // Rule 4: unreachable store ⇒ not the holder ⇒ do nothing.
    logger.error('Lease store unavailable — treating this replica as not the holder', {
      lease: name,
      error: String(err),
    });
    return false;
  }

  try {
    // 1. Renew: still ours AND not yet expired. The expiry half matters — a
    //    replica that was paused past its TTL must not renew a lease another
    //    replica has since taken, which is exactly the "two owners" case.
    if (await store.update(name, { holder, notExpiredAt: now }, { renewedAt: now, expiresAt })) {
      return true;
    }

    // 2. Steal: the row exists but expired. `holder` is deliberately NOT part
    //    of the condition here — this is the takeover path.
    if (
      await store.update(
        name,
        { expiredAt: now },
        { holder, acquiredAt: now, renewedAt: now, expiresAt, bumpGeneration: true }
      )
    ) {
      logger.info('Lease acquired', { lease: name, holder, ttlMs });
      return true;
    }

    // 3. First ever holder: no row at all. Losing this insert is not an error —
    //    it means another replica inserted first, which is the point.
    if (
      await store.insert({
        name,
        holder,
        acquiredAt: now,
        renewedAt: now,
        expiresAt,
        generation: 1,
      })
    ) {
      logger.info('Lease acquired', { lease: name, holder, ttlMs });
      return true;
    }

    // Somebody else holds a live lease. Rule 3: silence.
    return false;
  } catch (err) {
    logger.error('Lease check failed — treating this replica as not the holder', {
      lease: name,
      error: String(err),
    });
    return false;
  }
}

/**
 * Take the lease only if nobody live holds it. Same rules as `holdsLease`,
 * separate name for the reader: this is what a one-shot task calls.
 */
export const acquireLease = holdsLease;

/**
 * Extend a lease this holder already has. Returns false when the lease has
 * expired or changed hands — the caller must then STOP, not re-acquire, because
 * whatever it was doing may already be running elsewhere.
 */
export async function renewLease(
  name: string,
  holder: string,
  ttlMs: number,
  opts: LeaseOptions = {}
): Promise<boolean> {
  const now = new Date(opts.now ? opts.now() : Date.now());
  try {
    const store = await resolveStore(opts);
    return await store.update(
      name,
      { holder, notExpiredAt: now },
      { renewedAt: now, expiresAt: new Date(now.getTime() + ttlMs) }
    );
  } catch (err) {
    logger.error('Lease renewal failed', { lease: name, error: String(err) });
    return false;
  }
}

/**
 * Hand the lease back on a graceful shutdown so the other replica can pick the
 * work up in seconds instead of waiting out the TTL. Conditional on ownership:
 * a process that has already lost the lease must not free the new holder's.
 *
 * An optimisation, never the safety mechanism — see rule 1.
 */
export async function releaseLease(
  name: string,
  holder: string,
  opts: LeaseOptions = {}
): Promise<boolean> {
  const now = new Date(opts.now ? opts.now() : Date.now());
  try {
    const store = await resolveStore(opts);
    // Expire it in place rather than deleting the row: the history (who held
    // it, since when, how many times it changed hands) is the only record of a
    // flapping lease, and an empty table cannot show it.
    const ok = await store.update(name, { holder }, { expiresAt: now, renewedAt: now });
    if (ok) logger.info('Lease released', { lease: name, holder });
    return ok;
  } catch (err) {
    // Not worth failing a shutdown over: the TTL frees it anyway.
    logger.warning('Lease release failed — it will expire on its own', {
      lease: name,
      error: String(err),
    });
    return false;
  }
}

/** The row as it stands, for /api/health and for an operator asking "who?". */
export async function readLease(name: string, opts: LeaseOptions = {}): Promise<LeaseRow | null> {
  const store = await resolveStore(opts);
  return store.read(name);
}

export interface LeaseSnapshot {
  name: string;
  holder: string;
  mine: boolean;
  live: boolean;
  expiresAt: string;
  acquiredAt: string;
  generation: number;
}

/**
 * The lease state as /api/health reports it: every lease that exists, who holds
 * it, and whether that is this replica. Read from `JobLease` itself — there is
 * no parallel record to drift out of sync with the rows it describes.
 */
export async function leaseSnapshot(
  names: readonly string[] = [SCHEDULER_LEASE, IMAP_BRIDGE_LEASE],
  opts: LeaseOptions = {}
): Promise<LeaseSnapshot[]> {
  const store = await resolveStore(opts);
  const nowMs = opts.now ? opts.now() : Date.now();
  const me = replicaId();
  const rows = await Promise.all(names.map((name) => store.read(name)));
  const present = rows.filter((row): row is LeaseRow => row !== null);
  return present.map((row) => ({
    name: row.name,
    holder: row.holder,
    mine: row.holder === me,
    live: row.expiresAt.getTime() > nowMs,
    expiresAt: row.expiresAt.toISOString(),
    acquiredAt: row.acquiredAt.toISOString(),
    generation: row.generation,
  }));
}

/**
 * The TTL for a job that ticks every `intervalMs`.
 *
 * Three intervals, floored at a minute: long enough that a tick that runs slow
 * (an IMAP poll against a sluggish mailbox) does not drop the lease it is
 * holding — losing it mid-work is how two replicas end up in the same mailbox —
 * and short enough that a dead holder's work resumes in minutes.
 */
export function leaseTtlMs(intervalMs: number): number {
  return Math.max(60_000, Math.round(intervalMs * 3));
}

// ── An in-memory store: the reference semantics, and what the tests use ─────
//
// It is here rather than in the test file on purpose. The conditional-UPDATE
// contract is the entire safety argument, so it deserves one executable
// definition that both the tests and a future second backend read from.
export function createMemoryLeaseStore(): LeaseStore {
  const rows = new Map<string, LeaseRow>();
  return {
    read: async (name) => {
      const row = rows.get(name);
      return row ? { ...row } : null;
    },
    insert: async (row) => {
      if (rows.has(row.name)) return false; // primary key, not a check-then-act
      rows.set(row.name, { ...row });
      return true;
    },
    update: async (name, cond, next) => {
      const row = rows.get(name);
      if (!row) return false;
      // Every clause is an AND, evaluated against the row as committed — the
      // one property that makes two contenders resolve to one winner.
      if (cond.holder !== undefined && row.holder !== cond.holder) return false;
      if (cond.notExpiredAt !== undefined && row.expiresAt.getTime() <= cond.notExpiredAt.getTime()) {
        return false;
      }
      if (cond.expiredAt !== undefined && row.expiresAt.getTime() > cond.expiredAt.getTime()) {
        return false;
      }
      rows.set(name, {
        ...row,
        ...next,
        generation: next.bumpGeneration ? row.generation + 1 : row.generation,
        name,
      });
      return true;
    },
    heldBy: async (holder, now) =>
      [...rows.values()]
        .filter((row) => row.holder === holder && row.expiresAt.getTime() > now.getTime())
        .map((row) => ({ ...row })),
  };
}
