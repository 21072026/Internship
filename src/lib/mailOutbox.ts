import type { JobStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { seal, open } from '@/lib/secretBox';
import { runUnscoped } from '@/lib/tenantAmbient';
import { claim, enqueue, reapExpiredLeases, DEFAULT_LEASE_MS, type ClaimFilter, type JobRecord } from '@/lib/jobs/queue';
import { prismaQueueStore } from '@/lib/jobs/queueStore';
import type { JobPayloadMap } from '@/lib/jobs/types';
import { replicaId } from '@/lib/jobs/lease';
import { emailGroupAllowed, isEmailGroupId, isEssentialGroup } from '@/lib/emailGroups';
import { suppressedAmong } from '@/lib/emailSuppression';
import { normalizeSuppressedAddress, suppressedLogReason } from '@/lib/emailSuppressionRule';
import {
  HIGHER_LANE_MIN_PRIORITY,
  budgetConfig,
  budgetNameFor,
  bulkWorldOrder,
  classifySmtpError,
  dedupeKeyFor,
  lanePriority,
  queueEtaMinutes,
  recipientHash,
  unmailableRecipient,
  type BudgetConfig,
  type MailChannel,
} from '@/lib/mailDeliveryRule';
import { outcomeOfJob, settleMailRef, type MailRefOutcome } from '@/lib/mailRefHooks';
import { verticalFor } from '@/lib/verticalContext';
import { DEFAULT_VERTICAL } from '@/lib/verticals';
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
import { isAuthRejection, smtpReplyCodeOf } from '@/lib/mailOpsRule';
import { noteRelayAuthRejected } from '@/lib/mailOpsSignal';
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
//   3. budget: the breaker first in every mode but `off` — a relay pause that
//      has not run out (`MailBudget.pausedUntil`) releases the row to its end
//      and stops the tick; then `enforce` spends a token or releases the row
//      and stops, `observe` charges the meter; `off` does neither;
//   4. the preference gate again — a queued mail may be hours old, and the
//      reader may have switched the group off since;
//   5. deliver through the pooled drain transport;
//   6. settle (`settleAction()` in mailWorkerRule.ts) with ONE guarded
//      `updateMany` on `{ id, status: RUNNING, lockedBy: me }`: a row the
//      reaper handed to somebody else is not written over.
//   A FAILED (5xx) or DEAD_LETTER row KEEPS its sealed envelope until its own
//   `notAfter` (#2953), so an operator can retry it from the admin Queue tab;
//   `clearExpiredEnvelopes()` removes it from such a row once `notAfter` has
//   passed, at most a minute later. Every other terminal state clears the box
//   in the settle itself, as before.
//   A relay-wide failure is not charged to the message: the row goes back to
//   PENDING with `attempts` unchanged (every RELAY_RELEASES_PER_ATTEMPT-th
//   release does count, so no row is released forever), the budget is paused,
//   the rest of the claimed batch is released to the pause's end, the failed
//   row a moment later — behind them, so the next tick does not lead with the
//   same row — and the tick stops.
//
// DELIVERY IS AT-LEAST-ONCE (src/lib/jobs/queue.ts): a container killed between
// the relay's 250 and the settle sends that mail again after the lease expires.
// That window is one statement wide and is accepted.
//
// LOGS carry the job id, lane, category and a reason code — never an address,
// a subject or the relay's text (which can echo an address).

const SEAL_PURPOSE = 'mail-outbox';

/** A relay-wide release puts the failed row this long behind its batch. */
const RELEASE_STAGGER_MS = 1_000;

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
export type QueueReason = 'retry' | 'inline_timeout' | 'breaker' | 'lane' | 'approved';

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
  const world = prepared.world ?? (await worldOfOrg(prepared.orgId ?? null));
  const payload: MailJobPayload = {
    v: MAIL_PAYLOAD_VERSION,
    lane: prepared.lane,
    category: prepared.category ?? null,
    group: prepared.group ?? null,
    userId: prepared.userId ?? null,
    orgId: prepared.orgId ?? null,
    world,
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

// The world a queued mail belongs to (#2951): the BULK drain alternates
// between the two products by this field, so it is filled in on every row —
// from the recipient's organization when the preference read did not already
// learn it, the default world for a mail with no organization (an operator
// alert, a guest of the default product). Memoised per process for a minute:
// a 500-recipient broadcast is one tenant, and must cost one read, not 500.
const WORLD_TTL_MS = 60_000;
const worldMemo = new Map<string, { world: string; at: number }>();

async function worldOfOrg(orgId: string | null): Promise<string | null> {
  if (!orgId) return DEFAULT_VERTICAL;
  const hit = worldMemo.get(orgId);
  if (hit && Date.now() - hit.at < WORLD_TTL_MS) return hit.world;
  try {
    const world = await verticalFor(orgId);
    if (worldMemo.size > 1000) worldMemo.clear();
    worldMemo.set(orgId, { world, at: Date.now() });
    return world;
  } catch {
    // Unknown is honest: the drain's fallback claim takes a row with no world.
    return null;
  }
}

/**
 * How long the queue in front of a large send is, and roughly how long until
 * it has left (#2951): what an admin who just queued N mails is told.
 */
export interface MailQueueNotice {
  /** Mails this action put on the queue. */
  queued: number;
  /** Rough minutes until the caller's organization's queued mail has left
   *  (see `queueEtaMinutes`). */
  etaMinutes: number;
  /** True when the drain is paced by the budget (enforce mode). */
  paced: boolean;
}

/**
 * The notice for `queued` mails. `channel` picks whose budget paces them — the
 * bulk channel's numbers fall back to the primary ones when it has none of its
 * own. Never throws: a backlog that cannot be read falls back to this
 * action's own mails.
 *
 * The estimate counts the CALLER's organization's waiting mail only (`orgId`),
 * and the raw count never leaves the server: the queue is shared by every
 * tenant of the environment, and an org admin polling a send's response must
 * not be able to read another tenant's mailing volume from it. Other tenants'
 * mail ahead of this one can make the real wait longer — it is a rough figure
 * either way.
 */
export async function mailQueueNotice(
  queued: number,
  opts: { orgId: string | null; channel?: MailChannel; env?: Record<string, string | undefined> },
): Promise<MailQueueNotice> {
  const cfg = budgetConfig(opts.env ?? process.env, opts.channel ?? 'primary');
  let backlog = queued;
  if (queued > 0) {
    try {
      backlog = Math.max(
        queued,
        await runUnscoped(() =>
          prisma.job.count({ where: { name: MAIL_JOB_NAME, orgId: opts.orgId, status: { in: ['PENDING', 'RUNNING'] } } }),
        ),
      );
    } catch {
      // The estimate falls back to this action's own mails.
    }
  }
  return { queued, etaMinutes: queueEtaMinutes(backlog, cfg), paced: cfg.mode === 'enforce' };
}

/**
 * A sender that wrote its own record as QUEUED (the newsletter) asks, right
 * after, whether the drain already settled the mail — a quick drain can beat
 * the record's own insert, and the settle hook then found nothing to update.
 * Applies the hook when the row is already terminal; a no-op otherwise.
 */
export async function reconcileQueuedMail(idempotencyKey: string, ref: string): Promise<MailRefOutcome | null> {
  try {
    const row = await runUnscoped(() =>
      prisma.job.findUnique({ where: { idempotencyKey }, select: { status: true, lastError: true } }),
    );
    const outcome = row ? outcomeOfJob(row.status, row.lastError) : null;
    if (outcome) await settleMailRef(ref, outcome, row?.lastError ?? null);
    return outcome;
  } catch {
    return null;
  }
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
  /** Rows addressed to a generated address (#2970), cancelled unsent. */
  unmailable: number;
  /** Rows addressed to a bounce/complaint-suppressed address (#1692), cancelled unsent. */
  suppressed: number;
  reaped: number;
  /** BULK rows put back to the next UTC day by `MAIL_DAILY_CAP` (enforce mode). */
  capped: number;
  /** The relay rejected our credentials during this tick (#2953): the
   *  operator alert's trigger (`evaluateMailOps()`). */
  authRejected: boolean;
  /** Why the tick ended: no due rows, the budget, the breaker, the relay, the
   *  clock — or `daily_cap`: nothing left but BULK, and today's bulk share is
   *  spent. */
  stoppedBy: 'empty' | 'budget' | 'breaker' | 'relay' | 'deadline' | 'error' | 'disabled' | 'unconfigured' | 'daily_cap';
}

/** The delivery half a drain uses: the transport and the ledger —
 *  `mailDrainDeps()` in emailService.ts. Passed in by the caller so this module
 *  never imports emailService (which imports it). */
export interface DrainDeps {
  transmit(envelope: Envelope): Promise<void>;
  record(envelope: Envelope, status: 'SENT' | 'FAILED' | 'SKIPPED' | 'DEFERRED', error?: string): Promise<void>;
  /** Observe mode: the meter sees the send (charged, `would_refuse` logged). */
  observe(envelope: Envelope): void;
  /** A final failure, or a relay-wide one: the delivery-health alert's
   *  trigger (it decides itself whether the ledger warrants an alert). */
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

// ── Which rows a round claims (#2951) ───────────────────────────────────────
//
// Every round first claims the higher lanes (CRITICAL, TRANSACTIONAL — every
// row at or above HIGHER_LANE_MIN_PRIORITY), a batch at a time, so a backlog
// of bulk mail never stands in front of a message notification. Only when
// none is due does it take BULK — ONE row per round, so the next round looks
// at the higher lanes again — alternating between the two worlds
// (`bulkWorldOrder`), and falling back to any bulk row when neither preferred
// world has one due.

/** The world of the bulk row this process sent last (fair sharing). */
let lastBulkWorld: string | null = null;

/** Until when this process takes no BULK rows: today's bulk share of
 *  `MAIL_DAILY_CAP` is spent (the database said so on a spend). */
let bulkBlockedUntil = 0;

/** Tests: forget the in-process drain state between cases. */
export function resetDrainStateForTests(): void {
  lastBulkWorld = null;
  bulkBlockedUntil = 0;
  lastReapAt = 0;
}

// The two bands partition every priority: at or above HIGHER_LANE_MIN_PRIORITY
// is the higher lanes, everything below it the bulk band (bulk rows are at
// most BULK_PRIORITY_MAX), so no row — a hand-set priority included — is ever
// unreachable.
const HIGHER_LANES: ClaimFilter = { minPriority: HIGHER_LANE_MIN_PRIORITY };
const BULK_LANE: ClaimFilter = { maxPriority: HIGHER_LANE_MIN_PRIORITY - 1 };

/**
 * One round's rows. A plain, non-locking probe first reads the priority of the
 * most urgent due row, so an idle queue costs that one SELECT and no claim
 * transaction at all. Then at most three claims: the higher lanes (only when
 * the probe saw one due), the preferred world's bulk, any bulk. The second
 * world in `bulkWorldOrder` is reached through the last, unfiltered claim —
 * when the preferred world has nothing due, any bulk row is the other world's
 * (or one with no world).
 */
async function claimRound(workerId: string): Promise<{ rows: JobRecord[]; bulk: boolean; capped: boolean }> {
  const due = await prisma.job.findFirst({
    where: { name: MAIL_JOB_NAME, status: 'PENDING', runAt: { lte: new Date() } },
    orderBy: [{ priority: 'desc' }],
    select: { priority: true },
  });
  if (!due) return { rows: [], bulk: false, capped: false };
  const common = { names: [...JOB_NAMES], leaseMs: DEFAULT_LEASE_MS, store: store() };
  if (due.priority >= HIGHER_LANE_MIN_PRIORITY) {
    const higher = await claim(workerId, { ...common, limit: DRAIN_BATCH, filter: HIGHER_LANES });
    if (higher.length) return { rows: higher, bulk: false, capped: false };
  }
  if (Date.now() < bulkBlockedUntil) return { rows: [], bulk: true, capped: true };
  const [preferred] = bulkWorldOrder(lastBulkWorld);
  const mine = await claim(workerId, { ...common, limit: 1, filter: { ...BULK_LANE, payload: { key: 'world', value: preferred } } });
  if (mine.length) return { rows: mine, bulk: true, capped: false };
  const any = await claim(workerId, { ...common, limit: 1, filter: BULK_LANE });
  return { rows: any, bulk: true, capped: false };
}

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
    unmailable: 0,
    suppressed: 0,
    reaped: 0,
    capped: 0,
    authRejected: false,
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
      await clearExpiredEnvelopes(clock()).catch((e) =>
        logger.warning('mail_outbox.envelope_sweep_failed', { error: e instanceof Error ? e.name : 'unknown' }),
      );
    }

    while (Date.now() < deadline) {
      const { rows, bulk, capped } = await claimRound(workerId);
      if (rows.length === 0) {
        summary.stoppedBy = capped ? 'daily_cap' : 'empty';
        return summary;
      }
      summary.claimed += rows.length;
      for (let i = 0; i < rows.length; i++) {
        const rest = rows.slice(i + 1);
        let stop: Stop;
        const sentBefore = summary.sent;
        try {
          stop = await drainRow(rows[i], { workerId, clock, deps, configFor, nameFor, summary });
          // The alternation turns on a SEND, never on a claim: a bulk row the
          // budget refused and released must not flip the preferred world, or
          // under enforce mode the flip follows the 5 s tick instead of the
          // token and one world can win every slot.
          if (bulk && summary.sent > sentBefore) {
            const world = (rows[i].payload as { world?: unknown } | null)?.world;
            lastBulkWorld = typeof world === 'string' ? world : null;
          }
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
    // A sender's own record (a newsletter copy) must not stay QUEUED forever.
    const ref = (row.payload as { ref?: unknown } | null)?.ref;
    if (typeof ref === 'string') await settleMailRef(ref, 'FAILED', 'unreadable_envelope');
    logger.error('mail_outbox.unreadable', log);
    summary.dead++;
    return null;
  }
  const meta = { ...log, lane: payload.lane, category: payload.category ?? undefined };

  if (isExpired(payload.notAfter, now)) {
    await settle(row, workerId, { status: 'CANCELLED', lastError: 'expired', payload: clearedPayload(payload) });
    await deps.record(envelope, 'FAILED', 'Expired in the mail queue before it could be delivered');
    await settleMailRef(payload.ref, 'FAILED', 'expired');
    deps.finalFailure(envelope);
    logger.warning('mail_outbox.expired', meta);
    summary.expired++;
    return null;
  }

  // ── A generated address is nobody (#2970) ────────────────────────────────
  // prepareEmail() refuses one before it is ever queued; this catches a row
  // queued before that net existed (or an approved draft from then). Before
  // the budget, so it spends no token on mail that will never leave.
  if (unmailableRecipient(envelope.to)) {
    await settle(row, workerId, { status: 'CANCELLED', lastError: 'unmailable', payload: clearedPayload(payload) });
    await deps.record(envelope, 'SKIPPED', `Unmailable address: ${unmailableRecipient(envelope.to)}`);
    await settleMailRef(payload.ref, 'SKIPPED', 'unmailable');
    logger.info('mail_outbox.unmailable', meta);
    summary.unmailable++;
    return null;
  }

  // ── A suppressed address (#1692) ──────────────────────────────────────────
  // Re-checked here because a queued mail can be hours old and the bounce that
  // suppressed its address may have come in since. Every group, essential
  // included — the rule and its reason are in emailSuppressionRule.ts.
  const suppressed = (await suppressedAmong([envelope.to])).get(normalizeSuppressedAddress(envelope.to) ?? '');
  if (suppressed) {
    await settle(row, workerId, { status: 'CANCELLED', lastError: 'suppressed', payload: clearedPayload(payload) });
    await deps.record(envelope, 'SKIPPED', suppressedLogReason(suppressed));
    await settleMailRef(payload.ref, 'SKIPPED', 'suppressed');
    logger.info('mail_outbox.suppressed', meta);
    summary.suppressed++;
    return null;
  }

  // ── The budget ────────────────────────────────────────────────────────────
  const cfg = ctx.configFor(envelope.transport);
  const budget = ctx.nameFor(envelope.transport);
  if (cfg.mode !== 'off') {
    // A PAUSED relay (a throttle or a refused session whose pause has not run
    // out) would refuse this session too. The pause alone decides — never
    // `tat`, which observe mode charges for every send (breakerOpen()).
    const state = await budgetStore.readBudgetState(budget).catch(() => null);
    const wait = breakerWaitMs(state, cfg);
    if (wait > 0) {
      const runAt = new Date(now.getTime() + Math.max(1_000, wait));
      await release(row, workerId, runAt);
      summary.released++;
      return { reason: 'breaker', runAt };
    }
  }
  if (cfg.mode === 'enforce') {
    const spent = await budgetStore.spendToken(envelope.lane, cfg, budget);
    if (!spent.allowed && spent.reason === 'daily_cap') {
      // Today's bulk share is spent (#2951): this row waits for the next UTC
      // day, and this process takes no more BULK rows until then — the higher
      // lanes keep draining, so the tick goes on.
      const runAt = new Date(now.getTime() + Math.max(1_000, spent.waitMs));
      bulkBlockedUntil = Date.now() + Math.max(1_000, spent.waitMs);
      await release(row, workerId, runAt);
      logger.info('mail_outbox.daily_cap', { ...meta, runAt: runAt.toISOString() });
      summary.capped++;
      return null;
    }
    if (!spent.allowed) {
      const runAt = new Date(now.getTime() + Math.max(1_000, spent.reason === 'db_error' ? 5_000 : spent.waitMs));
      await release(row, workerId, runAt);
      summary.released++;
      return { reason: 'budget', runAt };
    }
  } else if (cfg.mode === 'observe') {
    // Observe mode never refuses on rate: the meter only sees the send.
    deps.observe(envelope);
  }

  // ── The preference gate, again ────────────────────────────────────────────
  if (!(await stillWanted(payload.group, payload.userId))) {
    await settle(row, workerId, { status: 'CANCELLED', lastError: 'unsubscribed', payload: clearedPayload(payload) });
    await deps.record(envelope, 'SKIPPED', `Unsubscribed: ${payload.group}`);
    await settleMailRef(payload.ref, 'SKIPPED', 'unsubscribed');
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

  if (error && isAuthRejection(classifySmtpError(error).reason, smtpReplyCodeOf(error))) {
    summary.authRejected = true;
    noteRelayAuthRejected();
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
        if (state) pausedUntil = new Date(now.getTime() + Math.max(0, state.pausedMs));
      } catch {
        // The ladder's first rung (settleAction's floor) stands in.
      }
    }
  }

  const action = settleAction({
    error,
    lane: envelope.lane,
    attempts: row.attempts,
    releases: payload.releases ?? 0,
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
      await settleMailRef(payload.ref, 'SENT');
      summary.sent++;
      return null;
    case 'release':
      // This row a moment after the rest of its batch: with the same priority
      // the next tick then leads with another row, so a failure that only
      // looks relay-wide does not hold the whole queue on one mail.
      await settle(row, workerId, {
        status: 'PENDING',
        runAt: new Date(action.runAt.getTime() + RELEASE_STAGGER_MS),
        attempts: action.attempts,
        lastError: action.reason,
        payload: { ...payload, releases: action.releases } as Prisma.InputJsonValue,
      });
      await deps.record(envelope, 'DEFERRED', errorText(error));
      deps.finalFailure(envelope);
      logger.warning('mail_outbox.relay_paused', {
        ...meta,
        reason: action.reason,
        releases: action.releases,
        runAt: action.runAt.toISOString(),
      });
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
      // The envelope stays sealed on the row until `notAfter` (#2953): the
      // admin Queue tab may put the mail back, and `clearExpiredEnvelopes()`
      // removes it once that can no longer happen.
      await settle(row, workerId, {
        status: action.status,
        attempts: action.attempts,
        lastError: action.reason,
      });
      await deps.record(envelope, 'FAILED', errorText(error));
      await settleMailRef(payload.ref, 'FAILED', action.reason);
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
      await settleMailRef(payload.ref, 'FAILED', action.reason);
      deps.finalFailure(envelope);
      logger.warning('mail_outbox.expired', { ...meta, reason: action.reason });
      summary.expired++;
      return null;
  }
}

/**
 * A FAILED or DEAD_LETTER mail keeps its sealed envelope only while it could
 * still be retried (#2953): once its `notAfter` has passed, the envelope goes.
 * Run with the reaper, once a minute per process.
 *
 * The SELECTION is done in SQL — only rows that still carry a box AND whose
 * deadline has passed (or is unreadable) — so a backlog of dead BULK mail that
 * may still be retried for days never hides a dead sign-in link behind it, and
 * no row ages out of a window unread: there is no window. `notAfter` is the
 * ISO-8601 UTC string `toISOString()` wrote, so it orders as text. At most 200
 * rows a run; each clear is guarded on the state it read and re-checks the
 * deadline in JS, so a row an operator just retried is left alone.
 */
export async function clearExpiredEnvelopes(now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const rows = await prisma.$queryRaw<{ id: string; status: JobStatus }[]>`
    SELECT id, status FROM \`Job\`
    WHERE name = ${MAIL_JOB_NAME}
      AND status IN ('FAILED', 'DEAD_LETTER')
      AND JSON_TYPE(JSON_EXTRACT(payload, '$.box')) = 'STRING'
      AND (
        JSON_TYPE(JSON_EXTRACT(payload, '$.notAfter')) IS NULL
        OR JSON_TYPE(JSON_EXTRACT(payload, '$.notAfter')) <> 'STRING'
        OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.notAfter')) <= ${nowIso}
      )
    LIMIT 200`;
  let cleared = 0;
  for (const { id, status } of rows) {
    const row = await prisma.job.findFirst({ where: { id, status }, select: { payload: true } });
    const p = row?.payload as { box?: unknown; notAfter?: unknown } | null | undefined;
    if (!p || typeof p.box !== 'string') continue;
    // No readable deadline means no retry either (queueActionAllowed): clear.
    const until = typeof p.notAfter === 'string' ? Date.parse(p.notAfter) : NaN;
    if (Number.isFinite(until) && until > now.getTime()) continue;
    const { count } = await prisma.job.updateMany({
      where: { id, status },
      data: { payload: clearedPayload(p) },
    });
    cleared += count;
  }
  return cleared;
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
