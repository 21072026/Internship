// `application.stage_changed` (#1998) leaves AFTER the commit, never inside it.
//
// moveApplicationStage() — the one writer of Application.stage — runs inside
// its caller's transaction, and several callers roll that transaction back
// after a successful move (the panel outcome refuses when the seal loses its
// race; the bulk route answers a conflict). `emit()` writes through the global
// client, so an emit from inside the writer would announce a move the database
// then forgot. Instead the writer NOTES each move in the store this module
// opens, and `stageTransaction()` raises the noted events once
// `prisma.$transaction` has resolved — a rejected transaction raises nothing.
//
// Every caller of the writer (directly or through the three write-through
// hooks in applicationStage.ts) opens its transaction with stageTransaction().
// A move noted outside one throws outside production — a forgotten wrapper is
// a red test, not a silently missing event — and is logged in production.
//
// Server-only (node:async_hooks), like src/lib/orgContext.ts.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { emit } from '@/lib/events/emit';

export interface NotedStageMove {
  applicationId: string;
  fromStage: string;
  toStage: string;
  actorId: string | null;
}

const store = new AsyncLocalStorage<NotedStageMove[]>();

/** Called by moveApplicationStage() after its guarded write and its ApplicationEvent row. */
export function noteStageMove(move: NotedStageMove): void {
  const pending = store.getStore();
  if (pending) {
    pending.push(move);
    return;
  }
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('moveApplicationStage() ran outside stageTransaction(): its application.stage_changed would be lost');
  }
  logger.error('application.stage_event_unscoped', { applicationId: move.applicationId });
}

/**
 * `prisma.$transaction(fn, options)`, plus one `application.stage_changed` per
 * stage move the transaction committed, in the order they were made.
 */
export async function stageTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  const pending: NotedStageMove[] = [];
  const result = await store.run(pending, () => prisma.$transaction(fn, options));
  if (pending.length > 0) await raiseStageEvents(pending);
  return result;
}

async function raiseStageEvents(moves: NotedStageMove[]): Promise<void> {
  // The writer only knows the id; the org and the requisition are read once,
  // after the commit, for every move of the transaction.
  const rows = await prisma.application.findMany({
    where: { id: { in: [...new Set(moves.map((m) => m.applicationId))] } },
    select: { id: true, orgId: true, requisitionId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const m of moves) {
    const row = byId.get(m.applicationId);
    if (!row) continue;
    // Ids and stage keys only: never the note or the disposition code (a
    // rejection reason is the programme's, not a receiver's, #1801).
    await emit(
      'application.stage_changed',
      { applicationId: m.applicationId, requisitionId: row.requisitionId, from: m.fromStage, to: m.toStage },
      { orgId: row.orgId, actor: m.actorId ? { id: m.actorId, type: 'user' } : { id: null, type: 'system' } },
    );
  }
}
