import type { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { superAdminWorld } from '@/lib/superAdmin';
import { defaultOrgId } from '@/lib/defaultOrg';
import { resolveOrgId } from '@/lib/orgScope';
import { DEFAULT_VERTICAL } from '@/lib/verticals';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { open } from '@/lib/secretBox';
import { runUnscoped } from '@/lib/tenantAmbient';
import { orgWorldWhere } from '@/lib/superAdminWorld';
import { toVerticalKey } from '@/lib/verticals';
import { HIGHER_LANE_MIN_PRIORITY, budgetConfig, budgetNameFor, type MailChannel, type MailLane } from '@/lib/mailDeliveryRule';
import { MAIL_JOB_NAME, decodeEnvelope } from '@/lib/mailWorkerRule';
import { readBudgetHealth, type BudgetHealth } from '@/lib/mailBudgetStore';
import { reopenMailRef, settleMailRef } from '@/lib/mailRefHooks';
import {
  emptyLaneCounts,
  foldLaneCounts,
  laneOfPayload,
  laneOfPriority,
  queueActionAllowed,
  queueScopeFor,
  reasonCodeOf,
  recipientPrefix,
  type LaneCounts,
  type QueueAction,
  type QueueActionRefusal,
  type QueueScope,
} from '@/lib/mailOpsRule';

// The mail queue as an operator sees it (#2953): the health endpoint's `mail`
// block, the admin Queue tab's lists and its two actions. The rules — who sees
// which rows, which action is allowed on which row, the lane bands — are pure
// in `mailOpsRule.ts`; this module reads and writes the rows.
//
// NEVER AN ADDRESS. A queued mail's address and subject live only inside the
// sealed envelope (`payload.box`), which nothing here returns. What leaves is
// the lane, category, world, state, attempts, a reason CODE (`reasonCodeOf()`)
// and the first 12 hex characters of the recipient's sha256 — enough to match
// a log line's `rcpt`, nothing an address can be read back from.
//
// Every read runs outside the tenant auto-filter (`runUnscoped`) and carries
// its OWN scope filter instead: the queue is deployment-wide, the filter is
// the scope `queueScopeFor()` decided, and an implicit session filter on top
// would silently narrow a super admin's world view to one tenant.

const SEAL_PURPOSE = 'mail-outbox';
const LIST_LIMIT = 50;

/**
 * The caller's view of the queue (`queueScopeFor()` in mailOpsRule.ts): a
 * super admin's world, the default organization's ADMIN its own rows, nobody
 * else anything (null → 403). Reads the super-admin flag live, never the JWT.
 */
export async function resolveQueueScope(session: Session | null | undefined): Promise<QueueScope | null> {
  if (!session?.user || session.user.role !== 'ADMIN') return null;
  const [world, defaultId] = await Promise.all([superAdminWorld(session), defaultOrgId()]);
  return queueScopeFor({
    role: session.user.role,
    superAdminWorld: world,
    orgId: resolveOrgId(session),
    defaultOrgId: defaultId,
    defaultWorld: DEFAULT_VERTICAL,
  });
}

// ── The health block ────────────────────────────────────────────────────────

export interface LaneHealth {
  pending: number;
  /** Seconds since the oldest PENDING mail of this lane was queued; null when none. */
  oldestPendingAgeSec: number | null;
}

export interface MailQueueHealth {
  lanes: Record<MailLane, LaneHealth>;
  /** Claimed by a drain right now. */
  running: number;
  /** EmailLog DEFERRED rows of the last 24 h: temporary refusals the queue kept. */
  deferred24h: number;
  /** `email.send` rows in DEAD_LETTER (attempts exhausted). */
  dead: number;
  /** `email.send` rows FAILED for good (a 5xx) in the last 24 h. */
  failed24h: number;
  /** Per channel: the relay pause. `bulk` only when the bulk server is configured. */
  breaker: Partial<Record<MailChannel, { paused: boolean; pausedUntil: string | null; pauseLevel: number; outageSec: number | null }>>;
  /** Today's (UTC) sends against `MAIL_DAILY_CAP` (null cap = none set), per channel. */
  day: Partial<Record<MailChannel, { count: number; cap: number | null }>>;
  meterMode: string;
}

function channels(): MailChannel[] {
  return process.env.SMTP_BULK_HOST && process.env.SMTP_BULK_USER ? ['primary', 'bulk'] : ['primary'];
}

async function budgetHealth(channel: MailChannel): Promise<BudgetHealth | null> {
  try {
    return await readBudgetHealth(budgetNameFor(channel));
  } catch {
    return null;
  }
}

/**
 * The deployment-wide `mail` block. Counters, ages and instants only. Four
 * indexed reads plus one per budget row; reached only behind the health
 * endpoint's `?jobs=1` and an operator's proof of identity.
 */
export async function mailQueueHealth(now: Date = new Date()): Promise<MailQueueHealth> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [pending, running, dead, failed24h, deferred24h] = await runUnscoped(() =>
    Promise.all([
      prisma.job.groupBy({
        by: ['priority'],
        where: { name: MAIL_JOB_NAME, status: 'PENDING' },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      prisma.job.count({ where: { name: MAIL_JOB_NAME, status: 'RUNNING' } }),
      prisma.job.count({ where: { name: MAIL_JOB_NAME, status: 'DEAD_LETTER' } }),
      prisma.job.count({ where: { name: MAIL_JOB_NAME, status: 'FAILED', updatedAt: { gt: dayAgo } } }),
      prisma.emailLog.count({ where: { status: 'DEFERRED', createdAt: { gt: dayAgo } } }),
    ]),
  );
  const lanes: Record<MailLane, LaneHealth> = {
    CRITICAL: { pending: 0, oldestPendingAgeSec: null },
    TRANSACTIONAL: { pending: 0, oldestPendingAgeSec: null },
    BULK: { pending: 0, oldestPendingAgeSec: null },
  };
  for (const g of pending) {
    const lane = lanes[laneOfPriority(g.priority, HIGHER_LANE_MIN_PRIORITY)];
    lane.pending += g._count._all;
    const oldest = g._min.createdAt;
    if (oldest) {
      const age = Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000));
      lane.oldestPendingAgeSec = Math.max(lane.oldestPendingAgeSec ?? 0, age);
    }
  }
  const breaker: MailQueueHealth['breaker'] = {};
  const day: MailQueueHealth['day'] = {};
  for (const ch of channels()) {
    const b = await budgetHealth(ch);
    const cfg = budgetConfig(process.env, ch);
    breaker[ch] = {
      paused: b?.paused ?? false,
      pausedUntil: b?.pausedUntil ?? null,
      pauseLevel: b?.pauseLevel ?? 0,
      outageSec: b?.outageMs === null || b?.outageMs === undefined ? null : Math.round(b.outageMs / 1000),
    };
    day[ch] = { count: b?.dayCount ?? 0, cap: cfg.dailyCap > 0 ? cfg.dailyCap : null };
  }
  return {
    lanes,
    running,
    deferred24h,
    dead,
    failed24h,
    breaker,
    day,
    meterMode: budgetConfig(process.env).mode,
  };
}

