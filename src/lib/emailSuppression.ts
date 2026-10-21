import { Prisma, type SuppressionReason } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { runUnscoped } from '@/lib/tenantAmbient';
import { findUsersByEmail, worldUserWhere } from '@/lib/userWorld';
import { toVerticalKey } from '@/lib/verticals';
import type { QueueScope } from '@/lib/mailOpsRule';
import {
  SOFT_BOUNCE_WINDOW_DAYS,
  delistNeedsConfirmation,
  normalizeSuppressedAddress,
  reasonAfter,
  suppressionFor,
  type DeliveryEvent,
  type SuppressionReasonKey,
} from '@/lib/emailSuppressionRule';

// The database half of bounce/complaint suppression (#1692). The rules are
// pure in emailSuppressionRule.ts; this module is the only writer of
// EmailSuppression and EmailDeliveryEvent. Readers: sendEmail()'s gate and the
// queue's drain (`suppressedAmong`), the admin list (`listSuppressions`).
//
// Every query runs `runUnscoped`: the two tables carry no orgId on purpose
// (the schema comment says why), and the admin view applies its own scope.

const P2002 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Which of these addresses are suppressed right now, and why. One query for
 * the whole recipient list. FAILS OPEN on a database error — exactly like the
 * preference gate next to it: a lookup that breaks must not swallow mail.
 */
