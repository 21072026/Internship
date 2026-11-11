// The placement subscriber (#1765): `pipeline.stage_change` → reconcile the
// relation's row in the placement ledger (src/lib/placementLedger.ts). The
// ledger is imported lazily, like the automation evaluator, so loading the
// registry (which `emit()` does) never pulls Prisma queries into every
// producer's module graph.
//
// Rerun-safe: the handler reads the relation's CURRENT stage rather than the
// event's `to`, so a redelivery or an out-of-order delivery converges on the
// same row, and `Placement.relationId` is unique.
import type { SubscriberDefinition } from '../subscribers';

export const PLACEMENT_SUBSCRIBER = 'placement';

export const placementSubscriber: SubscriberDefinition = {
  name: PLACEMENT_SUBSCRIBER,
  events: ['pipeline.stage_change'],
  handle: async (event) => {
    const relationId = typeof event.payload.relationId === 'string' ? event.payload.relationId : null;
    if (!relationId) return;
    const { syncPlacementForRelation } = await import('@/lib/placementLedger');
    await syncPlacementForRelation(relationId);
  },
};
