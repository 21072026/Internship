// The ONE writer of SafeguardingFlag rows (#2056). Every message write path —
// the in-app composer, an edit, the mentor's e-mail, the inbound mail bridge —
// calls `scanMessageForSafeguarding` after the message row exists. The rule it
// applies lives in src/lib/safeguarding.ts; this file only meets the database.
//
// NEVER BLOCKS, NEVER THROWS. The message is already written when this runs,
// and nothing here can undo or delay its delivery: a failure is logged and the
// send carries on. That is a product decision (see the issue), not caution —
// a safeguarding check that can swallow a mentee's message is worse than the
// risk it guards against.
//
// SERVER-ONLY: touches Prisma.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getSetting } from '@/lib/settings';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { tenantAdminIds } from '@/lib/tenantAdmins';
import { notify } from '@/lib/notify';
import { parseWatchKeywords, scanMessageBody } from '@/lib/safeguarding';

/** The bell type an admin gets; rendered from `notifications.events`. */
export const SAFEGUARDING_NOTIFICATION_TYPE = 'safeguarding.flagged';

/** Where the bell entry points. */
export const SAFEGUARDING_QUEUE_PATH = '/admin/safeguarding';

/**
 * One bell entry per admin per window, however many messages are flagged in it.
 * A burst of flagged messages (one conversation swapping numbers back and forth)
 * is one thing to look at, and a bell that rings ten times for it trains people
 * to ignore it — the same failure the false-positive rules guard against.
 */
const NOTIFY_WINDOW_MS = 60 * 60 * 1000;

export interface SafeguardingScanInput {
  messageId: string;
  body: string;
  senderId: string;
  /**
   * True for a message that ARRIVED by e-mail (the inbound reply bridge). Its
   * contact details are not checked: every mail carries a signature, and the
   * channel itself already exchanged addresses. Keywords still are. A mail the
   * mentor COMPOSED in the app is not this — it is scanned like any message.
   */
  arrivedByEmail?: boolean;
}

/**
 * Scan one message and record what it should be flagged for. Returns how many
 * NEW flags were written (0 on a re-scan of an unchanged edit, and on any error).
 */
export async function scanMessageForSafeguarding(input: SafeguardingScanInput): Promise<number> {
  try {
    if (!input.body?.trim()) return 0;
    const sender = await prisma.user.findUnique({
      where: { id: input.senderId },
      select: { orgId: true, role: true },
    });
    // Staff are not the subject of a duty-of-care check: an admin posting into a
    // thread to give out the programme office's number is the programme working.
    if (!sender || sender.role === 'ADMIN') return 0;

    // The SENDER's org decides the watch list and owns the flag — an org-less
    // account belongs to the default org (src/lib/settingsOrg.ts), never to
    // "everybody".
    const orgId = await settingsOrgOfRow(sender.orgId);
    const keywords = parseWatchKeywords(await getSetting('safeguardingKeywords', orgId));
    const findings = scanMessageBody(input.body, {
      keywords,
      skipContactDetails: input.arrivedByEmail === true,
    });
    if (findings.length === 0) return 0;

    const { count } = await prisma.safeguardingFlag.createMany({
      data: findings.map((f) => ({
        orgId,
        messageId: input.messageId,
        kind: f.kind,
        matchedTerm: f.matchedTerm,
      })),
      // @@unique([messageId, kind, matchedTerm]) — an edit that keeps the same
      // number does not raise a second flag for it.
      skipDuplicates: true,
    });
    if (count > 0) await notifyAdmins(orgId);
    return count;
  } catch (e) {
    logger.error('Safeguarding scan failed', { messageId: input.messageId, error: String(e) });
    return 0;
  }
}

async function notifyAdmins(orgId: string): Promise<void> {
  const since = new Date(Date.now() - NOTIFY_WINDOW_MS);
  const admins = await tenantAdminIds(orgId);
  for (const adminId of admins) {
    const recent = await prisma.notification.findFirst({
      where: { userId: adminId, type: SAFEGUARDING_NOTIFICATION_TYPE, read: false, createdAt: { gte: since } },
      select: { id: true },
    });
    if (recent) continue;
    // No params: the bell says "a message needs a safeguarding review", never
    // who wrote it or what it said — the queue, behind its own route check, is
    // the only place that detail is shown.
    await notify(adminId, SAFEGUARDING_NOTIFICATION_TYPE, {}, SAFEGUARDING_QUEUE_PATH);
  }
}
