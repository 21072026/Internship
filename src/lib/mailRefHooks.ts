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
// Every hook is ONE guarded statement on a row still QUEUED (or HELD, for a
// copy an operator approved, #2960): a second settle (the reconciliation below
// racing the drain) changes nothing.

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
    if (count !== 1) return settleHeldNewsletterSend(nl, outcome, error);
    // The issue's tally counts this recipient as reached when it was queued;
    // a queued copy that did not arrive moves to the column it belongs in.
    // Unguarded on purpose: during a first run the dispatch adds its tally only
    // at the end, so a copy settled mid-run takes sentCount to -1 for a moment
    // and the final increment nets it out — a `sentCount > 0` guard here lost
    // the correction instead.
    if (outcome !== 'SENT') {
      await prisma.newsletter.updateMany({
        where: { id: nl.newsletterId },
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

/**
 * A recipient whose copy was HELD for approval (#2960) was recorded HELD and
 * counted with the skipped; an operator's approval later delivered (or lost)
 * it through the queue or inline. The record moves out of HELD once, guarded,
 * and the issue's tally moves the recipient from "skipped" to the column the
 * outcome belongs in. A draft that is discarded or expires never settles, so
 * its record stays HELD — the truth: it never reached anyone.
 */
async function settleHeldNewsletterSend(
  nl: { newsletterId: string; userId: string },
  outcome: MailRefOutcome,
  error?: string | null,
): Promise<boolean> {
  const { count } = await prisma.newsletterSend.updateMany({
    where: { newsletterId: nl.newsletterId, userId: nl.userId, status: 'HELD' },
    data: { status: outcome, error: outcome === 'SENT' ? null : (error ?? null)?.slice(0, 2000) ?? null },
  });
  if (count !== 1) return false;
  if (outcome !== 'SKIPPED') {
    await prisma.newsletter.updateMany({
      where: { id: nl.newsletterId },
      data: {
        skippedCount: { decrement: 1 },
        ...(outcome === 'SENT' ? { sentCount: { increment: 1 } } : { failedCount: { increment: 1 } }),
      },
    });
  }
  return true;
}

/** The client `reopenMailRef()` writes through: Prisma, or a transaction. */
type RefClient = Pick<typeof prisma, 'newsletterSend' | 'newsletter'>;

/**
 * Undo a FAILED settle because an operator put the mail back on the queue
 * (#2953, the Queue tab's retry): the sender's record goes back to QUEUED and
 * the issue's tally back to "reached", exactly reversing what `settleMailRef()`
 * moved — so the drain's eventual SENT (or a second FAILED) settles it again
 * and the archive says what really happened. Called INSIDE the retry's
 * transaction with that transaction's client: the queue row and the record
 * move together or not at all. One guarded statement on a record still
 * FAILED; a ref with no record of its own (every non-newsletter mail) changes
 * nothing. True when a record changed.
 */
export async function reopenMailRef(ref: string | null | undefined, client: RefClient = prisma): Promise<boolean> {
  if (!ref) return false;
  const nl = parseNewsletterRef(ref);
  if (!nl) return false;
  const { count } = await client.newsletterSend.updateMany({
    where: { newsletterId: nl.newsletterId, userId: nl.userId, status: 'FAILED' },
    data: { status: 'QUEUED', error: null },
  });
  if (count !== 1) return false;
  await client.newsletter.updateMany({
    where: { id: nl.newsletterId },
    data: { sentCount: { increment: 1 }, failedCount: { decrement: 1 } },
  });
  return true;
}