// ── The Queue tab ───────────────────────────────────────────────────────────

/** The Prisma filter for a scope's rows (the `Job.orgId` half). */
/**
 * The rows a scope reaches, as a `Job` filter — shared with the operations
 * console (#1607), which reads the same deployment-wide tables under the same rule.
 */
export async function queueScopeWhere(scope: QueueScope): Promise<Prisma.JobWhereInput> {
  if (scope.kind === 'org') return { orgId: scope.orgId };
  const orgs = await runUnscoped(() =>
    prisma.organization.findMany({ where: orgWorldWhere(toVerticalKey(scope.world)), select: { id: true } }),
  );
  const ids = orgs.map((o) => o.id);
  return { OR: [{ orgId: { in: ids } }, ...(scope.includeOrgless ? [{ orgId: null }] : [])] };
}

export interface QueueRow {
  id: string;
  status: string;
  lane: MailLane;
  category: string | null;
  world: string | null;
  attempts: number;
  maxAttempts: number;
  /** A reason code, or `other` — never the relay's text. */
  reason: string | null;
  /** First 12 hex characters of sha256(lowercased address). */
  rcpt: string | null;
  queuedAt: string;
  updatedAt: string;
  runAt: string;
  notAfter: string | null;
  /** Is the matching action allowed right now (retry on a dead row, cancel on a waiting one)? */
  actionable: boolean;
  /** Why not, when it is not. */
  refusal: QueueActionRefusal | null;
}

export interface QueueView {
  scope: 'world' | 'organization';
  counts: LaneCounts;
  dead: QueueRow[];
  waiting: QueueRow[];
  breaker: MailQueueHealth['breaker'];
  /** Super admin only: today's count against the cap, per channel. */
  day?: MailQueueHealth['day'];
}

