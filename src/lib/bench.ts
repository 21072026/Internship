// The bench (#1778) — the one writer of User.participantState. Server-only.
// The vocabulary and the rules are src/lib/participantState.ts.
//
// Three things a bench never does, and this file is where they are kept out:
//   · it never touches `isActive` — a benched person still signs in;
//   · it never stamps `sessionsValidFrom` — that is revocation, and anything
//     that sets it must also call revokeAllTrustedDevices(); a bench does
//     neither;
//   · it never moves `consentAt` — the retention clock. An optional
//     "write to them again on…" date goes through joinPool()
//     (src/lib/reEngagement.ts), which needs the person's own pool consent and
//     never touches consentAt either.

import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { joinPool } from '@/lib/reEngagement';
import { BENCHED } from '@/lib/participantState';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';

export interface BenchInput {
  tenant: TenantWhere;
  userIds: readonly string[];
  benched: boolean;
  actorId: string;
  actorEmail?: string | null;
  reason?: string | null;
  /** Bench only: when to write to them again (needs their pool consent). */
  reEngageAt?: Date | null;
  request?: Request;
}

export interface BenchResult {
  /** People whose state changed. */
  changed: number;
  /** Benched people put in the re-engagement pool (had consent). */
  pooled: number;
  /** Benched people with a date but no pool consent: not pooled. */
  noConsent: number;
}

/**
 * Bench (or return to active) the given people of the caller's tenant. ADMIN,
 * MENTOR and MENTEE accounts only — a COMPANY or SOURCE login is not a
 * participant. One guarded updateMany (only rows not already in the target
 * state change), then one activity entry per person who changed.
 */
export async function setBench(input: BenchInput): Promise<BenchResult> {
  const target = input.benched ? BENCHED : 'ACTIVE';
  const rows = await prisma.user.findMany({
    where: withinTenant({ id: { in: [...input.userIds] }, role: { in: ['ADMIN', 'MENTOR', 'MENTEE'] as ('ADMIN' | 'MENTOR' | 'MENTEE')[] }, participantState: { not: target } }, input.tenant),
    select: { id: true, orgId: true },
  });
  if (rows.length === 0) return { changed: 0, pooled: 0, noConsent: 0 };
  const ids = rows.map((r) => r.id);
  const now = new Date();
  const res = await prisma.user.updateMany({
    where: { id: { in: ids }, participantState: { not: target } },
    data: input.benched
      ? { participantState: BENCHED, benchedAt: now, benchedReason: input.reason?.trim() || null, benchedById: input.actorId }
      : { participantState: 'ACTIVE', benchedAt: null, benchedReason: null, benchedById: null },
  });

  let pooled = 0;
  let noConsent = 0;
  if (input.benched && input.reEngageAt) {
    for (const id of ids) {
      if (await joinPool(id, { at: input.reEngageAt, note: null })) pooled += 1;
      else noConsent += 1;
    }
  }
  for (const r of rows) {
    await logActivity({
      action: input.benched ? 'user.benched' : 'user.unbenched',
      actorId: input.actorId,
      actorEmail: input.actorEmail ?? null,
      targetType: 'User',
      targetId: r.id,
      request: input.request,
      orgId: r.orgId,
    });
  }
  return { changed: res.count, pooled, noConsent };
}
