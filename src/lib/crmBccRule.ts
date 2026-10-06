// BCC-to-CRM (#2809) — the rule, dependency-free and unit-tested
// (scripts/test/crm-bcc.test.mjs). The decision and its limits are
// docs/marketing-vertical/sales-email-capture.md; read it before widening this.
//
// A staff member writes to a customer from their own mailbox and puts the org's
// address `crm+<orgId>~<version>.<sig>@<INBOUND_EMAIL_DOMAIN>` in BCC. The mail
// lands in the same IMAP box as reply-by-email; `routeCrmBcc`
// (src/lib/crmBcc.ts) logs it as an `InteractionLog` on the matching account.
//
// What this file decides:
//   * how the token is found in the recipient headers and split into its parts
//     (the HMAC itself is src/lib/crmBccTokens.ts — crypto stays out of here);
//   * which addresses on the mail are the customer's (To + Cc, minus our own
//     mailbox addresses and the sender);
//   * which funnel record of an account the log goes to;
//   * what a log row holds: the date, the subject clipped to 200 characters and
//     the recipient addresses. NEVER the body or an attachment — that is the
//     decision, not an omission;
//   * whether an org has the feature on at all.

/** The local part that marks a BCC-to-CRM address (`reply+` is the thread one). */
export const CRM_BCC_LOCAL = 'crm';

/** Subject is kept so a human can recognise the entry; it is clipped. */
export const CRM_BCC_SUBJECT_MAX = 200;

/** Never accept a mail's own Date header further than this into the future. */
export const CRM_BCC_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

const SEP = '~';

// `crm+…@` anywhere in the recipient headers, but not as the tail of a longer
// local part (`xcrm+…` is somebody else's address).
const TOKEN_RE = /(?<![A-Za-z0-9._%+-])crm\+([^@<>\s,;"']+)@/i;

export function extractCrmBccToken(recipients: string): string | null {
  const m = recipients.match(TOKEN_RE);
  return m ? m[1] : null;
}

/** Does this recipient header set carry a reply-by-email (`reply+`) address? */
export function hasReplyToken(recipients: string): boolean {
  return /(?<![A-Za-z0-9._%+-])reply\+[^@<>\s]+@/i.test(recipients);
}

export type CrmBccPayload = { orgId: string; version: string };

/** `<orgId>~<version>` → its parts, or null when either half is missing. */
export function parseCrmBccPayload(payload: string): CrmBccPayload | null {
  const sep = payload.indexOf(SEP);
  if (sep <= 0) return null;
  const orgId = payload.slice(0, sep);
  const version = payload.slice(sep + 1);
  if (!orgId || !/^[1-9][0-9]{0,8}$/.test(version)) return null;
  return { orgId, version };
}

export function crmBccPayload(orgId: string, version: string): string {
  return `${orgId}${SEP}${version}`;
}

/** The next version after a rotation; a broken stored value restarts at 2. */
export function nextCrmBccVersion(current: string): string {
  const n = Number(current);
  return String(Number.isInteger(n) && n >= 1 ? n + 1 : 2);
}

const ADDRESS_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Every address in a header value, lower-cased and de-duplicated, in order. */
export function addressesIn(header: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (header ?? '').matchAll(ADDRESS_RE)) {
    const a = m[0].toLowerCase();
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * The customer side of the mail: To + Cc addresses that are neither one of our
 * own mailbox addresses (`crm+…`, `reply+…`, anything at the inbound domain)
 * nor the sender.
 */
export function customerAddresses(input: {
  to: string;
  cc?: string | null;
  from: string;
  inboundDomain?: string | null;
}): string[] {
  const from = addressesIn(input.from)[0] ?? '';
  const domain = input.inboundDomain?.trim().toLowerCase() || null;
  return addressesIn(`${input.to} ${input.cc ?? ''}`).filter((a) => {
    if (a === from) return false;
    const [local, host] = a.split('@');
    if (domain && host === domain) return false;
    return !/^(crm|reply)\+/.test(local);
  });
}

/** Whitespace collapsed, clipped to CRM_BCC_SUBJECT_MAX; null when empty. */
export function clipSubject(subject: string | null | undefined): string | null {
  const s = (subject ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > CRM_BCC_SUBJECT_MAX ? `${s.slice(0, CRM_BCC_SUBJECT_MAX - 1)}…` : s;
}

/**
 * When the mail was written: its Date header, unless that is missing,
 * unparseable or more than a day ahead of us (a skewed client clock must not
 * make a contact look like it happens tomorrow) — then the moment it arrived.
 */
export function mailDate(header: string | Date | null | undefined, now: Date): Date {
  if (!header) return now;
  const d = header instanceof Date ? header : new Date(header);
  if (Number.isNaN(d.getTime())) return now;
  if (d.getTime() - now.getTime() > CRM_BCC_FUTURE_SKEW_MS) return now;
  return d;
}

/** The log's `notes`: a fixed marker plus the matched recipient addresses. */
export function crmBccNotes(recipients: readonly string[]): string {
  return `BCC → ${recipients.join(', ')}`;
}

export type RelationCandidate = { id: string; mentorId: string; createdAt: Date };

/**
 * Which ACTIVE funnel record of one account gets the log: the sender's own
 * (newest first), otherwise the account's newest. Null when it has none.
 */
export function pickRelation(relations: readonly RelationCandidate[], senderId: string): string | null {
  if (relations.length === 0) return null;
  const newestFirst = [...relations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return (newestFirst.find((r) => r.mentorId === senderId) ?? newestFirst[0]).id;
}

/** Staff who may log by BCC: the org's active admins and reps/mentors. */
export function isCrmBccSender(user: { role: string; isActive: boolean } | null | undefined): boolean {
  return !!user && user.isActive && (user.role === 'ADMIN' || user.role === 'MENTOR');
}

/** '' = the vertical's default (MARKETING on, everything else off); else the org's choice. */
export function crmBccEnabledFor(stored: string | null | undefined, vertical: string): boolean {
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return vertical === 'MARKETING';
}
