import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { seal, open } from '@/lib/secretBox';
import { runUnscoped } from '@/lib/tenantAmbient';
import { getSetting } from '@/lib/settings';
import { verticalFor } from '@/lib/verticalContext';
import { verticalCapabilities } from '@/lib/verticals';
import { logActivity } from '@/lib/activity';
import { recipientHash, unmailableRecipient } from '@/lib/mailDeliveryRule';
import { MAIL_JOB_NAME, decodeEnvelope, encodeEnvelope, type Envelope } from '@/lib/mailWorkerRule';
import { canQueue, enqueueMail } from '@/lib/mailOutbox';
import { settleMailRef } from '@/lib/mailRefHooks';
import {
  OUTBOUND_BULK_MAX,
  actionAllowed,
  draftNotAfter,
  maskAddress,
  outboundApprovalApplies,
  outboundDecision,
  parseOutboundApprovalMode,
  recipientKindForRole,
  statusAfter,
  triggerFor,
  type ActionRefusal,
  type OutboundAction,
  type OutboundDecisionCode,
  type OutboundDraftStatus,
  type RecipientKind,
} from '@/lib/outboundApprovalRule';
import type { PreparedEmail } from '@/services/emailService';

// The outbound approval inbox (#2960, docs/outbound-approval.md): the ONE
// writer of `OutboundDraft`. The rule (which mail is held) is pure in
// src/lib/outboundApprovalRule.ts; this file is where it meets the database.
//
//   holdIfRequired()   — called by sendEmail() for every prepared mail;
//   applyDraftAction() — send now / schedule / discard, one guarded updateMany
//                        each, with its AuditLog row in the same transaction;
//   expireDrafts()     — the hourly sweep (notAfter passed → EXPIRED);
//   pruneOutboundDrafts() — the retention entry;
//   forgetOutboundDrafts() — account / contact erasure.
//
// The only way a held mail leaves is `applyDraftAction('send' | 'schedule')`,
// which puts the sealed mail on the mail queue (`enqueueMail`, idempotency key
// `draft:<id>`) — the queue's drain delivers it without asking the hold again.
//
// LOGS never carry an address or a subject: the draft id, the org, the
// category and a reason code.

const SEAL_PURPOSE = 'outbound-draft';

// ── The org's switch ─────────────────────────────────────────────────────────

// The vertical of an org is memoised for a minute: every mail of every tenant
// passes the hook, and an internship tenant's mail must not pay a query each.
// The SETTING is read live (only for a vertical where it applies), so turning
// approval on holds the very next mail on every replica.
const VERTICAL_TTL_MS = 60_000;
const appliesMemo = new Map<string, { applies: boolean; at: number }>();

async function approvalAppliesTo(orgId: string): Promise<boolean> {
  const hit = appliesMemo.get(orgId);
  if (hit && Date.now() - hit.at < VERTICAL_TTL_MS) return hit.applies;
  const applies = outboundApprovalApplies(verticalCapabilities(await verticalFor(orgId)));
  if (appliesMemo.size > 1000) appliesMemo.clear();
  appliesMemo.set(orgId, { applies, at: Date.now() });
  return applies;
}

/** Is approval switched on for this org right now? (The screens' banner reads it.) */
export async function outboundApprovalOn(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  if (!(await approvalAppliesTo(orgId))) return false;
  return parseOutboundApprovalMode(await getSetting('outboundApproval', orgId)) === 'lead_mail';
}

// ── The hook ─────────────────────────────────────────────────────────────────

interface RecipientFacts {
  orgId: string | null;
  kind: RecipientKind;
  userId: string | null;
  companyId: string | null;
  name: string | null;
}

/**
 * Who the mail is for, in the org it belongs to. The recipient's own account
 * decides the org when there is one; an address without one belongs to the org
 * the sender named. Looked up by the (email, org) pair — one world's row, never
 * "whichever account holds the address" (docs/worlds.md).
 */
