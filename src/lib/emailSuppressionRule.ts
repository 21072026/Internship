// The bounce/complaint suppression rules (#1692) — pure, dependency-free and
// unit-tested (scripts/test/email-suppression.test.mjs). The database half is
// src/lib/emailSuppression.ts; the enforcement is in sendEmail()
// (src/services/emailService.ts § prepareEmail) and the queue's drain
// (src/lib/mailOutbox.ts). The loop as a whole: docs/EMAIL_DELIVERABILITY.md
// § Bounces and complaints.
//
// WHY A SUPPRESSION SILENCES ESSENTIAL MAIL TOO. Every other "do not mail this
// person" rule in this codebase stops at the essential groups (account
// security, the DOI consent mail): no preference, quiet hour or unsubscribe can
// silence a password reset. A suppression is different in kind, not in degree.
// It is not a choice the person made about which mail they want; it is the
// mailbox itself saying "this address does not exist" (a hard bounce) or the
// person telling their provider "this sender is spam" (a complaint). Mailing a
// dead address again cannot reach anybody — it only adds a bounce to the
// shared sending domain's record — and mailing a complainant again is exactly
// what drives the complaint rate that gets the one domain every tenant shares
// blocked. So suppression applies to every group, and the caller learns it
// through `SKIPPED` (#1431's honest answer), never a pretend `SENT`.

import { createHash } from 'node:crypto';

export type SuppressionReasonKey = 'HARD_BOUNCE' | 'SOFT_BOUNCE_REPEATED' | 'COMPLAINT' | 'MANUAL' | 'UNSUBSCRIBE_ALL';

/** A full mailbox is temporary: one soft bounce never suppresses, this many inside the window do. */
export const SOFT_BOUNCE_THRESHOLD = 3;
export const SOFT_BOUNCE_WINDOW_DAYS = 7;
/** Delivery events are needed for idempotency (a provider retries for hours) and the soft window. */
export const DELIVERY_EVENT_RETENTION_DAYS = 30;
/** One webhook request carries at most this many events (a batching provider). */
export const MAX_EVENTS_PER_REQUEST = 100;
export const RELEASE_REASON_MIN = 3;
export const RELEASE_REASON_MAX = 500;

const MAX_ADDRESS = 320;
const MAX_DETAIL = 1000;

/**
 * The one spelling an address is stored AND matched in: trimmed, lower-cased.
 * A suppression that misses on case is not a suppression. Null for anything
 * that is not plausibly a mailbox (no `@`, whitespace inside, over 320 chars).
 */
export function normalizeSuppressedAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > MAX_ADDRESS || /\s/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  return s;
}

/** What every provider's payload is normalised to before any rule looks at it. */
export interface DeliveryEvent {
  provider: string;
  eventId: string;
  email: string;
  type: 'bounce' | 'complaint';
  hard: boolean;
  detail: string | null;
}

export type NormaliseResult = { ok: true; events: DeliveryEvent[]; ignored: number } | { ok: false; error: string };

/** The providers the webhook accepts, by their path segment. */
export const EMAIL_WEBHOOK_PROVIDERS = ['brevo', 'generic'] as const;
export type EmailWebhookProvider = (typeof EMAIL_WEBHOOK_PROVIDERS)[number];

export function isEmailWebhookProvider(p: string): p is EmailWebhookProvider {
  return (EMAIL_WEBHOOK_PROVIDERS as readonly string[]).includes(p);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}

function cap(s: string | null, n: number): string | null {
  return s ? s.slice(0, n) : null;
}

/** A provider that sends no event id: the event is identified by what it says happened, to whom, when. */
export function derivedEventId(parts: (string | null)[]): string {
  return 'sha256:' + createHash('sha256').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex');
}

function asList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const events = (body as { events?: unknown }).events;
    return Array.isArray(events) ? events : [body];
  }
  return null;
}

// Brevo transactional webhook (event names as Brevo documents them). Only the
// four that say something about the address are consumed; delivered, opened,
// clicked, deferred, … are acknowledged and ignored. `blocked` is Brevo's own
// block list (it would not even try) — not evidence about the mailbox, so it is
// ignored rather than turned into a suppression of ours.
const BREVO_MAP: Record<string, { type: 'bounce' | 'complaint'; hard: boolean }> = {
  hard_bounce: { type: 'bounce', hard: true },
  invalid_email: { type: 'bounce', hard: true },
  soft_bounce: { type: 'bounce', hard: false },
  spam: { type: 'complaint', hard: true },
  complaint: { type: 'complaint', hard: true },
};

function normaliseBrevo(item: Record<string, unknown>): DeliveryEvent | 'ignored' | 'invalid' {
  const kind = str(item.event)?.toLowerCase();
  if (!kind) return 'invalid';
  const mapped = BREVO_MAP[kind];
  if (!mapped) return 'ignored';
  const email = normalizeSuppressedAddress(item.email);
  if (!email) return 'invalid';
  const messageId = str(item['message-id']) ?? str(item.messageId);
  const at = str(item.ts_event) ?? str(item.ts_epoch) ?? str(item.date) ?? str(item.ts);
  return {
    provider: 'brevo',
    eventId: derivedEventId(['brevo', kind, email, messageId, at]),
    email,
    type: mapped.type,
    hard: mapped.hard,
    detail: cap(str(item.reason) ?? kind, MAX_DETAIL),
  };
}