type JobRow = {
  id: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  payload: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
  runAt: Date;
};

const ROW_SELECT = {
  id: true,
  status: true,
  priority: true,
  attempts: true,
  maxAttempts: true,
  lastError: true,
  payload: true,
  createdAt: true,
  updatedAt: true,
  runAt: true,
} as const;

function payloadField(payload: Prisma.JsonValue, key: string): unknown {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)[key] : undefined;
}

function hasEnvelope(payload: Prisma.JsonValue): boolean {
  return typeof payloadField(payload, 'box') === 'string';
}

function toQueueRow(row: JobRow, action: QueueAction, now: Date): QueueRow {
  const notAfter = payloadField(row.payload, 'notAfter');
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const allowed = queueActionAllowed(
    action,
    { status: row.status, notAfter: str(notAfter), hasEnvelope: hasEnvelope(row.payload) },
    now,
  );
  return {
    id: row.id,
    status: row.status,
    lane: laneOfPayload(row.payload),
    category: str(payloadField(row.payload, 'category'))?.slice(0, 64) ?? null,
    world: str(payloadField(row.payload, 'world'))?.slice(0, 32) ?? null,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    reason: reasonCodeOf(row.lastError),
    rcpt: recipientPrefix(payloadField(row.payload, 'rcpt')),
    queuedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    runAt: row.runAt.toISOString(),
    notAfter: str(notAfter),
    actionable: allowed === true,
    refusal: allowed === true ? null : allowed,
  };
}

export async function mailQueueView(scope: QueueScope, now: Date = new Date()): Promise<QueueView> {
  const where = await queueScopeWhere(scope);
  const base: Prisma.JobWhereInput = { AND: [{ name: MAIL_JOB_NAME }, where] };
  const [grouped, dead, waiting, health] = await Promise.all([
    runUnscoped(() =>
      prisma.job.groupBy({ by: ['status', 'priority'], where: base, _count: { _all: true } }),
    ),
    runUnscoped(() =>
      prisma.job.findMany({
        where: { AND: [base, { status: { in: ['DEAD_LETTER', 'FAILED'] } }] },
        orderBy: { updatedAt: 'desc' },
        take: LIST_LIMIT,
        select: ROW_SELECT,
      }),
    ),
    runUnscoped(() =>
      prisma.job.findMany({
        where: { AND: [base, { status: 'PENDING' }] },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: LIST_LIMIT,
        select: ROW_SELECT,
      }),
    ),
    mailQueueHealth(now).catch(() => null),
  ]);
  const counts = grouped.length
    ? foldLaneCounts(
        grouped.map((g) => ({ lane: laneOfPriority(g.priority, HIGHER_LANE_MIN_PRIORITY), status: g.status, count: g._count._all })),
      )
    : emptyLaneCounts();
  return {
    scope: scope.kind === 'world' ? 'world' : 'organization',
    counts,
    dead: dead.map((r) => toQueueRow(r, 'retry', now)),
    waiting: waiting.map((r) => toQueueRow(r, 'cancel', now)),
    breaker: health?.breaker ?? {},
    ...(scope.kind === 'world' ? { day: health?.day ?? {} } : {}),
  };
}

// ── The two actions ─────────────────────────────────────────────────────────

export type QueueActionResult =
  | { ok: true; status: 'PENDING' | 'CANCELLED' }
  | { ok: false; httpStatus: 404 | 409; code: 'not_found' | QueueActionRefusal | 'conflict' };

const AUDIT_ACTION: Record<QueueAction, string> = { retry: 'MAIL_QUEUE_RETRY', cancel: 'MAIL_QUEUE_CANCEL' };

/**
 * Retry (FAILED / DEAD_LETTER → PENDING, attempts reset) or cancel (PENDING →
 * CANCELLED, envelope cleared) one queued mail, inside the caller's scope. A
 * row outside the scope is `not_found` — the same answer as a row that does not
 * exist, so the id of another tenant's mail is never confirmed.
 *
 * ONE guarded `updateMany` on the state the read saw, and the AuditLog row in
 * the same transaction only when it changed a row — two operators clicking at
 * once write one change and one audit row; the loser gets 409 `conflict`.
 */