async function recipientFacts(prepared: PreparedEmail): Promise<RecipientFacts> {
  if (prepared.userId) {
    const user = await runUnscoped(() =>
      prisma.user.findUnique({
        where: { id: prepared.userId! },
        select: { id: true, orgId: true, role: true, fullName: true, companyId: true },
      }),
    );
    if (user) {
      return {
        orgId: user.orgId ?? prepared.orgId ?? null,
        kind: recipientKindForRole(user.role),
        userId: user.id,
        companyId: user.companyId ?? null,
        name: user.fullName,
      };
    }
  }
  const orgId = prepared.orgId ?? null;
  if (!orgId) return { orgId: null, kind: 'contact', userId: null, companyId: null, name: null };
  const address = prepared.to.trim().toLowerCase();
  const account = await runUnscoped(() =>
    prisma.user.findUnique({
      where: { email_orgId: { email: address, orgId } },
      select: { id: true, role: true, fullName: true, companyId: true },
    }),
  );
  if (account) {
    return { orgId, kind: recipientKindForRole(account.role), userId: account.id, companyId: account.companyId ?? null, name: account.fullName };
  }
  const contact = await runUnscoped(() =>
    prisma.companyContact.findFirst({ where: { orgId, email: address }, select: { companyId: true, name: true } }),
  );
  if (contact) return { orgId, kind: 'contact', userId: null, companyId: contact.companyId, name: contact.name };
  const company = await runUnscoped(() =>
    prisma.company.findFirst({ where: { orgId, contactEmail: address }, select: { id: true, contactName: true } }),
  );
  return { orgId, kind: 'contact', userId: null, companyId: company?.id ?? null, name: company?.contactName ?? null };
}

export interface HoldOptions {
  /** The sender's de-duplication key (`dedupeKeyFor()`), when it named one. */
  dedupeKey?: string | null;
  /** The sender's own deadline. */
  notAfter?: Date | null;
  /** The sender's own record of this mail (the queue's settle hook reads it). */
  ref?: string | null;
  now?: Date;
}

export type HoldResult =
  | { held: false; code: OutboundDecisionCode }
  | { held: true; code: OutboundDecisionCode; draftId: string; created: boolean };

/**
 * The draft's identity when the sender named none: one per recipient, subject,
 * BODY and UTC day. The body is part of it because two different mails can
 * share a subject on the same day — two in-app messages to one lead both read
 * "New message from …" — and the second must be a draft of its own, not lost
 * to the first one's key. A cron that runs twice builds the same body, so it
 * still collapses into one draft.
 */
export function fallbackDraftKey(prepared: PreparedEmail, now: Date): string {
  const msg = (prepared.message ?? {}) as { html?: unknown; text?: unknown; attachments?: { content?: unknown; filename?: unknown }[] };
  const body = createHash('sha256');
  body.update(typeof msg.html === 'string' ? msg.html : '');
  body.update('\n');
  body.update(typeof msg.text === 'string' ? msg.text : '');
  for (const a of msg.attachments ?? []) {
    body.update('\n');
    body.update(typeof a.filename === 'string' ? a.filename : '');
    const c = a.content;
    if (typeof c === 'string' || Buffer.isBuffer(c)) body.update(c);
  }
  const digest = createHash('sha256')
    .update(
      [prepared.category ?? '', recipientHash(prepared.to), prepared.subject, now.toISOString().slice(0, 10), body.digest('hex')].join('\n'),
    )
    .digest('hex');
  return `hold:${digest}`;
}

/**
 * Hold this mail if its org asks for approval and the rule says so. Called by
 * `sendEmail()` between `prepareEmail()` and the dispatch, so every sender is
 * covered. Throws when the decision cannot be made (the database is down):
 * a mail to a lead must never leave because the check failed — the caller
 * treats it like a transport failure.
 */