// The provider-neutral shape, for any relay whose webhook can be templated (and
// for the e2e spec): { id, email, type: 'bounce' | 'complaint', hard?, detail? }.
function normaliseGeneric(item: Record<string, unknown>): DeliveryEvent | 'ignored' | 'invalid' {
  const type = str(item.type)?.toLowerCase();
  if (type !== 'bounce' && type !== 'complaint') return type ? 'ignored' : 'invalid';
  const email = normalizeSuppressedAddress(item.email);
  const id = str(item.id);
  if (!email || !id) return 'invalid';
  return {
    provider: 'generic',
    eventId: id.slice(0, 191),
    email,
    type,
    // A complaint is always "hard": it suppresses on the first one.
    hard: type === 'complaint' ? true : item.hard === true,
    detail: cap(str(item.detail), MAX_DETAIL),
  };
}

/**
 * A webhook body → the events it carries. A body that is not an object or a
 * list, a list over the cap, or an item the provider's own shape does not
 * describe is refused as a whole (400, the provider retries a fixed payload
 * never): a half-read batch would leave nobody knowing which half counted.
 */
export function normaliseWebhookBody(provider: EmailWebhookProvider, body: unknown): NormaliseResult {
  const list = asList(body);
  if (!list || list.length === 0) return { ok: false, error: 'invalid_payload' };
  if (list.length > MAX_EVENTS_PER_REQUEST) return { ok: false, error: 'too_many_events' };
  const one = provider === 'brevo' ? normaliseBrevo : normaliseGeneric;
  const events: DeliveryEvent[] = [];
  let ignored = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid_payload' };
    const ev = one(raw as Record<string, unknown>);
    if (ev === 'invalid') return { ok: false, error: 'invalid_payload' };
    if (ev === 'ignored') ignored++;
    else events.push(ev);
  }
  return { ok: true, events, ignored };
}

/**
 * Does this event suppress the address, and as what? `softInWindow` is the
 * number of soft bounces for the address inside the window, THIS one included.
 * A hard bounce and a complaint suppress immediately; a soft bounce only at
 * the threshold.
 */
export function suppressionFor(ev: Pick<DeliveryEvent, 'type' | 'hard'>, softInWindow: number): SuppressionReasonKey | null {
  if (ev.type === 'complaint') return 'COMPLAINT';
  if (ev.hard) return 'HARD_BOUNCE';
  return softInWindow >= SOFT_BOUNCE_THRESHOLD ? 'SOFT_BOUNCE_REPEATED' : null;
}

/**
 * When an address is already suppressed, does a new event replace the stored
 * reason? Only upward: a complaint outranks a bounce (it also turned the
 * person's preferences off, and delisting it warns), a hard bounce outranks a
 * repeated soft one. A delisted row is re-suppressed with whatever the new
 * event says.
 */
const RANK: Record<SuppressionReasonKey, number> = {
  SOFT_BOUNCE_REPEATED: 1,
  UNSUBSCRIBE_ALL: 1,
  MANUAL: 2,
  HARD_BOUNCE: 3,
  COMPLAINT: 4,
};
export function reasonAfter(current: SuppressionReasonKey | null, next: SuppressionReasonKey): SuppressionReasonKey {
  if (!current) return next;
  return RANK[next] > RANK[current] ? next : current;
}

/** The EmailLog `error` text of a suppressed send — one spelling, so Admin → Email can filter on it. */
export function suppressedLogReason(reason: SuppressionReasonKey): string {
  return `Suppressed: ${reason}`;
}

/** A delist of a complaint must be confirmed: the person told their provider we are spam. */
export function delistNeedsConfirmation(reason: SuppressionReasonKey): boolean {
  return reason === 'COMPLAINT';
}

/** A delist reason: trimmed, 3–500 characters; null when it is not one. */
export function cleanReleaseReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length >= RELEASE_REASON_MIN && s.length <= RELEASE_REASON_MAX ? s : null;
}

/**
 * The webhook's credential check, as a decision on the facts: the configured
 * secret (or none), what the request presented, and whether this is a
 * production build. Unconfigured fails CLOSED in production — the
 * src/app/api/inbound-email/route.ts rule (#870): a provider webhook that
 * accepts anyone lets anyone suppress any address. `equal` is the caller's
 * constant-time comparison.
 */
export function webhookCredentialOk(
  facts: { expected: string | undefined; presented: string[]; production: boolean },
  equal: (a: string, b: string) => boolean,
): boolean {
  if (!facts.expected) return !facts.production;
  return facts.presented.some((p) => p.length > 0 && equal(p, facts.expected!));
}

/**
 * Every place a provider can put the shared secret: our own header, a bearer
 * token (Brevo's "token" authentication), or the password of HTTP Basic auth
 * (Brevo's "basic" authentication, `https://user:secret@host/...`).
 */
export function presentedSecrets(headers: { get(name: string): string | null }): string[] {
  const out: string[] = [];
  const own = headers.get('x-webhook-secret');
  if (own) out.push(own);
  const auth = headers.get('authorization');
  if (auth) {
    const [scheme, ...rest] = auth.trim().split(/\s+/);
    const value = rest.join(' ');
    if (/^bearer$/i.test(scheme) && value) out.push(value);
    if (/^basic$/i.test(scheme) && value) {
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        const i = decoded.indexOf(':');
        if (i >= 0) out.push(decoded.slice(i + 1));
      } catch {
        // not base64 — nothing presented
      }
    }
  }
  return out;
}