export async function suppressedAmong(addresses: string[]): Promise<Map<string, SuppressionReasonKey>> {
  const emails = [...new Set(addresses.map(normalizeSuppressedAddress).filter((a): a is string => !!a))];
  const out = new Map<string, SuppressionReasonKey>();
  if (emails.length === 0) return out;
  try {
    const rows = await runUnscoped(() =>
      prisma.emailSuppression.findMany({
        where: { email: { in: emails }, releasedAt: null },
        select: { email: true, reason: true },
      }),
    );
    for (const r of rows) out.set(r.email, r.reason);
  } catch (e) {
    logger.error('email_suppression.lookup_failed', { error: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

export interface IngestSummary {
  received: number;
  duplicates: number;
  suppressed: number;
}

/**
 * Store each provider event once and apply the policy. A replayed event (same
 * provider + event id) is counted as a duplicate and changes nothing — the
 * unique key is the idempotency, so two concurrent deliveries of one event
 * cannot both count.
 */
export async function ingestDeliveryEvents(events: DeliveryEvent[], now = new Date()): Promise<IngestSummary> {
  const summary: IngestSummary = { received: events.length, duplicates: 0, suppressed: 0 };
  for (const ev of events) {
    try {
      await runUnscoped(() =>
        prisma.emailDeliveryEvent.create({
          data: {
            provider: ev.provider,
            eventId: ev.eventId,
            email: ev.email,
            type: ev.type,
            hard: ev.hard,
            detail: ev.detail,
            receivedAt: now,
          },
        }),
      );
    } catch (e) {
      if (P2002(e)) {
        summary.duplicates++;
        continue;
      }
      throw e;
    }
    const softInWindow =
      ev.type === 'bounce' && !ev.hard
        ? await runUnscoped(() =>
            prisma.emailDeliveryEvent.count({
              where: {
                email: ev.email,
                type: 'bounce',
                hard: false,
                receivedAt: { gte: new Date(now.getTime() - SOFT_BOUNCE_WINDOW_DAYS * 86_400_000) },
              },
            }),
          )
        : 0;
    const reason = suppressionFor(ev, softInWindow);
    if (!reason) continue;
    const changed = await suppress(ev.email, reason, { detail: ev.detail, source: ev.provider, now });
    if (changed) summary.suppressed++;
    if (reason === 'COMPLAINT') await turnOffMailFor(ev.email, ev.provider);
  }
  return summary;
}

/**
 * Write (or raise) the suppression of one address. Returns true when the
 * address was not suppressed before this call. A delisted row is re-armed:
 * the history of the delist stays on the ActivityLog, the row says what is
 * true now.
 */
async function suppress(
  email: string,
  reason: SuppressionReasonKey,
  opts: { detail: string | null; source: string; now: Date },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await runUnscoped(() =>
      prisma.emailSuppression.findUnique({ where: { email }, select: { id: true, reason: true, releasedAt: true } }),
    );
    if (!current) {
      try {
        const row = await runUnscoped(() =>
          prisma.emailSuppression.create({
            data: { email, reason: reason as SuppressionReason, detail: opts.detail, source: opts.source, suppressedAt: opts.now },
            select: { id: true },
          }),
        );
        await logActivity({ action: 'email.suppressed', targetType: 'email_suppression', targetId: row.id, detail: `${reason} via ${opts.source}` });
        return true;
      } catch (e) {
        // A concurrent event for the same address created it first: read again.
        if (P2002(e)) continue;
        throw e;
      }
    }
    if (current.releasedAt) {
      await runUnscoped(() =>
        prisma.emailSuppression.update({
          where: { id: current.id },
          data: {
            reason: reason as SuppressionReason,
            detail: opts.detail,
            source: opts.source,
            suppressedAt: opts.now,
            releasedAt: null,
            releasedById: null,
            releaseReason: null,
          },
        }),
      );
      await logActivity({ action: 'email.suppressed', targetType: 'email_suppression', targetId: current.id, detail: `${reason} via ${opts.source} (after delist)` });
      return true;
    }
    const next = reasonAfter(current.reason, reason);
    if (next !== current.reason) {
      await runUnscoped(() =>
        prisma.emailSuppression.update({ where: { id: current.id }, data: { reason: next as SuppressionReason, detail: opts.detail, source: opts.source } }),
      );
    }
    return false;
  }
  return false;
}

/**
 * A complaint is an unsubscribe with feeling: every account this address holds
 * has its e-mail master switch turned off, in every world. The suppression
 * already stops all mail to the address; this is what still holds after an
 * admin delists it, so a delist never silently re-opens the marketing mail the
 * person reported. Crossing worlds is the point here — the complaint is about
 * the mailbox, and a provider's feedback loop does not say which product's
 * mail it was about.
 */
async function turnOffMailFor(email: string, source: string): Promise<void> {
  const users = await runUnscoped(() => findUsersByEmail(email, { id: true, emailNotifications: true }));
  const on = users.filter((u) => u.emailNotifications !== false);
  if (on.length === 0) return;
  await runUnscoped(() => prisma.user.updateMany({ where: { id: { in: on.map((u) => u.id) } }, data: { emailNotifications: false } }));
  for (const u of on) {
    await logActivity({ action: 'email.complaint_opt_out', targetType: 'user', targetId: u.id, detail: `Complaint via ${source}: e-mail notifications turned off` });
  }
}

// ── The admin list ──────────────────────────────────────────────────────────
//
// WHO SEES WHICH ROW. The list is the deployment's, but an address is somebody's
// personal data, so the caller's mail-queue scope (`queueScopeFor()`) decides:
// a super admin sees the addresses that belong to an account of their world
// (plus, in the default world, addresses with no account at all — an invitee,
// an inquiry contact, an operator alert); the default organization's ADMIN sees
// its own users' addresses; nobody else sees anything (403 at the route).
// A row outside the scope is answered as missing (404), never as forbidden.

export interface SuppressionRow {
  id: string;
  email: string;
  reason: SuppressionReasonKey;
  detail: string | null;
  source: string | null;
  suppressedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
}

const LIST_LIMIT = 50;
const CANDIDATES = 200;

/** Which of these addresses the scope may see. */
async function visibleEmails(scope: QueueScope, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const owned = await runUnscoped(() =>
    scope.kind === 'org'
      ? prisma.user.findMany({ where: { email: { in: emails }, orgId: scope.orgId }, select: { email: true } })
      : prisma.user.findMany({ where: { email: { in: emails }, ...worldUserWhere(toVerticalKey(scope.world)) }, select: { email: true } }),
  );
  const seen = new Set(owned.map((u) => u.email.toLowerCase()));
  if (scope.includeOrgless) {
    // Addresses no account holds, in any world — nobody else's personal data
    // to protect from this caller. A count per address set, never a row.
    const anyOwner = await runUnscoped(() =>
      prisma.user.findMany({ where: { email: { in: emails.filter((e) => !seen.has(e)) } }, select: { email: true } }),
    );
    const owned = new Set(anyOwner.map((u) => u.email.toLowerCase()));
    for (const e of emails) if (!owned.has(e)) seen.add(e);
  }
  return seen;
}

function toRow(r: {
  id: string;
  email: string;
  reason: SuppressionReason;
  detail: string | null;
  source: string | null;
  suppressedAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
}): SuppressionRow {
  return {
    id: r.id,
    email: r.email,
    reason: r.reason,
    detail: r.detail,
    source: r.source,
    suppressedAt: r.suppressedAt.toISOString(),
    releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
    releaseReason: r.releaseReason,
  };
}

const ROW_SELECT = {
  id: true,
  email: true,
  reason: true,
  detail: true,
  source: true,
  suppressedAt: true,
  releasedAt: true,
  releaseReason: true,
} as const;

export async function listSuppressions(
  scope: QueueScope,
  opts: { q?: string | null; includeReleased?: boolean } = {},
): Promise<{ rows: SuppressionRow[]; truncated: boolean }> {
  const q = opts.q?.trim().toLowerCase().slice(0, 320) || null;
  const candidates = await runUnscoped(() =>
    prisma.emailSuppression.findMany({
      where: { ...(opts.includeReleased ? {} : { releasedAt: null }), ...(q ? { email: { contains: q } } : {}) },
      orderBy: { suppressedAt: 'desc' },
      take: CANDIDATES,
      select: ROW_SELECT,
    }),
  );
  const visible = await visibleEmails(scope, candidates.map((c) => c.email));
  const rows = candidates.filter((c) => visible.has(c.email)).map(toRow);
  return { rows: rows.slice(0, LIST_LIMIT), truncated: rows.length > LIST_LIMIT || candidates.length === CANDIDATES };
}

export type ReleaseOutcome =
  | { ok: true; row: SuppressionRow }
  | { ok: false; status: 404 | 409; code: 'not_found' | 'already_released' | 'complaint_confirm_required' };

/**
 * Delist one address: a guarded update (only an ACTIVE row moves) plus the
 * ActivityLog line with actor and reason. A complaint needs `confirm: true` —
 * the person told their provider this sender is spam, and the admin must say
 * they know that. The person's switched-off preferences are NOT switched back
 * on: that is theirs to do.
 */
export async function releaseSuppression(
  scope: QueueScope,
  id: string,
  input: { actorId: string; reason: string; confirm: boolean; request?: Request },
): Promise<ReleaseOutcome> {
  const row = await runUnscoped(() => prisma.emailSuppression.findUnique({ where: { id }, select: ROW_SELECT }));
  if (!row || !(await visibleEmails(scope, [row.email])).has(row.email)) return { ok: false, status: 404, code: 'not_found' };
  if (row.releasedAt) return { ok: false, status: 409, code: 'already_released' };
  if (delistNeedsConfirmation(row.reason) && !input.confirm) return { ok: false, status: 409, code: 'complaint_confirm_required' };
  const now = new Date();
  const moved = await runUnscoped(() =>
    prisma.emailSuppression.updateMany({
      where: { id, releasedAt: null },
      data: { releasedAt: now, releasedById: input.actorId, releaseReason: input.reason },
    }),
  );
  if (moved.count === 0) return { ok: false, status: 409, code: 'already_released' };
  // ActivityLog.detail is VARCHAR(191): the reason code and the head of the
  // note; the full note stays on the row.
  await logActivity({
    action: 'email.suppression_released',
    actorId: input.actorId,
    targetType: 'email_suppression',
    targetId: id,
    detail: `${row.reason}: ${input.reason}`.slice(0, 191),
    request: input.request ?? null,
  });
  return { ok: true, row: toRow({ ...row, releasedAt: now, releaseReason: input.reason }) };
}

/** Retention (key 'emailDeliveryEvent'): events older than the window. */
export async function pruneDeliveryEvents(cutoff: Date, opts: { batchSize: number; budget: number }): Promise<{ deleted: number; capped: boolean }> {
  let deleted = 0;
  for (;;) {
    if (deleted >= opts.budget) return { deleted, capped: true };
    const ids = (
      await runUnscoped(() =>
        prisma.emailDeliveryEvent.findMany({
          where: { receivedAt: { lt: cutoff } },
          orderBy: { receivedAt: 'asc' },
          select: { id: true },
          take: Math.min(opts.batchSize, opts.budget - deleted),
        }),
      )
    ).map((r) => r.id);
    if (ids.length === 0) return { deleted, capped: false };
    deleted += (await runUnscoped(() => prisma.emailDeliveryEvent.deleteMany({ where: { id: { in: ids } } }))).count;
  }
}
