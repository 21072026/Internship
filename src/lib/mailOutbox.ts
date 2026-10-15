import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { seal, open } from '@/lib/secretBox';
import { runUnscoped } from '@/lib/tenantAmbient';
import { claim, enqueue, reapExpiredLeases, DEFAULT_LEASE_MS, type JobRecord } from '@/lib/jobs/queue';
import { prismaQueueStore } from '@/lib/jobs/queueStore';
import type { JobPayloadMap } from '@/lib/jobs/types';
import { replicaId } from '@/lib/jobs/lease';
import { emailGroupAllowed, isEmailGroupId, isEssentialGroup } from '@/lib/emailGroups';
import {
  budgetConfig,
  budgetNameFor,
  classifySmtpError,
  dedupeKeyFor,
  lanePriority,
  recipientHash,
  type BudgetConfig,
  type MailChannel,
} from '@/lib/mailDeliveryRule';
import {
  DRAIN_BATCH,
  DRAIN_MAX_MS,
  MAIL_JOB_NAME,
  MAIL_MAX_ATTEMPTS,
  MAIL_PAYLOAD_VERSION,
  breakerWaitMs,
  decodeEnvelope,
  encodeEnvelope,
  isExpired,
  mailPolicy,
  notAfterFor,
  queueable,
  settleAction,
  type Envelope,
} from '@/lib/mailWorkerRule';
import * as budgetStore from '@/lib/mailBudgetStore';
import type { PreparedEmail } from '@/services/emailService';

// The mail outbox (#2944): a queued mail is a `Job` named 'email.send', and
// this module is the only reader and writer of those rows.
//
// WHAT GOES IN
//   `sendEmail()` (src/services/emailService.ts) queues a mail when a send
//   failed temporarily (any lane), when a critical send outlived its inline
//   cap, when the relay is paused (critical mail skips the doomed attempt), and
//   — once `MAIL_QUEUE_LANES` names a lane — every mail of that lane. The whole
//   prepared mail is sealed with `secretBox` ('mail-outbox'): it carries reset
//   links and message bodies, so a database dump must not read them. The
//   address itself is never in the clear on the row: `rcpt` is its sha256,
//   which is what account erasure deletes by. The box is set to null in the
//   same statement that writes any terminal state.
//
// WHO DRAINS IT
//   `drainOnce()`, called by POST /api/mail/drain, which `instrumentation.ts`
//   ticks every 5 s on EVERY replica. Rows are claimed with `SKIP LOCKED`
//   (`claim({ names: ['email.send'] })`), so more workers are simply more
//   workers: the drain NEVER takes a JobLease (CLAUDE.md § single-owner work).
//   The pace across replicas is the shared budget's (`MailBudget`), which is a
//   meter, not a lease.
//
// PER ROW, IN THIS ORDER
//   1. open the box (unreadable → DEAD_LETTER: nothing can ever send it);
//   2. `notAfter` passed → CANCELLED, "expired";
//   3. budget: `enforce` spends a token or releases the row and stops the tick;
//      `observe` only stops behind an open breaker (a paused relay) and charges
//      the meter; `off` does neither;
//   4. the preference gate again — a queued mail may be hours old, and the
//      reader may have switched the group off since;
//   5. deliver through the pooled drain transport;
//   6. settle (`settleAction()` in mailWorkerRule.ts) with ONE guarded
//      `updateMany` on `{ id, status: RUNNING, lockedBy: me }`: a row the
//      reaper handed to somebody else is not written over.
//   A relay-wide failure is not charged to the message: the row goes back to
//   PENDING with `attempts` unchanged, the budget is paused, the rest of the
//   claimed batch is released and the tick stops.
//
// DELIVERY IS AT-LEAST-ONCE (src/lib/jobs/queue.ts): a container killed between
// the relay's 250 and the settle sends that mail again after the lease expires.
// That window is one statement wide and is accepted.
//
// LOGS carry the job id, lane, category and a reason code — never an address,
// a subject or the relay's text (which can echo an address).

const SEAL_PURPOSE = 'mail-outbox';

// The Prisma half of the queue, passed explicitly rather than left to
// `queue.ts`'s lazy import: this module is server-only anyway, and an explicit
// store is the same object in every runtime that loads it.
let storeInstance: ReturnType<typeof prismaQueueStore> | null = null;
function store() {
  storeInstance ??= prismaQueueStore();
  return storeInstance;
}
const JOB_NAMES = [MAIL_JOB_NAME] as const;

