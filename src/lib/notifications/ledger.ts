// The NotificationDelivery ledger (#1710): one row per (person, event, channel,
// send identity). The router claims and records here; a channel that settles
// later (the e-mail job, #1711) settles here. Never throws.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { NotificationChannel } from './catalog';
import type { SkipReason } from './adapters/types';

export interface LedgerRow {
  orgId: string | null;
  userId: string;
  eventKey: string;
  channel: NotificationChannel;
  dedupeKey: string;
}

export function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

/**
 * Record a delivery that will not be attempted. Written with the same dedupe
 * key the send would have used, so a repeat of the same suppressed send does
 * not pile up rows — and so an operator reading the ledger sees one line per
 * (person, event, channel) whatever happened to it.
 */
export async function recordSkipped(row: LedgerRow, reason: SkipReason): Promise<void> {
  try {
    await prisma.notificationDelivery.create({
      data: { ...row, status: 'SKIPPED', skipReason: reason },
    });
  } catch (e) {
    // A duplicate here means the same suppressed send was already recorded:
    // that is the idempotency working, not a failure worth logging loudly.
    if (!isUniqueViolation(e)) {
      logger.error('Failed to record skipped notification delivery', {
        userId: row.userId,
        eventKey: row.eventKey,
        channel: row.channel,
        error: String(e),
      });
    }
  }
}

/**
 * Claim the right to send. Returns the row id when this call created it, and
 * `null` when an identical send already exists (or the ledger write failed —
 * see below).
 *
 * A failed claim FAILS CLOSED. If the ledger is unwritable we do not send: a
 * send whose record was lost is exactly the "did anybody actually tell them?"
 * hole this ledger exists to close, and a retry would have no way to know the
 * first attempt happened. The caller's own work has already committed either
 * way, so nothing is rolled back by declining to notify.
 */
export async function claimDelivery(row: LedgerRow): Promise<string | null> {
  try {
    const created = await prisma.notificationDelivery.create({ data: { ...row, status: 'QUEUED' } });
    return created.id;
  } catch (e) {
    if (!isUniqueViolation(e)) {
      logger.error('Failed to claim notification delivery', {
        userId: row.userId,
        eventKey: row.eventKey,
        channel: row.channel,
        error: String(e),
      });
    }
    return null;
  }
}

export async function settleDelivery(
  id: string,
  status: 'SENT' | 'FAILED' | 'QUEUED' | 'SKIPPED',
  extra?: { error?: string; templateId?: string; skipReason?: SkipReason }
): Promise<void> {
  try {
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        status,
        error: extra?.error?.slice(0, 2000) ?? null,
        templateId: extra?.templateId ?? null,
        skipReason: extra?.skipReason ?? null,
      },
    });
  } catch (e) {
    logger.error('Failed to settle notification delivery', { id, status, error: String(e) });
  }
}