export async function holdIfRequired(prepared: PreparedEmail, opts: HoldOptions = {}): Promise<HoldResult> {
  // The cheap exits first: an exempt category costs no query at all.
  const fast = outboundDecision({ mode: 'lead_mail', applies: true, hasOrg: true, category: prepared.category, recipient: 'contact' });
  if (fast.code === 'exempt_category') return { held: false, code: 'exempt_category' };

  // The org the mail belongs to: the sender's word, or the recipient account's.
  let orgId = prepared.orgId ?? null;
  if (!orgId && prepared.userId) {
    const u = await runUnscoped(() => prisma.user.findUnique({ where: { id: prepared.userId! }, select: { orgId: true } }));
    orgId = u?.orgId ?? null;
  }
  if (!orgId) return { held: false, code: 'no_org' };
  if (!(await approvalAppliesTo(orgId))) return { held: false, code: 'approval_off' };
  const mode = parseOutboundApprovalMode(await getSetting('outboundApproval', orgId));
  if (mode === 'off') return { held: false, code: 'approval_off' };

  const facts = await recipientFacts({ ...prepared, orgId: prepared.orgId ?? orgId });
  const draftOrg = facts.orgId ?? orgId;
  const decision = outboundDecision({ mode, applies: true, hasOrg: true, category: prepared.category, recipient: facts.kind });
  if (!decision.hold) return { held: false, code: decision.code };

  const now = opts.now ?? new Date();
  const dedupeKey = (opts.dedupeKey && opts.dedupeKey.length <= 191 ? opts.dedupeKey : null) ?? fallbackDraftKey(prepared, now);
  const envelope = prepared as unknown as Envelope;
  const data: Prisma.OutboundDraftCreateManyInput = {
    orgId: draftOrg,
    status: 'DRAFT',
    category: prepared.category?.slice(0, 64) ?? null,
    lane: prepared.lane,
    mailGroup: prepared.group?.slice(0, 32) ?? null,
    reason: decision.code,
    trigger: triggerFor(prepared.category),
    rcpt: recipientHash(prepared.to),
    recipientUserId: facts.userId,
    recipientCompanyId: facts.companyId,
    box: seal(encodeEnvelope(envelope), SEAL_PURPOSE),
    summary: seal(
      JSON.stringify({ subject: prepared.subject, name: facts.name, masked: maskAddress(prepared.to) }),
      SEAL_PURPOSE,
    ),
    dedupeKey,
    ref: opts.ref?.slice(0, 191) ?? null,
    notAfter: draftNotAfter(now, opts.notAfter ?? null),
    createdAt: now,
  };
  // The same logical mail again (a cron that ran twice, tomorrow's run of a
  // reminder already waiting) is one draft, whatever state it is in — a
  // discarded draft is a decision, not an invitation to ask again. The unique
  // (orgId, dedupeKey) index is the claim; `skipDuplicates` makes losing it
  // quiet instead of a logged constraint error.
  const { count } = await runUnscoped(() => prisma.outboundDraft.createMany({ data: [data], skipDuplicates: true }));
  const row = await runUnscoped(() =>
    prisma.outboundDraft.findUnique({ where: { orgId_dedupeKey: { orgId: draftOrg, dedupeKey } }, select: { id: true } }),
  );
  if (!row) throw new Error('outbound_draft: the draft could not be stored');
  if (count === 1) logger.info('outbound_draft.held', { draftId: row.id, orgId: draftOrg, category: prepared.category, reason: decision.code });
  return { held: true, code: decision.code, draftId: row.id, created: count === 1 };
}

// ── Who sees which draft ────────────────────────────────────────────────────

export interface OutboxActor {
  id: string;
  role: string;
  orgId: string | null;
  email?: string | null;
}

/**
 * The one "which drafts may this person see" filter. An ADMIN: every draft of
 * their org. A MENTOR (a sales rep): the drafts addressed to a lead or an
 * account they own NOW — a relation they are the owner of, by its lead or its
 * company — so a handed-over lead's waiting mail moves with the lead. Anybody
 * else: nothing. Another org's draft is never in any of them, so a foreign id
 * answers 404 like a missing one.
 */