export type MailJobPayload = JobPayloadMap['email.send'];

/** Why a mail was put on the queue — written to the row, read by operators. */
export type QueueReason = 'retry' | 'inline_timeout' | 'breaker' | 'lane';

export interface EnqueueMailOptions {
  reason: QueueReason;
  /** A natural de-duplication key (`dedupeKeyFor()`); a hashed one otherwise. */
  dedupeKey?: string | null;
  /** The caller's own deadline; the lane's maximum age caps it. */
  notAfter?: Date | null;
  /** Earliest moment the drain may take it (default: now). */
  runAt?: Date;
  /** Distinguishes two mails without a natural key (see `fallbackRef()`). */
  ref?: string | null;
  priority?: number;
  now?: Date;
}

/** Not every mail can be queued: one whose attachments exceed the cap is sent
 *  inline only (`MAX_QUEUED_ATTACHMENT_BYTES`). */
export function canQueue(prepared: PreparedEmail): boolean {
  return queueable(prepared as unknown as Envelope);
}

/**
 * Put one prepared mail on the queue. Idempotent on the de-duplication key: the
 * same logical mail queued twice is one row (the existing one is returned).
 * Throws when the mail cannot be queued (too large, no server secret, the
 * database is down) — every caller then falls back to what it did before the
 * queue existed.
 */
export async function enqueueMail(prepared: PreparedEmail, opts: EnqueueMailOptions): Promise<JobRecord> {
  if (!canQueue(prepared)) throw new Error('mail_outbox: attachments too large to queue');
  const now = opts.now ?? new Date();
  const notAfter = notAfterFor(prepared.lane, now, opts.notAfter);
  const payload: MailJobPayload = {
    v: MAIL_PAYLOAD_VERSION,
    lane: prepared.lane,
    category: prepared.category ?? null,
    group: prepared.group ?? null,
    userId: prepared.userId ?? null,
    orgId: prepared.orgId ?? null,
    world: prepared.world ?? null,
    rcpt: recipientHash(prepared.to),
    notAfter: notAfter.toISOString(),
    reason: opts.reason,
    ref: opts.ref ?? null,
    box: seal(encodeEnvelope(prepared as unknown as Envelope), SEAL_PURPOSE),
  };
  const idempotencyKey =
    opts.dedupeKey ??
    dedupeKeyFor({ kind: 'fallback', category: prepared.category, to: prepared.to, subject: prepared.subject, ref: opts.ref, at: now });
  return runUnscoped(() =>
    enqueue(MAIL_JOB_NAME, payload, {
      store: store(),
      runAt: opts.runAt ?? now,
      priority: opts.priority ?? lanePriority(prepared.lane, prepared.category),
      maxAttempts: MAIL_MAX_ATTEMPTS,
      idempotencyKey,
      // Explicit, never inherited: `Job` is in TENANT_MODELS, and a mail is the
      // recipient's tenant's, not whoever's request happened to send it.
      orgId: prepared.orgId ?? null,
    }),
  );
}

/**
 * Withdraw a queued copy that has not been taken yet (a critical send that
 * outlived its inline cap and then went through after all). True when this
 * call cancelled it; false when the drain already took it (or it is gone).
 */
export async function cancelQueuedMail(job: Pick<JobRecord, 'id' | 'payload'>, reason = 'sent_inline'): Promise<boolean> {
  const { count } = await runUnscoped(() =>
    prisma.job.updateMany({
      where: { id: job.id, name: MAIL_JOB_NAME, status: 'PENDING' },
      data: { status: 'CANCELLED', lastError: reason, payload: clearedPayload(job.payload) },
    }),
  );
  return count === 1;
}

function clearedPayload(payload: unknown): Prisma.InputJsonValue {
  const base = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  return { ...base, box: null } as Prisma.InputJsonValue;
}

/**
 * Account erasure: every queued mail to this address, whatever its state. When
 * the address still belongs to another account (another world), only the
 * erased account's own rows go. Returns how many rows were deleted.
 */
