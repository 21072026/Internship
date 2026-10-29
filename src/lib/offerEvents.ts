// The offer lifecycle on the event bus (#1998). Server-only.
//
// An offer changes status in two places — the actions of PATCH
// /api/offers/[id] (send, withdraw, accept, decline) and the expiry sweep
// (expireOffers(), src/lib/offerNotify.ts) — and both raise through here, so
// the payload is built once. Ids only: never the position, the compensation
// (OFFER_COMPENSATION_FIELDS, src/lib/offers.ts), the decline reason or note.
// Always after the status flip has committed.
import { prisma } from '@/lib/prisma';
import { emit } from '@/lib/events/emit';
import type { EventActorType } from '@/lib/events/catalog';

export type OfferEventName = 'offer.sent' | 'offer.withdrawn' | 'offer.accepted' | 'offer.declined' | 'offer.expired';

export interface OfferEventSubject {
  id: string;
  orgId: string | null;
  requisitionId: string | null;
  menteeId: string;
}

export async function raiseOfferEvent(
  name: OfferEventName,
  offer: OfferEventSubject,
  actor: { id: string | null; type: EventActorType },
): Promise<void> {
  // The candidate's application for the offer's requisition, when there is one
  // — the record an ATS keys on. Read, never created.
  const application = offer.requisitionId
    ? await prisma.application.findUnique({
        where: { requisitionId_menteeId: { requisitionId: offer.requisitionId, menteeId: offer.menteeId } },
        select: { id: true },
      })
    : null;
  await emit(
    name,
    { offerId: offer.id, applicationId: application?.id ?? null, requisitionId: offer.requisitionId },
    { orgId: offer.orgId, actor },
  );
}