export async function visibleDraftsWhere(actor: OutboxActor): Promise<Prisma.OutboundDraftWhereInput | null> {
  if (!actor.orgId) return null;
  if (actor.role === 'ADMIN') return { orgId: actor.orgId };
  if (actor.role !== 'MENTOR') return null;
  const owned = await runUnscoped(() =>
    prisma.mentorshipRelation.findMany({
      // ACTIVE only: a relation that ended (completed, or closed by a handover
      // to another rep) no longer makes this rep the owner of the lead.
      where: { orgId: actor.orgId, mentorId: actor.id, status: 'ACTIVE' },
      select: { menteeId: true, companyId: true },
    }),
  );
  const leads = [...new Set(owned.map((r) => r.menteeId))];
  const companies = [...new Set(owned.map((r) => r.companyId).filter((c): c is string => !!c))];
  if (leads.length === 0 && companies.length === 0) return { orgId: actor.orgId, id: '__none__' };
  return {
    orgId: actor.orgId,
    OR: [
      ...(leads.length ? [{ recipientUserId: { in: leads } }] : []),
      ...(companies.length ? [{ recipientCompanyId: { in: companies } }] : []),
    ],
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface DraftListItem {
  id: string;
  status: OutboundDraftStatus;
  category: string | null;
  trigger: string;
  reason: string;
  lane: string;
  subject: string | null;
  recipientName: string | null;
  recipientMasked: string | null;
  createdAt: string;
  notAfter: string;
  scheduledFor: string | null;
  decidedAt: string | null;
}

interface Summary {
  subject?: string;
  name?: string | null;
  masked?: string;
}

function readSummary(sealed: string | null): Summary {
  if (!sealed) return {};
  const json = open(sealed, SEAL_PURPOSE);
  if (!json) return {};
  try {
    return JSON.parse(json) as Summary;
  } catch {
    return {};
  }
}

const LIST_SELECT = {
  id: true,
  status: true,
  category: true,
  trigger: true,
  reason: true,
  lane: true,
  summary: true,
  createdAt: true,
  notAfter: true,
  scheduledFor: true,
  decidedAt: true,
} as const;

export const OUTBOX_PAGE_SIZE = 100;

export async function listDrafts(
  actor: OutboxActor,
  filter: { status?: OutboundDraftStatus | 'ALL'; trigger?: string | null } = {},
): Promise<{ drafts: DraftListItem[]; total: number; pending: number }> {
  const scope = await visibleDraftsWhere(actor);
  if (!scope) return { drafts: [], total: 0, pending: 0 };
  const status = filter.status ?? 'DRAFT';
  const where: Prisma.OutboundDraftWhereInput = {
    AND: [scope, ...(status !== 'ALL' ? [{ status }] : []), ...(filter.trigger ? [{ trigger: filter.trigger }] : [])],
  };
  const [rows, total, pending] = await runUnscoped(() =>
    Promise.all([
      prisma.outboundDraft.findMany({ where, orderBy: { createdAt: 'desc' }, take: OUTBOX_PAGE_SIZE, select: LIST_SELECT }),
      prisma.outboundDraft.count({ where }),
      prisma.outboundDraft.count({ where: { AND: [scope, { status: 'DRAFT' }] } }),
    ]),
  );
  return {
    drafts: rows.map((r) => {
      const s = readSummary(r.summary);
      return {
        id: r.id,
        status: r.status,
        category: r.category,
        trigger: r.trigger,
        reason: r.reason,
        lane: r.lane,
        subject: s.subject ?? null,
        recipientName: s.name ?? null,
        recipientMasked: s.masked ?? null,
        createdAt: r.createdAt.toISOString(),
        notAfter: r.notAfter.toISOString(),
        scheduledFor: r.scheduledFor?.toISOString() ?? null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
      };
    }),
    total,
    pending,
  };
}

/** The pending count for the nav badge. */
export async function pendingDraftCount(actor: OutboxActor): Promise<number> {
  const scope = await visibleDraftsWhere(actor);
  if (!scope) return 0;
  return runUnscoped(() => prisma.outboundDraft.count({ where: { AND: [scope, { status: 'DRAFT' }] } }));
}

export interface DraftDetail extends DraftListItem {
  to: string | null;
  html: string | null;
  text: string | null;
}

/** One draft with its full mail, for the preview. Null = not visible to this actor (404). */
export async function draftDetail(actor: OutboxActor, id: string): Promise<DraftDetail | null> {
  const scope = await visibleDraftsWhere(actor);
  if (!scope) return null;
  const row = await runUnscoped(() =>
    prisma.outboundDraft.findFirst({ where: { AND: [scope, { id }] }, select: { ...LIST_SELECT, box: true } }),
  );
  if (!row) return null;
  const s = readSummary(row.summary);
  const env = row.box ? decodeEnvelope(open(row.box, SEAL_PURPOSE)) : null;
  return {
    id: row.id,
    status: row.status,
    category: row.category,
    trigger: row.trigger,
    reason: row.reason,
    lane: row.lane,
    subject: env?.subject ?? s.subject ?? null,
    recipientName: s.name ?? null,
    recipientMasked: s.masked ?? null,
    createdAt: row.createdAt.toISOString(),
    notAfter: row.notAfter.toISOString(),
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    to: env?.to ?? null,
    html: typeof env?.message.html === 'string' ? env.message.html : null,
    text: typeof env?.message.text === 'string' ? env.message.text : null,
  };
}

// ── Deciding ────────────────────────────────────────────────────────────────

export type DraftActionResult =
  | { ok: true; status: OutboundDraftStatus; jobId: string | null }
  | { ok: false; httpStatus: 404 | 409 | 500; code: 'not_found' | 'conflict' | 'unreadable' | 'not_queueable' | 'unmailable' | 'enqueue_failed' | 'send_failed' | ActionRefusal };

const AUDIT_ACTION: Record<OutboundAction, string> = {
  send: 'outbound_draft.send',
  schedule: 'outbound_draft.schedule',
  discard: 'outbound_draft.discard',
};

/**
 * Send now, schedule or discard ONE draft. The claim is one guarded
 * `updateMany` from DRAFT (with the AuditLog row in its transaction): two
 * operators — or a click and the expiry sweep — cannot both decide the same
 * draft. Only the winner puts the mail on the queue; if the queue refuses it,
 * the claim is undone (guarded again) and the draft is a DRAFT once more.
 */
export async function applyDraftAction(
  actor: OutboxActor,
  id: string,
  action: OutboundAction,
  opts: { scheduledFor?: Date | null; request?: Request; now?: Date } = {},
): Promise<DraftActionResult> {
  const now = opts.now ?? new Date();
  const scope = await visibleDraftsWhere(actor);
  if (!scope) return { ok: false, httpStatus: 404, code: 'not_found' };
  const row = await runUnscoped(() =>
    prisma.outboundDraft.findFirst({
      where: { AND: [scope, { id }] },
      select: { id: true, orgId: true, status: true, notAfter: true, box: true, category: true, trigger: true, ref: true },
    }),
  );
  if (!row) return { ok: false, httpStatus: 404, code: 'not_found' };

  const allowed = actionAllowed(action, { status: row.status, notAfter: row.notAfter }, now, opts.scheduledFor ?? null);
  if (allowed !== true) return { ok: false, httpStatus: 409, code: allowed };

  let prepared: PreparedEmail | null = null;
  if (action !== 'discard') {
    const env = row.box ? decodeEnvelope(open(row.box, SEAL_PURPOSE)) : null;
    if (!env) return { ok: false, httpStatus: 409, code: 'unreadable' };
    prepared = env as unknown as PreparedEmail;
    // A generated address is nobody (#2970). prepareEmail() refuses one before
    // it can become a draft, but a draft held before that net existed may
    // still carry one: it can only be discarded, never sent or scheduled.
    if (unmailableRecipient(prepared.to)) return { ok: false, httpStatus: 409, code: 'unmailable' };
    // A mail whose attachments are over the queue's cap (a message copy with a
    // photo, a newsletter with a large image) cannot wait on the queue, so it
    // cannot be scheduled — but "send now" delivers it inline below.
    if (action === 'schedule' && !canQueue(prepared)) return { ok: false, httpStatus: 409, code: 'not_queueable' };
  }

  const next = statusAfter(action);
  const scheduledFor = action === 'schedule' ? opts.scheduledFor! : null;
  const detail = JSON.stringify({
    from: row.status,
    to: next,
    category: row.category,
    trigger: row.trigger,
    ...(scheduledFor ? { scheduledFor: scheduledFor.toISOString() } : {}),
  });
  const claimed = await runUnscoped(() =>
    prisma.$transaction(async (tx) => {
      const { count } = await tx.outboundDraft.updateMany({
        where: { id: row.id, orgId: row.orgId, status: 'DRAFT' },
        data: {
          status: next,
          decidedById: actor.id,
          decidedAt: now,
          scheduledFor,
          // A discarded mail is gone: its sealed copy with it.
          ...(action === 'discard' ? { box: null } : {}),
        },
      });
      if (count !== 1) return false;
      await tx.auditLog.create({
        data: { actorId: actor.id, action: AUDIT_ACTION[action], targetId: row.id, orgId: row.orgId, detail },
      });
      return true;
    }),
  );
  if (!claimed) return { ok: false, httpStatus: 409, code: 'conflict' };

  let jobId: string | null = null;
  if (prepared && !canQueue(prepared)) {
    // Send now, inline: the same dispatch an ordinary send takes after the
    // hold (the meter, the breaker, a temporary failure to … nothing: it cannot
    // be queued, so a failure throws). Imported lazily — emailService imports
    // this module for the hook, and a static import back would close the cycle.
    try {
      const { sendPrepared } = await import('@/services/emailService');
      await sendPrepared(prepared);
      await runUnscoped(() =>
        prisma.outboundDraft.updateMany({ where: { id: row.id, orgId: row.orgId, status: next }, data: { box: null } }),
      );
      await settleMailRef(row.ref, 'SENT');
    } catch (e) {
      logger.error('outbound_draft.send_failed', { draftId: row.id, orgId: row.orgId, error: e instanceof Error ? e.name : 'unknown' });
      await runUnscoped(() =>
        prisma.outboundDraft.updateMany({
          where: { id: row.id, orgId: row.orgId, status: next, jobId: null },
          data: { status: 'DRAFT', decidedById: null, decidedAt: null, scheduledFor: null },
        }),
      );
      return { ok: false, httpStatus: 500, code: 'send_failed' };
    }
  } else if (prepared) {
    try {
      const job = await enqueueMail(prepared, {
        reason: 'approved',
        dedupeKey: `draft:${row.id}`,
        notAfter: row.notAfter,
        runAt: scheduledFor ?? now,
        ref: row.ref,
        // The lane's maximum age counts from the moment the mail may leave.
        now: scheduledFor ?? now,
      });
      jobId = job.id;
      // On the queue now: the draft keeps no second copy of the mail.
      await runUnscoped(() =>
        prisma.outboundDraft.updateMany({ where: { id: row.id, orgId: row.orgId, status: next }, data: { jobId, box: null } }),
      );
    } catch (e) {
      logger.error('outbound_draft.enqueue_failed', { draftId: row.id, orgId: row.orgId, error: String(e) });
      // Undo the claim so the operator can try again; guarded, so a concurrent
      // change to the row is not written over.
      await runUnscoped(() =>
        prisma.outboundDraft.updateMany({
          where: { id: row.id, orgId: row.orgId, status: next, jobId: null },
          data: { status: 'DRAFT', decidedById: null, decidedAt: null, scheduledFor: null },
        }),
      );
      return { ok: false, httpStatus: 500, code: 'enqueue_failed' };
    }
  }

  await logActivity({
    action: AUDIT_ACTION[action],
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    targetType: 'outbound_draft',
    targetId: row.id,
    detail,
    orgId: row.orgId,
    request: opts.request,
  });
  return { ok: true, status: next, jobId };
}

/**
 * The same action on up to OUTBOUND_BULK_MAX drafts, one by one through
 * `applyDraftAction()` — the same claim, the same audit row each — with an
 * honest `{ done, skipped[] }`: a draft another operator decided meanwhile is
 * reported, never retried.
 */
export async function applyBulkDraftAction(
  actor: OutboxActor,
  ids: string[],
  action: OutboundAction,
  opts: { scheduledFor?: Date | null; request?: Request; now?: Date } = {},
): Promise<{ done: string[]; skipped: { id: string; code: string }[] }> {
  const unique = [...new Set(ids)].slice(0, OUTBOUND_BULK_MAX);
  const done: string[] = [];
  const skipped: { id: string; code: string }[] = [];
  for (const id of unique) {
    const r = await applyDraftAction(actor, id, action, opts);
    if (r.ok) done.push(id);
    else skipped.push({ id, code: r.code });
  }
  return { done, skipped };
}

// ── Housekeeping ────────────────────────────────────────────────────────────

/**
 * Drafts whose deadline passed without a decision become EXPIRED, and their
 * sealed mail goes. One statement across every tenant (the hourly mail tick).
 */
export async function expireDrafts(now: Date = new Date()): Promise<number> {
  const { count } = await runUnscoped(() =>
    prisma.outboundDraft.updateMany({
      where: { status: 'DRAFT', notAfter: { lte: now } },
      data: { status: 'EXPIRED', box: null, decidedAt: now },
    }),
  );
  if (count) logger.info('outbound_draft.expired', { count });
  return count;
}

/** Days a decided draft (sent, scheduled, discarded, expired) is kept. */
export const OUTBOUND_DRAFT_RETENTION_DAYS = 30;

export async function pruneOutboundDrafts(
  cutoff: Date,
  opts: { batchSize: number; budget: number },
): Promise<{ deleted: number; capped: boolean }> {
  let deleted = 0;
  for (;;) {
    if (deleted >= opts.budget) return { deleted, capped: true };
    const ids = (
      await runUnscoped(() =>
        prisma.outboundDraft.findMany({
          where: { status: { in: ['SENT', 'SCHEDULED', 'DISCARDED', 'EXPIRED'] }, updatedAt: { lt: cutoff } },
          orderBy: { updatedAt: 'asc' },
          select: { id: true },
          take: Math.min(opts.batchSize, opts.budget - deleted),
        }),
      )
    ).map((r) => r.id);
    if (ids.length === 0) return { deleted, capped: false };
    deleted += (await runUnscoped(() => prisma.outboundDraft.deleteMany({ where: { id: { in: ids } } }))).count;
  }
}

/**
 * Erasure: every draft addressed to this person — by their account, and by
 * their address inside their own org (a draft held before they had an account,
 * or to a contact who never had one). Another tenant's drafts are never
 * touched: the address is matched within `orgId` only.
 */
export async function forgetOutboundDrafts(subject: { userId?: string | null; address?: string | null; orgId?: string | null }): Promise<number> {
  const or: Prisma.OutboundDraftWhereInput[] = [];
  if (subject.userId) or.push({ recipientUserId: subject.userId });
  if (subject.address && subject.orgId) or.push({ orgId: subject.orgId, rcpt: recipientHash(subject.address) });
  if (or.length === 0) return 0;
  // An approved draft is on the mail queue (sent-now and not yet drained, or
  // scheduled up to 30 days ahead). Its queued copy goes too, by the job id
  // the approval recorded — not by the bare address, which the account path
  // narrows to one user id and a draft held through the address lookup does
  // not carry.
  const jobIds = (
    await runUnscoped(() =>
      prisma.outboundDraft.findMany({ where: { OR: or, jobId: { not: null } }, select: { jobId: true } }),
    )
  )
    .map((r) => r.jobId)
    .filter((j): j is string => !!j);
  if (jobIds.length) {
    await runUnscoped(() => prisma.job.deleteMany({ where: { id: { in: jobIds }, name: MAIL_JOB_NAME } }));
  }
  return (await runUnscoped(() => prisma.outboundDraft.deleteMany({ where: { OR: or } }))).count;
}