export async function forgetQueuedMail(address: string, opts: { onlyUserId?: string } = {}): Promise<number> {
  const rcpt = recipientHash(address);
  return runUnscoped(async () => {
    if (opts.onlyUserId) {
      return prisma.$executeRaw`
        DELETE FROM \`Job\`
         WHERE name = ${MAIL_JOB_NAME}
           AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.rcpt')) = ${rcpt}
           AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.userId')) = ${opts.onlyUserId}`;
    }
    return prisma.$executeRaw`
      DELETE FROM \`Job\`
       WHERE name = ${MAIL_JOB_NAME}
         AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.rcpt')) = ${rcpt}`;
  });
}

// ── The drain ───────────────────────────────────────────────────────────────

export interface DrainSummary {
  claimed: number;
  sent: number;
  retried: number;
  released: number;
  dead: number;
  expired: number;
  unsubscribed: number;
  reaped: number;
  /** Why the tick ended: no due rows, the budget, the breaker, the relay, the clock. */
  stoppedBy: 'empty' | 'budget' | 'breaker' | 'relay' | 'deadline' | 'error' | 'disabled' | 'unconfigured';
}

/** The delivery half a drain uses: the transport and the ledger —
 *  `mailDrainDeps()` in emailService.ts. Passed in by the caller so this module
 *  never imports emailService (which imports it). */
export interface DrainDeps {
  transmit(envelope: Envelope): Promise<void>;
  record(envelope: Envelope, status: 'SENT' | 'FAILED' | 'SKIPPED' | 'DEFERRED', error?: string): Promise<void>;
  /** Observe mode: the meter sees the send (charged, `would_refuse` logged). */
  observe(envelope: Envelope): void;
  /** A final failure: the delivery-health alert's trigger. */
  finalFailure(envelope: Envelope): void;
}

export interface DrainOptions {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  workerId?: string;
  maxMs?: number;
  /** The transport and ledger: `mailDrainDeps()` from emailService. */
  deps: DrainDeps;
  /** Budget row per channel; tests use their own. */
  budgetName?: (channel: MailChannel) => string;
}

let lastReapAt = 0;

/**
 * One tick of the drain: claim due 'email.send' rows and deliver them until the
 * queue is empty, the budget or the relay says stop, or `maxMs` runs out.
 * Never throws for a row; a database error on the claim itself propagates.
 */
export async function drainOnce(opts: DrainOptions): Promise<DrainSummary> {
  const env = opts.env ?? process.env;
  const clock = opts.now ?? (() => new Date());
  const deadline = Date.now() + Math.max(1_000, opts.maxMs ?? DRAIN_MAX_MS);
  const workerId = (opts.workerId ?? `mail:${replicaId()}`).slice(0, 64);
  const nameFor = opts.budgetName ?? budgetNameFor;
  const summary: DrainSummary = {
    claimed: 0,
    sent: 0,
    retried: 0,
    released: 0,
    dead: 0,
    expired: 0,
    unsubscribed: 0,
    reaped: 0,
    stoppedBy: 'empty',
  };
  // Nothing to send with (demo, an environment without SMTP, the e2e server):
  // the rows wait — they were queued while a relay was configured, and a drain
  // that tried would only fail every one of them.
  if (!mailPolicy(env).workerEnabled) return { ...summary, stoppedBy: 'disabled' };
  if (!env.SMTP_USER) return { ...summary, stoppedBy: 'unconfigured' };
  const deps = opts.deps;
  const configs = new Map<MailChannel, BudgetConfig>();
  const configFor = (channel: MailChannel) => {
    let c = configs.get(channel);
    if (!c) {
      c = budgetConfig(env, channel);
      configs.set(channel, c);
    }
    return c;
  };

  return runUnscoped(async () => {
    // A worker that died mid-row left its claim RUNNING; the clock frees it.
    // Once a minute is plenty — the lease itself is five minutes.
    if (Date.now() - lastReapAt > 60_000) {
      lastReapAt = Date.now();
      summary.reaped = await reapExpiredLeases(DEFAULT_LEASE_MS, { names: [...JOB_NAMES], store: store() });
    }

    while (Date.now() < deadline) {
      const rows = await claim(workerId, { names: [...JOB_NAMES], limit: DRAIN_BATCH, leaseMs: DEFAULT_LEASE_MS, store: store() });
      if (rows.length === 0) {
        summary.stoppedBy = 'empty';
        return summary;
      }
      summary.claimed += rows.length;
      for (let i = 0; i < rows.length; i++) {
        const rest = rows.slice(i + 1);
        let stop: Stop;
        try {
          stop = await drainRow(rows[i], { workerId, clock, deps, configFor, nameFor, summary });
        } catch (e) {
          // A database error mid-row (the settle, the budget): put this row and
          // the rest of the batch back rather than leave them RUNNING until
          // the reaper's five minutes are up, and end the tick — the next one
          // is five seconds away. Not charged: nothing says the mail was at fault.
          logger.error('mail_outbox.row_failed', { jobId: rows[i].id, error: e instanceof Error ? e.name : 'unknown' });
          await releaseRows([rows[i], ...rest], workerId, new Date(clock().getTime() + 30_000)).catch(() => {});
          summary.stoppedBy = 'error';
          return summary;
        }
        if (stop) {
          await releaseRows(rest, workerId, stop.runAt);
          summary.stoppedBy = stop.reason;
          return summary;
        }
        if (Date.now() >= deadline && rest.length) {
          await releaseRows(rest, workerId, clock());
          summary.stoppedBy = 'deadline';
          return summary;
        }
      }
    }
    summary.stoppedBy = 'deadline';
    return summary;
  });
}

