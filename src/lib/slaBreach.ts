// SlaBreach state (#1722) — the only writer of the table. Server-only.
//
// The rule (levels, who is excluded, what acknowledge and snooze mean) is pure
// in src/lib/slaLadderRule.ts; the daily sweep that opens and climbs breaches
// is `checkStageDeadlineReminders()` in src/services/emailService.ts, because
// the mail it sends is rendered there. Everything that changes a row is a
// conditional `updateMany` (or a unique-keyed insert), so two overlapping
// sweeps — or a sweep racing a stage move — cannot both win a transition.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { notifyEvent } from '@/lib/notifications/router';
import { SLA_LEVEL_ADMIN, SLA_LEVEL_MENTOR } from '@/lib/slaLadderRule';
import type { HeaderSource } from '@/lib/clientIp';

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

/**
 * Open the breach of `dueAt` for a relation at level 1. Returns the row when
 * THIS call opened it, null when it already existed (the unique key is
 * `(relationId, dueAt)`), which is what keeps a double-fired sweep from telling
 * the mentor twice.
 */
export async function openBreach(input: {
  orgId: string | null;
  relationId: string;
  stageKey: string;
  dueAt: Date;
  now: Date;
}): Promise<{ id: string } | null> {
  try {
    return await prisma.slaBreach.create({
      data: {
        orgId: input.orgId,
        relationId: input.relationId,
        stageKey: input.stageKey,
        dueAt: input.dueAt,
        level: SLA_LEVEL_MENTOR,
        lastEscalatedAt: input.now,
      },
      select: { id: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

/**
 * Climb one rung. The WHERE repeats every condition the sweep checked, so an
 * acknowledgement or a snooze that lands between the read and this write wins.
 */
export async function claimEscalation(id: string, fromLevel: number, now: Date): Promise<boolean> {
  const { count } = await prisma.slaBreach.updateMany({
    where: {
      id,
      level: fromLevel,
      resolvedAt: null,
      acknowledgedAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
    data: { level: fromLevel + 1, lastEscalatedAt: now },
  });
  return count === 1;
}

/** The people level 2 tells: the active administrators of the relation's org. */
export async function escalationRecipients(orgId: string | null) {
  return prisma.user.findMany({
    where: { orgId, role: 'ADMIN', isActive: true },
    select: {
      id: true,
      role: true,
      email: true,
      fullName: true,
      preferredLanguage: true,
      emailNotifications: true,
      notificationPrefs: true,
      orgId: true,
    },
  });
}

/**
 * Close open breaches. Called with a relation id from every stage move (the
 * stage clock restarted, so the old breach is over) and with explicit ids from
 * the sweep (the deadline was cleared, moved into the future, or the relation
 * left ACTIVE / entered the pool). Each row is closed by its own guarded write;
 * administrators who were escalated to hear that it cleared — the mentor moved
 * it, so the mentor needs no news.
 */
export async function resolveBreaches(
  where: { relationId: string } | { ids: string[] },
  now: Date = new Date()
): Promise<number> {
  const filter: Prisma.SlaBreachWhereInput =
    'ids' in where ? { id: { in: where.ids }, resolvedAt: null } : { relationId: where.relationId, resolvedAt: null };
  if ('ids' in where && where.ids.length === 0) return 0;
  let resolved = 0;
  try {
    const open = await prisma.slaBreach.findMany({
      where: filter,
      select: {
        id: true,
        orgId: true,
        level: true,
        relationId: true,
        relation: { select: { menteeId: true, mentee: { select: { fullName: true } } } },
      },
    });
    for (const b of open) {
      const { count } = await prisma.slaBreach.updateMany({
        where: { id: b.id, resolvedAt: null },
        data: { resolvedAt: now },
      });
      if (count !== 1) continue;
      resolved++;
      if (b.level >= SLA_LEVEL_ADMIN) {
        const admins = await escalationRecipients(b.orgId);
        await notifyEvent(
          admins,
          'deadline.slaResolved',
          { menteeName: b.relation.mentee.fullName, relationId: b.relationId, menteeId: b.relation.menteeId },
          { channels: ['inApp'], orgId: b.orgId, dedupeKey: `sla-resolved:${b.id}` }
        );
      }
    }
  } catch (e) {
    // A stage move must never fail because its breach could not be closed; the
    // next sweep closes it (the relation is no longer past this deadline).
    logger.error('Failed to resolve SLA breaches', { error: String(e) });
  }
  return resolved;
}

type Actor = { id: string; email?: string | null };

/**
 * Acknowledge an open breach: somebody has it in hand, so it climbs no further.
 * It stays open — the stage still has not moved. `orgId` comes from the
 * caller's session and is part of the WHERE, so another tenant's id is simply
 * not found. Audited.
 */
export async function acknowledgeBreach(
  id: string,
  orgId: string,
  actor: Actor,
  request?: HeaderSource | null,
  now: Date = new Date()
): Promise<'ok' | 'missing'> {
  const { count } = await prisma.slaBreach.updateMany({
    where: { id, orgId, resolvedAt: null, acknowledgedAt: null },
    data: { acknowledgedAt: now, acknowledgedById: actor.id },
  });
  if (count !== 1) {
    // Already acknowledged is not an error for the person who clicked twice.
    const exists = await prisma.slaBreach.count({ where: { id, orgId, resolvedAt: null } });
    return exists ? 'ok' : 'missing';
  }
  await logActivity({
    orgId,
    action: 'sla.breach_acknowledged',
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    targetType: 'sla_breach',
    targetId: id,
    request,
  });
  return 'ok';
}

/**
 * Hold an open breach's escalation until `until`. The reason is free text and
 * goes ONLY to the admin-read ActivityLog, never onto the row: relation reads
 * hand their scalars to the mentor and the mentee, and a note about a person
 * must not be read back to them (#1801).
 */
export async function snoozeBreach(
  id: string,
  orgId: string,
  actor: Actor,
  until: Date,
  reason: string,
  request?: HeaderSource | null
): Promise<'ok' | 'missing'> {
  const { count } = await prisma.slaBreach.updateMany({
    where: { id, orgId, resolvedAt: null },
    data: { snoozedUntil: until },
  });
  if (count !== 1) return 'missing';
  await logActivity({
    orgId,
    action: 'sla.breach_snoozed',
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    targetType: 'sla_breach',
    targetId: id,
    detail: `until ${until.toISOString()}: ${reason}`.slice(0, 1000),
    request,
  });
  return 'ok';
}