export async function applyQueueAction(
  action: QueueAction,
  jobId: string,
  scope: QueueScope,
  actor: { id: string; email?: string | null; orgId: string | null },
  request?: Request,
  now: Date = new Date(),
): Promise<QueueActionResult> {
  const where = await queueScopeWhere(scope);
  const row = await runUnscoped(() =>
    prisma.job.findFirst({
      where: { AND: [{ id: jobId, name: MAIL_JOB_NAME }, where] },
      select: { ...ROW_SELECT, orgId: true },
    }),
  );
  if (!row) return { ok: false, httpStatus: 404, code: 'not_found' };

  const notAfter = payloadField(row.payload, 'notAfter');
  const allowed = queueActionAllowed(
    action,
    { status: row.status, notAfter: typeof notAfter === 'string' ? notAfter : null, hasEnvelope: hasEnvelope(row.payload) },
    now,
  );
  if (allowed !== true) return { ok: false, httpStatus: 409, code: allowed };

  const base =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {};
  const data: Prisma.JobUpdateManyMutationInput =
    action === 'retry'
      ? {
          status: 'PENDING',
          attempts: 0,
          runAt: now,
          // A retry re-enqueues the mail: its wait starts now. The waiting
          // ages (the health block, the "critical mail waiting" alert) read
          // `createdAt`, and the original enqueue time would make a retried
          // sign-in mail look five minutes overdue the moment it is back. The
          // retry itself is in the AuditLog row written with it.
          createdAt: now,
          lastError: 'retried_by_operator',
          lockedAt: null,
          lockedBy: null,
          // The relay-wide release counter starts over with the attempts.
          payload: { ...base, releases: 0 } as Prisma.InputJsonValue,
        }
      : {
          status: 'CANCELLED',
          lastError: 'cancelled_by_operator',
          payload: { ...base, box: null } as Prisma.InputJsonValue,
        };
  const auditOrgId = row.orgId ?? actor.orgId;
  const detail = JSON.stringify({
    from: row.status,
    lane: laneOfPayload(row.payload),
    category: typeof base.category === 'string' ? base.category.slice(0, 64) : null,
  });

  const changed = await runUnscoped(() =>
    prisma.$transaction(async (tx) => {
      const { count } = await tx.job.updateMany({ where: { id: row.id, name: MAIL_JOB_NAME, status: row.status }, data });
      if (count !== 1) return false;
      // The dead mail's sender record (a newsletter copy) was settled FAILED;
      // back on the queue, it is QUEUED again so the delivery can settle it.
      if (action === 'retry') await reopenMailRef(typeof base.ref === 'string' ? base.ref : null, tx);
      await tx.auditLog.create({
        data: { actorId: actor.id, action: AUDIT_ACTION[action], targetId: row.id, orgId: auditOrgId, detail },
      });
      return true;
    }),
  );
  if (!changed) return { ok: false, httpStatus: 409, code: 'conflict' };

  await logActivity({
    action: action === 'retry' ? 'mail_queue.retry' : 'mail_queue.cancel',
    level: 'warning',
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    targetType: 'job',
    targetId: row.id,
    detail,
    orgId: auditOrgId,
    request: request ?? null,
  });

  if (action === 'cancel') {
    // The sender's own record (a newsletter copy) must not stay QUEUED, and
    // the delivery ledger says what became of the mail — best effort: the
    // cancel itself is already written.
    await settleMailRef(typeof base.ref === 'string' ? base.ref : null, 'FAILED', 'cancelled_by_operator');
    await recordCancelled(base).catch((e) =>
      logger.warning('mail_queue.cancel_ledger_failed', { jobId: row.id, error: e instanceof Error ? e.name : 'unknown' }),
    );
  }
  return { ok: true, status: action === 'retry' ? 'PENDING' : 'CANCELLED' };
}

/** The EmailLog row for a cancelled mail: SKIPPED with the reason — the
 *  recipient and subject come out of the envelope here and go nowhere else. */
async function recordCancelled(payload: Record<string, unknown>): Promise<void> {
  if (typeof payload.box !== 'string') return;
  const envelope = decodeEnvelope(open(payload.box, SEAL_PURPOSE));
  if (!envelope) return;
  await prisma.emailLog.create({
    data: {
      // The recipient's tenant, sealed in the envelope (#1556) — never the
      // operator's request scope.
      orgId: envelope.orgId ?? null,
      to: envelope.to.slice(0, 320),
      subject: envelope.subject.slice(0, 512),
      category: envelope.category?.slice(0, 64) ?? null,
      status: 'SKIPPED',
      transport: envelope.transport,
      error: 'Cancelled by an operator in the mail queue',
    },
  });
}
