import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { routeInboundEmail } from '@/lib/inboundEmail';
import { logger } from '@/lib/logger';

// The mail bridge: drains the reply mailbox over IMAP and feeds each message
// through `routeInboundEmail`, which is the same routing used by
// `POST /api/inbound-email`. This is the piece that closes the loop on
// reply-by-email — outgoing message notifications carry
// `Reply-To: reply+<relationId>.<hmac>@<INBOUND_EMAIL_DOMAIN>`, and whatever
// lands in that mailbox reappears in the thread as a `channel: EMAIL` message.
//
// The bridge only runs where IMAP credentials are configured (production), so
// the preview and per-PR containers never compete for the same mailbox — two
// pollers on one mailbox would race over the \Seen flag.

const MAX_PER_TICK = 50;

type BridgeConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
};

export function bridgeConfig(): BridgeConfig | null {
  const host = process.env.INBOUND_IMAP_HOST;
  const user = process.env.INBOUND_IMAP_USER;
  const pass = process.env.INBOUND_IMAP_PASS;
  if (!host || !user || !pass) return null;
  if (process.env.INBOUND_IMAP_ENABLED === '0') return null;
  return {
    host,
    user,
    pass,
    port: Number(process.env.INBOUND_IMAP_PORT || 993),
    secure: process.env.INBOUND_IMAP_SECURE !== '0',
    mailbox: process.env.INBOUND_IMAP_MAILBOX || 'INBOX',
  };
}

// Every header that can carry the reply+ address. Gmail and friends put it in
// To/Cc; the MTA adds Delivered-To/X-Original-To, which is what survives when
// the address was reached through a catch-all or an alias.
const RECIPIENT_HEADERS = ['delivered-to', 'x-original-to', 'to', 'cc', 'x-envelope-to'];

export function recipientCandidates(headerLines: readonly { key: string; line: string }[]): string {
  return headerLines
    .filter((h) => RECIPIENT_HEADERS.includes(h.key.toLowerCase()))
    .map((h) => h.line)
    .join(' ');
}

export type PollSummary = { fetched: number; routed: number; skipped: number; failed: number };

// Drain one batch. Safe to call concurrently-ish: a message is only flagged
// \Seen once it has been routed (or permanently rejected), so a crash mid-batch
// replays it next tick and the Message-ID guard in routeInboundEmail keeps that
// replay from duplicating the reply.
export async function pollInboundMailbox(): Promise<PollSummary> {
  const cfg = bridgeConfig();
  const summary: PollSummary = { fetched: 0, routed: 0, skipped: 0, failed: 0 };
  if (!cfg) return summary;

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(0, MAX_PER_TICK)) {
        summary.fetched++;
        let handled = false;
        try {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) {
            summary.failed++;
            continue;
          }
          const mail = await simpleParser(msg.source);
          const to = recipientCandidates(mail.headerLines);
          const from = mail.from?.value?.[0]?.address || '';

          const result = await routeInboundEmail({
            to,
            from,
            text: mail.text || '',
            messageId: mail.messageId || null,
          });

          if (result.ok) {
            summary.routed++;
            if (!result.duplicate) {
              logger.info('Inbound reply threaded from mailbox', { relationId: result.relationId, from });
            }
          } else {
            // A permanent rejection (no token, unknown thread, stranger) will
            // never succeed on a retry — flag it read and move on rather than
            // re-reading it forever. Left in the mailbox for a human to see.
            summary.skipped++;
            logger.warning('Inbound mail not routed', { reason: result.reason, from });
          }
          handled = true;
        } catch (e) {
          // Transient (network, DB) — leave it unseen so the next tick retries.
          summary.failed++;
          logger.error('Inbound mail processing failed', { uid, error: String(e) });
        }
        if (handled) {
          // A failure to flag must not abort the rest of the batch. The reply is
          // already stored, and the next tick re-reads this mail and no-ops on
          // the Message-ID guard rather than duplicating it.
          try {
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          } catch (e) {
            logger.error('Could not flag inbound mail as seen', { uid, error: String(e) });
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  return summary;
}

// The tick itself lives in `src/instrumentation.ts`, which calls
// `POST /api/inbound-email/poll` on a timer. It cannot import this module
// directly: with `src/middleware.ts` present, Next also compiles instrumentation
// for the edge runtime, where imapflow's socket imports fail the build.
