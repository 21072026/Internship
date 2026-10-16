import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

// What a queued mail's sender learns when the mail settles (#2951).
//
// A mail on the queue carries a `ref` (`Job.payload.ref`). Most refs are only
// an identity (`fallbackRef()`), but a sender that keeps its OWN per-recipient
// record — the newsletter's `NewsletterSend` — writes that record as QUEUED and
// names it in the ref, and the drain calls `settleMailRef()` once the mail is
// delivered, dead, expired or cancelled. The record then says what really
// happened instead of what the enqueue hoped.
//
// WHY A PREFIX TABLE AND NOT A CALLBACK. The drain runs in another tick — often
// another process — than the request that queued the mail, so there is no
// callback to call: the ref is data, and this module maps its prefix to one
// guarded write. It imports Prisma and nothing of the senders, so the outbox
// can call it without the import cycle a call into newsletterDispatch.ts would
// close (that module imports emailService, which imports the outbox).
//
// Every hook is ONE guarded statement on a row still QUEUED: a second settle
// (the reconciliation below racing the drain) changes nothing.

/** The outcome of a queued mail, as a sender's record states it. */
export type MailRefOutcome = 'SENT' | 'FAILED' | 'SKIPPED';

const NEWSLETTER_PREFIX = 'nlsend:';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The ref a newsletter recipient's queued copy carries. */
export function newsletterSendRef(newsletterId: string, userId: string): string {
  return `${NEWSLETTER_PREFIX}${newsletterId}:${userId}`;
}

function parseNewsletterRef(ref: string): { newsletterId: string; userId: string } | null {
  if (!ref.startsWith(NEWSLETTER_PREFIX)) return null;
  const [newsletterId, userId, ...rest] = ref.slice(NEWSLETTER_PREFIX.length).split(':');
  if (rest.length || !newsletterId || !userId || !ID.test(newsletterId) || !ID.test(userId)) return null;
  return { newsletterId, userId };
}

/**
 * A queued `Job` row's terminal state as a sender's outcome: delivered (or
 * delivered inline after all) is SENT, cancelled because the reader opted out
 * in the meantime is SKIPPED, everything else that ended it is FAILED. Null
 * while the row is still on its way.
 */
export function outcomeOfJob(status: string, lastError: string | null | undefined): MailRefOutcome | null {
  if (status === 'SUCCEEDED') return 'SENT';
  if (status === 'FAILED' || status === 'DEAD_LETTER') return 'FAILED';
  if (status === 'CANCELLED') {
    if (lastError === 'unsubscribed') return 'SKIPPED';
    if (lastError === 'sent_inline') return 'SENT';
    return 'FAILED';
  }
  return null;
}

/**
 * Settle the sender's record behind `ref`. Never throws: the mail itself is
 * already settled, and a bookkeeping failure must not undo that. True when a
 * record changed.
 */
export async function settleMailRef(ref: string | null | undefined, outcome: MailRefOutcome, error?: string | null): Promise<boolean> {
  if (!ref) return false;
  const nl = parseNewsletterRef(ref);
  if (!nl) return false;
  try {
    const { count } = await prisma.newsletterSend.updateMany({
      where: { newsletterId: nl.newsletterId, userId: nl.userId, status: 'QUEUED' },
      data: { status: outcome, error: outcome === 'SENT' ? null : (error ?? null)?.slice(0, 2000) ?? null },
    });
    if (count !== 1) return false;
    // The issue's tally counted this recipient as reached when it was queued;
    // a queued copy that did not arrive moves to the column it belongs in.
    if (outcome !== 'SENT') {
      await prisma.newsletter.updateMany({
        where: { id: nl.newsletterId, sentCount: { gt: 0 } },
        data: {
          sentCount: { decrement: 1 },
          ...(outcome === 'FAILED' ? { failedCount: { increment: 1 } } : { skippedCount: { increment: 1 } }),
        },
      });
    }
    return true;
  } catch (e) {
    logger.warning('mail_outbox.ref_settle_failed', { kind: 'newsletter', error: e instanceof Error ? e.name : 'unknown' });
    return false;
  }
}