interface RowContext {
  workerId: string;
  clock: () => Date;
  deps: DrainDeps;
  configFor: (channel: MailChannel) => BudgetConfig;
  nameFor: (channel: MailChannel) => string;
  summary: DrainSummary;
}

type Stop = { reason: 'budget' | 'breaker' | 'relay'; runAt: Date } | null;

function payloadOf(row: JobRecord): MailJobPayload | null {
  const p = row.payload as Partial<MailJobPayload> | null;
  if (!p || typeof p !== 'object' || p.v !== MAIL_PAYLOAD_VERSION || typeof p.box !== 'string') return null;
  return p as MailJobPayload;
}

async function drainRow(row: JobRecord, ctx: RowContext): Promise<Stop> {
  const { workerId, clock, deps, summary } = ctx;
  const now = clock();
  const log = { jobId: row.id };
  const payload = payloadOf(row);
  const envelope = payload ? decodeEnvelope(open(payload.box!, SEAL_PURPOSE)) : null;
  if (!payload || !envelope) {
    // A corrupt row, or one sealed under a server secret that has since been
    // rotated: nothing can ever send it. Dead, envelope gone.
    await settle(row, workerId, { status: 'DEAD_LETTER', lastError: 'unreadable_envelope', payload: clearedPayload(row.payload) });
    logger.error('mail_outbox.unreadable', log);
    summary.dead++;
    return null;
  }
  const meta = { ...log, lane: payload.lane, category: payload.category ?? undefined };

  if (isExpired(payload.notAfter, now)) {
    await settle(row, workerId, { status: 'CANCELLED', lastError: 'expired', payload: clearedPayload(payload) });
    await deps.record(envelope, 'FAILED', 'Expired in the mail queue before it could be delivered');
    logger.warning('mail_outbox.expired', meta);
    summary.expired++;
    return null;
  }

  // ── The budget ────────────────────────────────────────────────────────────
  const cfg = ctx.configFor(envelope.transport);
  const budget = ctx.nameFor(envelope.transport);
  if (cfg.mode === 'enforce') {
    const spent = await budgetStore.spendToken(envelope.lane, cfg, budget);
    if (!spent.allowed) {
      const runAt = new Date(now.getTime() + Math.max(1_000, spent.reason === 'db_error' ? 5_000 : spent.waitMs));
      await release(row, workerId, runAt);
      summary.released++;
      return { reason: 'budget', runAt };
    }
  } else if (cfg.mode === 'observe') {
    // Observe mode never refuses on rate — but a PAUSED relay (a throttle or a
    // refused session, not yet followed by a delivery) would refuse this
    // session too, so the breaker holds the drain in every mode but `off`.
    const state = await budgetStore.readBudgetState(budget).catch(() => null);
    const wait = breakerWaitMs(state, cfg, envelope.lane);
    if (wait > 0) {
      const runAt = new Date(now.getTime() + Math.max(1_000, wait));
      await release(row, workerId, runAt);
      summary.released++;
      return { reason: 'breaker', runAt };
    }
    deps.observe(envelope);
  }

  // ── The preference gate, again ────────────────────────────────────────────
  if (!(await stillWanted(payload.group, payload.userId))) {
    await settle(row, workerId, { status: 'CANCELLED', lastError: 'unsubscribed', payload: clearedPayload(payload) });
    await deps.record(envelope, 'SKIPPED', `Unsubscribed: ${payload.group}`);
    summary.unsubscribed++;
    return null;
  }

  // ── Deliver ───────────────────────────────────────────────────────────────
  let error: unknown = null;
  try {
    await deps.transmit(envelope);
  } catch (e) {
    error = e;
  }

  let pausedUntil: Date | null = null;
  if (cfg.mode !== 'off') {
    if (!error) {
      await budgetStore.decayPause(budget).catch(() => false);
    } else if (classifySmtpError(error).relayWide) {
      // Relay-wide: pause everybody, then read how long for.
      try {
        await budgetStore.pauseBudget(cfg, budget);
        const state = await budgetStore.readBudgetState(budget);
        if (state) pausedUntil = new Date(now.getTime() + Math.max(0, state.aheadMs));
      } catch {
        // The ladder's first rung (settleAction's floor) stands in.
      }
    }
  }

  const action = settleAction({
    error,
    lane: envelope.lane,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    notAfter: payload.notAfter,
    now,
    pausedUntil,
    ladderSec: cfg.ladderSec,
  });

  switch (action.kind) {
    case 'sent':
      await settle(row, workerId, {
        status: 'SUCCEEDED',
        attempts: row.attempts + 1,
        lastError: null,
        payload: clearedPayload(payload),
      });
      await deps.record(envelope, 'SENT');
      summary.sent++;
      return null;
    case 'release':
      await settle(row, workerId, { status: 'PENDING', runAt: action.runAt, lastError: action.reason });
      await deps.record(envelope, 'DEFERRED', errorText(error));
      logger.warning('mail_outbox.relay_paused', { ...meta, reason: action.reason, runAt: action.runAt.toISOString() });
      summary.released++;
      return { reason: 'relay', runAt: action.runAt };
    case 'retry':
      await settle(row, workerId, {
        status: 'PENDING',
        runAt: action.runAt,
        attempts: action.attempts,
        lastError: action.reason,
      });
      await deps.record(envelope, 'DEFERRED', errorText(error));
      logger.info('mail_outbox.retry', { ...meta, reason: action.reason, attempts: action.attempts });
      summary.retried++;
      return null;
    case 'dead':
      await settle(row, workerId, {
        status: action.status,
        attempts: action.attempts,
        lastError: action.reason,
        payload: clearedPayload(payload),
      });
      await deps.record(envelope, 'FAILED', errorText(error));
      deps.finalFailure(envelope);
      logger.error('mail_outbox.dead', { ...meta, status: action.status, reason: action.reason });
      summary.dead++;
      return null;
    case 'expired':
      await settle(row, workerId, {
        status: 'CANCELLED',
        attempts: action.attempts,
        lastError: action.reason,
        payload: clearedPayload(payload),
      });
      await deps.record(envelope, 'FAILED', `Expired in the mail queue: ${errorText(error)}`);
      logger.warning('mail_outbox.expired', { ...meta, reason: action.reason });
      summary.expired++;
      return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ONE guarded statement: only the worker that holds the claim writes it. */
async function settle(row: JobRecord, workerId: string, data: Prisma.JobUpdateManyMutationInput): Promise<void> {
  const { count } = await prisma.job.updateMany({
    where: { id: row.id, status: 'RUNNING', lockedBy: workerId },
    data: { ...data, lockedAt: null, lockedBy: null },
  });
  if (count !== 1) logger.warning('mail_outbox.settle_lost', { jobId: row.id });
}

async function release(row: JobRecord, workerId: string, runAt: Date): Promise<void> {
  await settle(row, workerId, { status: 'PENDING', runAt });
}

async function releaseRows(rows: JobRecord[], workerId: string, runAt: Date): Promise<void> {
  if (!rows.length) return;
  await prisma.job.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, status: 'RUNNING', lockedBy: workerId },
    data: { status: 'PENDING', runAt, lockedAt: null, lockedBy: null },
  });
}

/**
 * The central opt-out gate, re-run at send time. Same rule as `prepareEmail()`:
 * only a non-essential group with a known recipient is gated, and a lookup that
 * fails sends (fail open) — a preference read that breaks must not swallow mail.
 */
async function stillWanted(group: string | null, userId: string | null): Promise<boolean> {
  if (!group || !userId || !isEmailGroupId(group) || isEssentialGroup(group)) return true;
  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { emailNotifications: true, notificationPrefs: true } })
    .catch(() => null);
  return user ? emailGroupAllowed(user, group) : true;
}
