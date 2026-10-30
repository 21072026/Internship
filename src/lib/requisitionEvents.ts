// `requisition.status_changed` (#1998), raised by every writer of
// Requisition.status: the create route (`from` null), the edit route, the
// acceptance that takes the last opening (src/lib/hiringOutcome.ts) and the
// sample programme. Server-only.
//
// Like createUser(): on the root client the event is emitted after the write;
// on a transaction client it is written through that transaction
// (emitInTransaction), so a rolled-back edit raises nothing. An edit that
// leaves the status where it was raises nothing either.
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { emit, emitInTransaction } from '@/lib/events/emit';

export async function raiseRequisitionStatus(
  db: typeof prisma | Prisma.TransactionClient,
  change: { requisitionId: string; orgId: string | null; from: string | null; to: string },
  actorId?: string | null,
): Promise<void> {
  if (change.from === change.to) return;
  const payload = { requisitionId: change.requisitionId, from: change.from, to: change.to };
  const ctx = { orgId: change.orgId, actor: actorId ? { id: actorId, type: 'user' as const } : { id: null, type: 'system' as const } };
  if (db === prisma) await emit('requisition.status_changed', payload, ctx);
  else await emitInTransaction(db as Prisma.TransactionClient, 'requisition.status_changed', payload, ctx);
}
