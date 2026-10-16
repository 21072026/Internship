// The mail sink (#2953): where a mail goes when the environment has one.
//
// A per-PR topic environment is a copy of the product a reviewer clicks
// through — and every click that would mail somebody used to spend the shared
// relay's budget (and, with a seeded demo address that happens to exist, reach
// a real inbox). With `MAIL_SINK_HOST` set, the environment sends every mail to
// that SMTP server instead (a Mailpit container on the box: it accepts
// anything, keeps the last messages for a look in its web UI, and relays
// nothing) — except mail whose recipients are ALL on `MAIL_RECIPIENT_ALLOWLIST`,
// which still goes through the real relay, so the owner can receive a real mail
// from a PR environment on purpose.
//
// THE SAFE DIRECTION. The choice is made per mail from its recipients alone,
// never from whether the sink is up: a mail for the sink that the sink cannot
// take fails like any relay failure — it is queued and retried against the sink
// — and is never "fallen back" to the real relay. Unset `MAIL_SINK_HOST` (every
// environment but a topic one), and nothing here changes anything.
//
// Pure: no nodemailer, no env reads of its own. `emailService.ts` builds the
// sink transport and asks `mailRouteFor()` which one a mail takes; the unit
// test (`scripts/test/mail-ops.test.mjs`) pins the matching.

export type MailRoute = 'relay' | 'sink';

export interface RecipientAllowlist {
  /** Exact addresses, lowercased. */
  addresses: Set<string>;
  /** Exact domains, lowercased (`example.com` matches `a@example.com`, not
   *  `a@sub.example.com`: a subdomain is a different mail system). */
  domains: Set<string>;
}

/**
 * `MAIL_RECIPIENT_ALLOWLIST`: a comma (or whitespace) separated list of
 * addresses (`owner@example.com`) and domains (`example.com` or `@example.com`).
 * Anything that is neither is ignored — a typo narrows the list, it never
 * widens it.
 */
export function parseRecipientAllowlist(raw: string | null | undefined): RecipientAllowlist {
  const out: RecipientAllowlist = { addresses: new Set(), domains: new Set() };
  for (const part of (raw ?? '').split(/[\s,;]+/)) {
    const v = part.trim().toLowerCase();
    if (!v) continue;
    const at = v.indexOf('@');
    if (at === 0) {
      const domain = v.slice(1);
      if (DOMAIN.test(domain)) out.domains.add(domain);
    } else if (at > 0) {
      if (ADDRESS.test(v)) out.addresses.add(v);
    } else if (DOMAIN.test(v)) {
      out.domains.add(v);
    }
  }
  return out;
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ADDRESS = /^[^\s@<>(),;:"]+@[a-z0-9.-]+\.[a-z0-9-]+$/;

/**
 * The bare addresses a `to` names: `a@b.c`, `Name <a@b.c>`, or a comma or
 * semicolon list of either. Lowercased. A part with no address in it yields
 * nothing.
 *
 * This is the conservative reading for a raw string; `emailService.ts` hands
 * `mailRouteFor()` the addresses nodemailer's own parser extracts instead, so
 * the route is judged on exactly the addresses the mail is sent to. Either way
 * a part that is not ONE clean address (`a@x.test b@y.test`, which nodemailer
 * sends to `a@x.test`) is returned whole and fails `addressAllowed()`'s shape
 * check — an ambiguous recipient goes to the sink, never to the relay.
 */
export function recipientsOf(to: string | null | undefined): string[] {
  if (!to) return [];
  const out: string[] = [];
  for (const raw of to.split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const angled = part.match(/<([^>]+)>/);
    const addr = (angled ? angled[1] : part).trim().toLowerCase();
    if (addr.includes('@')) out.push(addr);
  }
  return out;
}

/** Only a value that is exactly one address (one `@`, no whitespace, no list
 *  or angle punctuation) can be allowlisted; anything else is not. */
export function addressAllowed(address: string, list: RecipientAllowlist): boolean {
  const a = address.trim().toLowerCase();
  if (!ADDRESS.test(a)) return false;
  if (list.addresses.has(a)) return true;
  const at = a.lastIndexOf('@');
  return at > 0 && list.domains.has(a.slice(at + 1));
}

/**
 * Which way one mail goes. No sink configured → the relay, always. With a sink:
 * the relay only when there is at least one recipient and EVERY recipient is
 * allowlisted (`to` is a raw header value, or the parsed address list) — one address off the list sends the whole mail to the sink,
 * because a mail cannot be split between two servers here and the sink is the
 * side that cannot reach a stranger.
 */
export function mailRouteFor(
  to: string | readonly string[] | null | undefined,
  sinkHost: string | null | undefined,
  list: RecipientAllowlist,
): MailRoute {
  if (!sinkHost || !sinkHost.trim()) return 'relay';
  const rcpts = Array.isArray(to) ? to.map((r) => String(r ?? '').trim().toLowerCase()) : recipientsOf(to as string | null | undefined);
  if (rcpts.length === 0) return 'sink';
  return rcpts.every((r) => addressAllowed(r, list)) ? 'relay' : 'sink';
}
