import { logger } from '@/lib/logger';
import { notifyEvent } from '@/lib/notifications/router';
import { chatCapableUsers } from '@/lib/notifications/adapters/chat';
import type { EventPayload, NotificationEventKey } from '@/lib/notifications/catalog';

/**
 * Hiring-loop events on chat (#1944): an interview request decided, a panel
 * complete, a panel outcome, an offer sent or answered. The bell and the mail
 * these events already send are untouched — this adds the chat card, and only
 * for people with a confirmed chat identity, so nobody without chat sees any
 * change.
 *
 * The call site names the people it already notifies; WHO may receive the
 * event at all is the catalogue's `audience`, enforced by the router on this
 * card too — a mentee id passed to an internal approval event is refused there,
 * not here. The card's text is the event's own sentence with its declared
 * params only (the router drops anything else) plus the recipient's deep link,
 * so a company's card says exactly what its bell says.
 *
 * NEVER THROWS: chat is an extra channel, never the reason a decision fails.
 */
export async function offerHiringEventInChat<K extends NotificationEventKey>(
  userIds: readonly string[],
  eventKey: K,
  payload: EventPayload<K>,
  subjectKey: string,
): Promise<void> {
  try {
    const capable = await chatCapableUsers([...new Set(userIds)]);
    for (const id of capable) {
      await notifyEvent(id, eventKey, payload, {
        channels: ['chat'],
        dedupeKey: subjectKey,
        chatCard: { subjectKey, actionUrl: null, supersede: false },
      });
    }
  } catch (e) {
    logger.warning('hiring chat card failed', { eventKey, error: String(e) });
  }
}
