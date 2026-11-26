// The org admin's mail log (#3955) — the rules, dependency-free so a plain
// `node --experimental-strip-types` unit test can import them.
//
// What an admin may filter by, read from the query string and never trusted:
// a known status, a category of the shape senders use, an exact recipient
// address, a window of 7 or 30 days. And the one line a stored error becomes:
// short, with any address in it removed (an SMTP reply can quote one).

export const ORG_MAIL_LOG_STATUSES = ['SENT', 'FAILED', 'SKIPPED', 'DEFERRED', 'HELD'] as const;
export type OrgMailLogStatus = (typeof ORG_MAIL_LOG_STATUSES)[number];
export const ORG_MAIL_LOG_DAYS = [7, 30] as const;
export const ORG_MAIL_LOG_LIMIT = 200;

export interface OrgMailLogQuery {
  status: OrgMailLogStatus | null;
  category: string | null;
  to: string | null;
  days: (typeof ORG_MAIL_LOG_DAYS)[number];
}

export function parseOrgMailLogQuery(params: URLSearchParams): OrgMailLogQuery {
  const status = params.get('status');
  const category = (params.get('category') ?? '').trim();
  const to = (params.get('to') ?? '').trim().toLowerCase();
  const days = Number(params.get('days'));
  return {
    status: (ORG_MAIL_LOG_STATUSES as readonly string[]).includes(status ?? '') ? (status as OrgMailLogStatus) : null,
    category: /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(category) ? category : null,
    to: to && to.length <= 320 && to.includes('@') ? to : null,
    days: days === 30 ? 30 : 7,
  };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A stored error as the one short reason the log shows; any address in it removed. */
export function mailLogReason(error: string | null | undefined): string | null {
  if (!error) return null;
  const head = error.replace(EMAIL, '[email]').split('\n')[0].trim();
  return head.length > 120 ? `${head.slice(0, 119)}…` : head || null;
}
