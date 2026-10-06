import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';
import { inboundEmailDomain } from '@/lib/inboundDomain';
import { CRM_BCC_LOCAL, crmBccPayload, parseCrmBccPayload, type CrmBccPayload } from '@/lib/crmBccRule';

// The signed half of a BCC-to-CRM address (#2809): `<orgId>~<version>.<sig>`,
// same shape as the reply token (src/lib/replyToken.ts) but with its own
// purpose prefix in the HMAC, so a reply token can never verify as a CRM
// address or the other way round. The version is the org's `crmBccVersion`
// setting — rotating bumps it and every older address stops verifying.

const PURPOSE = 'crm-bcc:';

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret()).update(PURPOSE + payload).digest('hex').slice(0, 32);
}

export function makeCrmBccToken(orgId: string, version: string): string {
  const payload = crmBccPayload(orgId, version);
  return `${payload}.${sign(payload)}`;
}

/** The org + version a token names, or null when it does not verify. */
export function verifyCrmBccToken(token: string): CrmBccPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return parseCrmBccPayload(payload);
}

/** The org's BCC address, or null when no inbound mail domain is configured. */
export function crmBccAddress(orgId: string, version: string): string | null {
  const domain = inboundEmailDomain();
  if (!domain) return null;
  return `${CRM_BCC_LOCAL}+${makeCrmBccToken(orgId, version)}@${domain}`;
}

/**
 * The log's idempotency key: a hash of the RFC Message-ID, or — for a mail
 * without one — of what identifies it (sender, date, subject, recipients), so a
 * replayed delivery still lands on the same key.
 */
export function crmBccSourceRef(parts: { messageId?: string | null; from: string; date: string; subject: string; recipients: readonly string[] }): string {
  const basis = parts.messageId?.trim()
    ? `mid:${parts.messageId.trim()}`
    : `alt:${parts.from}|${parts.date}|${parts.subject}|${parts.recipients.join(',')}`;
  return `bcc:${createHash('sha256').update(basis).digest('hex').slice(0, 40)}`;
}
