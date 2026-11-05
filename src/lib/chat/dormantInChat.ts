import { logger } from '@/lib/logger';
import { notifyEvent } from '@/lib/notifications/router';
import { chatCapableUsers } from '@/lib/notifications/adapters/chat';

/**
 * The "still interested?" check-in on chat (#1946) — the CHANNEL of one of the
 * person's two nudges, never a third. sendDormantCheckIns() has already
 * claimed the nudge (`dormantNudgeCount`, the one counter for every channel)
 * before this runs; it asks here first and mails only when this answers
 * false. So a person on chat gets the card INSTEAD of the mail, and anything
 * that stops the card (no confirmed identity, a disabled workspace, a failed
 * post) falls back to the mail — one claimed nudge, one message.
 *
 * `true` means the card went out or is held for the person's quiet hours (it
 * will go, once). NEVER THROWS: a failure here answers false, and the mail goes.
 */
export async function deliverCheckInOnChat(menteeId: string, final: boolean, dedupeKey: string): Promise<boolean> {
  try {
    if (!(await chatCapableUsers([menteeId])).has(menteeId)) return false;
    const result = await notifyEvent(menteeId, final ? 'dormant.checkIn.final' : 'dormant.checkIn.first', {}, {
      channels: ['chat'],
      dedupeKey,
      chatCard: { subjectKey: dedupeKey, actionUrl: null, supersede: false },
    });
    return result.sent + result.queued > 0;
  } catch (e) {
    logger.warning('dormant chat check-in failed', { error: String(e) });
    return false;
  }
}
