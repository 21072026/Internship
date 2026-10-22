// The Klaviyo pull connector's rules (docs/integrations/klaviyo.md).
//
// ZERO imports, so every rule here — the wire format we send, the mapping of a
// profile onto a lead, the cursor and the backoff — is unit-tested without a
// database, a network or Next (scripts/test/klaviyo-rule.test.mjs). The HTTP
// half is src/lib/klaviyoClient.ts; the Prisma half, and the only writer, is
// src/lib/klaviyoSync.ts.
//
// ── WHAT WAS VERIFIED AGAINST THE PROVIDER'S REFERENCE (2026-10-20; revision
//    moved to 2026-10-15 and re-checked 2026-10-22 — no profiles/lists change) ──
//   • base URL https://a.klaviyo.com, server-side endpoints under /api;
//   • auth header `Authorization: Klaviyo-API-Key <private key>`;
//   • a `revision` header on every request (date-named API versions);
//   • JSON:API: `data[]`, `links.next` carrying `page[cursor]`;
//   • GET /api/profiles: scope profiles:read, `page[size]` 1..100,
//     `filter=greater-than(updated,<ISO>)` (updated supports only
//     greater-than / less-than), `sort=updated`, and
//     `additional-fields[profile]=subscriptions` for consent + method;
//     `lists` is NOT an `include` of that endpoint (a profile's lists are one
//     call per profile — deliberately not made, see listNames below);
//   • GET /api/lists: scope lists:read, at most 10 per page;
//   • rate limits per account, fixed windows (burst 1 s, steady 1 min); the
//     profiles and lists endpoints are 75/s burst, 750/min steady; a 429
//     carries `Retry-After` in whole seconds.
//
// ── ONE-WAY ──────────────────────────────────────────────────────────────────
//   Every request this connector can build is a GET, except the reporting
//   API's read-only query (klaviyoQuery, KLAVIYO_QUERY_POST_PATHS). There is no
//   function in this file or the client that produces a write to the provider.

export const KLAVIYO_PROVIDER = 'klaviyo';
export const EXTERNAL_PROVIDERS = [KLAVIYO_PROVIDER] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export const KLAVIYO_API_BASE = 'https://a.klaviyo.com';
/**
 * The default API revision. Klaviyo versions its API by date and answers every
 * request in the revision it names; pinning one means a field we read cannot
 * change shape under us. Moving it is a reviewed change — re-read the
 * references of every endpoint in docs/integrations/klaviyo.md § Version for
 * the new date first. A deployment may pin another GA date with
 * `KLAVIYO_REVISION` (resolveKlaviyoRevision); a `.pre` (beta) one is refused.
 * Each revision is supported for two years after its release.
 */
export const KLAVIYO_REVISION = '2026-10-15';

/**
 * The revision a request names: a GA date (`YYYY-MM-DD`) from the environment,
 * else the default. A beta revision (`2026-10-15.pre`), junk, or a date before
 * the oldest revision this code was checked against falls back to the default
 * — `ok: false` tells the caller to log that once.
 */
export const KLAVIYO_OLDEST_REVISION = '2025-01-15';
export function resolveKlaviyoRevision(raw: string | null | undefined): { revision: string; ok: boolean } {
  const v = (raw ?? '').trim();
  if (!v) return { revision: KLAVIYO_REVISION, ok: true };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || v < KLAVIYO_OLDEST_REVISION) {
    return { revision: KLAVIYO_REVISION, ok: false };
  }
  return { revision: v, ok: true };
}

/**
 * The scopes a read-only private key needs for this connector — nothing else.
 * Only `profiles:read` is required for the leads; without one of the others,
 * that resource alone records `forbidden` and the rest keep syncing.
 */
export const KLAVIYO_REQUIRED_SCOPES = [
  'profiles:read',
  'lists:read',
  'segments:read',
  'metrics:read',
  'events:read',
  'campaigns:read',
  'flows:read',
] as const;
/** The provider's maximum for GET /api/profiles. */
export const KLAVIYO_PROFILE_PAGE_SIZE = 100;
/** GET /api/lists answers at most 10 per page. */
export const KLAVIYO_LIST_PAGE_SIZE = 10;
/** Lists are read once per run, at most this many pages (100 lists). */
export const KLAVIYO_LIST_MAX_PAGES = 10;
/** secretBox purpose of the sealed key — never shared with another secret. */
export const KLAVIYO_SECRET_PURPOSE = 'external-connection:klaviyo';
/** How often the scheduled sync runs. */
export const KLAVIYO_SYNC_CRON = '*/15 * * * *';
/**
 * The overlap a query re-reads: the next query starts this long before the
 * previous one began, so a profile saved during a long query (or under a clock
 * skew between us and the provider) is read again rather than missed. A
 * re-read profile that did not change comes back UNCHANGED and writes nothing.
 */
export const KLAVIYO_SINCE_OVERLAP_MS = 5 * 60 * 1000;
/** The provider-owned JSON text kept per profile, at most this many characters. */
export const KLAVIYO_ATTRIBUTES_MAX = 8000;
/** At most this many custom properties are kept, each value at most PROPERTY_VALUE_MAX. */
export const KLAVIYO_PROPERTY_LIMIT = 50;
const PROPERTY_KEY_MAX = 64;
const PROPERTY_VALUE_MAX = 500;
/** Page budget of one scheduled run per connection (2 000 profiles). */
export const KLAVIYO_PAGES_PER_RUN = 20;
/** Page budget of one "Sync now" press — the request waits for it. */
export const KLAVIYO_PAGES_PER_MANUAL_RUN = 5;
/** The dry-run preview maps at most this many profiles (one page). */
export const KLAVIYO_PREVIEW_MAX = 25;

export const KLAVIYO_SYNC_STATUSES = ['ok', 'partial', 'error'] as const;
export type KlaviyoSyncStatus = (typeof KLAVIYO_SYNC_STATUSES)[number];

/**
 * What a failed run records on the connection. CODES ONLY: never a response
 * body (it can echo a profile) and never an address.
 */
export const KLAVIYO_ERROR_CODES = [
  'unauthorized', // 401: the key is wrong or was revoked
  'forbidden', // 403: the key lacks a scope (profiles:read / lists:read)
  'rate_limited', // 429 that did not clear within the request's own wait
  'upstream_error', // 5xx after one retry, or an unexpected status
  'bad_request', // 400: e.g. a stale page cursor (the run restarts its query)
  'network', // timeout, DNS, TLS, refused
  'bad_response', // not the JSON:API shape we read
  'key_unreadable', // the sealed key no longer opens (server secret rotated)
  'no_owner', // neither a default lead owner nor the connecting admin can own leads
  'internal', // our side threw
] as const;
export type KlaviyoErrorCode = (typeof KLAVIYO_ERROR_CODES)[number];

// ── The key ──────────────────────────────────────────────────────────────────

export type KeyCheck = { ok: true; key: string } | { ok: false; code: 'empty' | 'public_key' | 'malformed' };

/**
 * A private API key as pasted. Klaviyo's private keys start with `pk_`; the
 * six-character public key (the "site id") is what people paste by mistake,
 * and it can read nothing — it is refused before any request is made.
 */
export function checkKlaviyoKey(raw: unknown): KeyCheck {
  if (typeof raw !== 'string') return { ok: false, code: 'empty' };
  const key = raw.trim();
  if (!key) return { ok: false, code: 'empty' };
  if (/^[A-Za-z0-9]{6}$/.test(key)) return { ok: false, code: 'public_key' };
  if (!/^pk_[A-Za-z0-9_-]{8,200}$/.test(key)) return { ok: false, code: 'malformed' };
  return { ok: true, key };
}

/** What the admin screen may show of a saved key. */
export function keyLast4(key: string): string {
  return key.slice(-4);
}

export function klaviyoHeaders(key: string, revision: string = KLAVIYO_REVISION): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${key}`,
    revision,
    Accept: 'application/vnd.api+json',
  };
}

/**
 * The key a server-side environment supplies (`KLAVIYO_PRIVATE_API_KEY`) is
 * never stored: its connection row carries this prefix plus a sha256 of the
 * key instead of a sealed copy, so a rotated environment key is noticed (the
 * fingerprint changes) without the key ever reaching the database.
 */
export const KLAVIYO_ENV_KEY_PREFIX = 'env:';
export function isEnvKeyRef(sealedKey: string | null | undefined): boolean {
  return typeof sealedKey === 'string' && sealedKey.startsWith(KLAVIYO_ENV_KEY_PREFIX);
}

// ── Requests ─────────────────────────────────────────────────────────────────

/** The provider's date-time, without milliseconds (`2026-10-01T10:00:00Z`). */
export function klaviyoInstant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Path + query of one profiles page. `since` null = the first, full import.
 * Sorted by `updated` ascending, so a query's pages walk forward in time.
 */
export function profilesPath(opts: { since: Date | null; cursor?: string | null; pageSize?: number }): string {
  const params = new URLSearchParams();
  params.set('page[size]', String(Math.min(KLAVIYO_PROFILE_PAGE_SIZE, Math.max(1, opts.pageSize ?? KLAVIYO_PROFILE_PAGE_SIZE))));
  params.set('sort', 'updated');
  params.set('additional-fields[profile]', 'subscriptions');
  if (opts.since) params.set('filter', `greater-than(updated,${klaviyoInstant(opts.since)})`);
  if (opts.cursor) params.set('page[cursor]', opts.cursor);
  return `/api/profiles?${params.toString()}`;
}

export function listsPath(cursor?: string | null): string {
  const params = new URLSearchParams();
  params.set('fields[list]', 'name');
  if (cursor) params.set('page[cursor]', cursor);
  return `/api/lists?${params.toString()}`;
}

/**
 * The opaque `page[cursor]` of `links.next`, or null at the end of a query.
 * Only the cursor is kept — never the URL itself, which the sync rebuilds from
 * its own base: a `next` link pointing at another host is never followed.
 */
export function nextPageCursor(body: unknown): string | null {
  const next = (body as { links?: { next?: unknown } } | null)?.links?.next;
  if (typeof next !== 'string' || !next) return null;
  try {
    const cursor = new URL(next, KLAVIYO_API_BASE).searchParams.get('page[cursor]');
    return cursor && cursor.length <= 2000 ? cursor : null;
  } catch {
    return null;
  }
}

// ── Responses, errors, backoff ───────────────────────────────────────────────

/** What a non-2xx status means for this run. */
export function errorCodeForStatus(status: number): KlaviyoErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'bad_request';
  return 'upstream_error';
}

/** A status worth a retry inside the same request. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** One request is tried at most this many times (the first try + 3 retries). */
export const KLAVIYO_MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;

/**
 * How long to wait before retry number `attempt` (1-based), or null when the
 * request should give up and leave it to the run's backoff.
 *
 *   • a 429 waits what its `Retry-After` says — when that is at most
 *     KLAVIYO_INLINE_WAIT_MAX_MS; a longer one (or none at all, after the
 *     first retry) is the run's backoff, not this request's;
 *   • a 5xx or a network failure waits 1 s, 2 s, 4 s … with ±25 % jitter, so
 *     several replicas never retry in lock-step.
 *
 * `random` is injected by the unit test.
 */
export function retryDelayMs(
  attempt: number,
  failure: { status?: number; retryAfterMs?: number | null },
  random: () => number = Math.random,
): number | null {
  if (attempt >= KLAVIYO_MAX_ATTEMPTS) return null;
  const { status } = failure;
  if (status !== undefined && !isRetryableStatus(status)) return null;
  if (status === 429) {
    const wait = failure.retryAfterMs;
    if (wait === null || wait === undefined) return attempt === 1 ? RETRY_BASE_MS : null;
    return wait <= KLAVIYO_INLINE_WAIT_MAX_MS ? Math.max(wait, 250) : null;
  }
  const base = RETRY_BASE_MS * 2 ** (attempt - 1);
  return Math.round(base * (0.75 + random() * 0.5));
}

/** `Retry-After` (whole seconds, or an HTTP date) in ms, or null when absent/unreadable. */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  if (!header) return null;
  const v = header.trim();
  if (/^\d{1,6}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** The longest wait one request spends on a 429 before giving the run up. */
export const KLAVIYO_INLINE_WAIT_MAX_MS = 5_000;

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * When a connection is next tried after `failures` consecutive failed runs.
 * One failure waits for the next 15-minute tick; then it doubles (30, 60, 120
 * min …) up to six hours. A `Retry-After` longer than that wins — the provider
 * said when. A failing connection never blocks another tenant's: each has its
 * own `nextAttemptAt`.
 */
export function nextAttemptDelayMs(failures: number, retryAfter: number | null = null): number {
  const n = Math.max(1, Math.floor(failures));
  const backoff = Math.min(BACKOFF_MAX_MS, SYNC_INTERVAL_MS * 2 ** (n - 1));
  return Math.max(backoff, retryAfter ?? 0);
}

/** Whether a connection's backoff has elapsed. */
export function isDue(nextAttemptAt: Date | null, now: Date): boolean {
  return !nextAttemptAt || nextAttemptAt.getTime() <= now.getTime();
}

// ── The cursor ───────────────────────────────────────────────────────────────

export interface ProfilesCursor {
  /** The current query reads profiles updated after this (null = everything). */
  since: Date | null;
  /** When the current query began; null when no query is open. */
  queryStartedAt: Date | null;
  /** Where inside the current query the next page starts. */
  pageCursor: string | null;
  /**
   * The oldest `updated` of a profile that ERRORED in the open query (null =
   * none). When the query closes, the next one starts before it, so the row is
   * read — and retried — again instead of being skipped for good.
   */
  errorFloor?: Date | null;
  /** Consecutive closed queries that were held back for an errored row. */
  errorHolds?: number | null;
}

/**
 * How many consecutive queries are held back for a row that keeps failing.
 * After that the cursor moves on (the failure stays counted on the connection's
 * `lastErrors`): a permanent failure must not pin every later query to one
 * instant and re-read a growing backlog every 15 minutes.
 */
export const KLAVIYO_ERROR_RETRY_QUERIES = 3;

/** The cursor at the start of a run: an open query continues, else a new one begins now. */
export function beginQuery(cursor: ProfilesCursor, now: Date): ProfilesCursor {
  if (cursor.queryStartedAt) return cursor;
  return { ...cursor, queryStartedAt: now, pageCursor: null };
}

/**
 * The cursor after one page was applied. A page with a `next` stays inside the
 * query; the last page closes it, and the next query reads everything updated
 * since this one BEGAN (minus the overlap) — never since the newest `updated`
 * it saw, which would skip a profile saved while the query was being paged.
 *
 * Why not "highest (updated, id) seen": the provider sorts by ONE field, and a
 * bulk list import stamps thousands of profiles with the same second. A
 * high-water mark cannot move past such a second without either skipping
 * rows or re-reading the same page for ever; the provider's own page cursor
 * walks through it exactly once.
 */
export function afterPage(
  cursor: ProfilesCursor,
  nextCursor: string | null,
  pageErrorFloor: Date | null = null,
): { cursor: ProfilesCursor; queryDone: boolean } {
  const floor = earlier(cursor.errorFloor ?? null, pageErrorFloor);
  if (nextCursor) return { cursor: { ...cursor, pageCursor: nextCursor, errorFloor: floor }, queryDone: false };
  const started = cursor.queryStartedAt ?? new Date();
  const since = new Date(started.getTime() - KLAVIYO_SINCE_OVERLAP_MS);
  const holds = cursor.errorHolds ?? 0;
  // A row failed in this query: the next one starts just before it (the filter
  // is strictly greater-than), at most KLAVIYO_ERROR_RETRY_QUERIES times in a row.
  if (floor && holds < KLAVIYO_ERROR_RETRY_QUERIES) {
    const held = new Date(floor.getTime() - 1000);
    return {
      cursor: { since: held < since ? held : since, queryStartedAt: null, pageCursor: null, errorFloor: null, errorHolds: holds + 1 },
      queryDone: true,
    };
  }
  return {
    cursor: { since, queryStartedAt: null, pageCursor: null, errorFloor: null, errorHolds: 0 },
    queryDone: true,
  };
}

function earlier(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/** A stale page cursor (400) restarts the open query from its `since`; nothing is lost. */
export function restartQuery(cursor: ProfilesCursor): ProfilesCursor {
  return { ...cursor, pageCursor: null };
}

// ── The mapping ──────────────────────────────────────────────────────────────

/** One profile as GET /api/profiles returns it (the parts we read). */
export interface KlaviyoProfileResource {
  type?: string;
  id?: string;
  attributes?: Record<string, unknown>;
}

export interface KlaviyoConsentSummary {
  email?: { consent: string | null; method: string | null; methodDetail: string | null; at: string | null; doubleOptin: boolean | null };
  sms?: { consent: string | null; method: string | null; at: string | null };
}

export interface KlaviyoLead {
  profileId: string;
  /** Lower-cased; '' when the profile has none (an SMS-only profile). */
  email: string;
  fullName: string;
  organization: string;
  /** The account name: the organization, else the person, else the address. */
  accountName: string;
  /** True when `accountName` is the organization (a real company name). */
  accountNameIsOrganization: boolean;
  phone: string;
  city: string;
  /** ISO-3166-1 alpha-2 when the profile carries one, else ''. */
  country: string;
  updatedAt: Date | null;
  /** The inputs of leadSourceName() — UTM from the custom properties, the vendor detail. */
  sourceInput: {
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    vendor: { name: string; detail: string | null };
  };
  consent: KlaviyoConsentSummary | null;
  /** Bounded JSON text: title, locale, location, custom properties. */
  attributesText: string;
}

const ACCOUNT_NAME_MAX = 191;
const PERSON_NAME_MAX = 191;
const PHONE_MAX = 40;
const SHORT_MAX = 120;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A provider address as the CRM keys it, or '' when it is not one we may use. */
export function profileEmail(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!v || v.length > 191 || !EMAIL_SHAPE.test(v)) return '';
  // The CRM's own stand-in domains are never a person's address.
  if (v.endsWith('@import.local') || v.endsWith('@erased.local')) return '';
  return v;
}

/** The custom property that carries a UTM parameter, if the account stores one. */
function utmFrom(properties: Record<string, unknown>, part: 'source' | 'medium' | 'campaign'): string | null {
  let first: string | null = null;
  let plain: string | null = null;
  for (const [key, value] of Object.entries(properties)) {
    const norm = key.toLowerCase().replace(/[^a-z]/g, '');
    const v = text(value, SHORT_MAX);
    if (!v) continue;
    if (norm === `initialutm${part}` || norm === `firstutm${part}`) first ??= v;
    else if (norm === `utm${part}`) plain ??= v;
  }
  // The FIRST touch, when the account keeps one apart from the latest.
  return first ?? plain;
}

/** The consent block of `additional-fields[profile]=subscriptions`, reduced to what is shown. */
export function consentSummary(subscriptions: unknown): KlaviyoConsentSummary | null {
  const subs = record(subscriptions);
  const email = record(record(subs.email).marketing);
  const sms = record(record(subs.sms).marketing);
  const out: KlaviyoConsentSummary = {};
  if (Object.keys(email).length) {
    out.email = {
      consent: text(email.consent, 40) || null,
      method: text(email.method, 60) || null,
      methodDetail: text(email.custom_method_detail, SHORT_MAX) || text(email.method_detail, SHORT_MAX) || null,
      at: text(email.consent_timestamp, 40) || null,
      doubleOptin: typeof email.double_optin === 'boolean' ? email.double_optin : null,
    };
  }
  if (Object.keys(sms).length) {
    out.sms = {
      consent: text(sms.consent, 40) || null,
      method: text(sms.method, 60) || null,
      at: text(sms.consent_timestamp, 40) || null,
    };
  }
  return out.email || out.sms ? out : null;
}

/**
 * How the provider says the person arrived: the subscription method, and the
 * list or form it names. `method_detail` is a list id when the person was
 * subscribed through a list — it is shown by the list's NAME when the run read
 * one (`listNames`), else as written.
 */
export function vendorDetail(subscriptions: unknown, listNames: ReadonlyMap<string, string>): string | null {
  const subs = record(subscriptions);
  const email = record(record(subs.email).marketing);
  const sms = record(record(subs.sms).marketing);
  const method = text(email.method, 60) || text(sms.method, 60);
  const rawDetail = text(email.custom_method_detail, SHORT_MAX) || text(email.method_detail, SHORT_MAX) || text(sms.method_detail, SHORT_MAX);
  const detail = rawDetail ? (listNames.get(rawDetail) ?? rawDetail) : '';
  if (!method && !detail) return null;
  return [method.toLowerCase(), detail].filter(Boolean).join('/');
}

/** A custom property value, bounded. Nested values are kept as JSON text. */
function boundedValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.replace(CONTROL, ' ').slice(0, PROPERTY_VALUE_MAX);
  try {
    return JSON.stringify(value).slice(0, PROPERTY_VALUE_MAX);
  } catch {
    return null;
  }
}

/**
 * The provider-owned data kept for the account screen, as JSON text of at most
 * KLAVIYO_ATTRIBUTES_MAX characters. Deliberately NOT kept: the IP address and
 * the coordinates of `location` (the CRM has no use for them), and the
 * predictive analytics (never requested). Properties past the budget are
 * dropped from the end and counted, never silently truncated mid-JSON.
 */
export function boundedAttributes(attributes: Record<string, unknown>): string {
  const location = record(attributes.location);
  const kept: Record<string, unknown> = {};
  const title = text(attributes.title, SHORT_MAX);
  if (title) kept.title = title;
  const locale = text(attributes.locale, 20);
  if (locale) kept.locale = locale;
  const loc: Record<string, string> = {};
  for (const key of ['city', 'region', 'country', 'zip', 'timezone'] as const) {
    const v = text(location[key], SHORT_MAX);
    if (v) loc[key] = v;
  }
  if (Object.keys(loc).length) kept.location = loc;
  const created = text(attributes.created, 40);
  if (created) kept.created = created;

  const properties: Record<string, string | number | boolean> = {};
  let dropped = 0;
  for (const [rawKey, rawValue] of Object.entries(record(attributes.properties))) {
    const key = text(rawKey, PROPERTY_KEY_MAX);
    const value = boundedValue(rawValue);
    if (!key || value === null || value === '') continue;
    if (Object.keys(properties).length >= KLAVIYO_PROPERTY_LIMIT) {
      dropped += 1;
      continue;
    }
    properties[key] = value;
  }
  const keys = Object.keys(properties);
  let out = JSON.stringify({ ...kept, ...(keys.length ? { properties } : {}), ...(dropped ? { droppedProperties: dropped } : {}) });
  while (out.length > KLAVIYO_ATTRIBUTES_MAX && keys.length) {
    delete properties[keys.pop() as string];
    dropped += 1;
    out = JSON.stringify({ ...kept, ...(keys.length ? { properties } : {}), droppedProperties: dropped });
  }
  return out.length > KLAVIYO_ATTRIBUTES_MAX ? JSON.stringify({ droppedProperties: dropped }) : out;
}

export type MappedProfile = { ok: true; lead: KlaviyoLead } | { ok: false; key: string; reason: string };

/** One provider profile → the lead the CRM keeps. Pure; the store decides what to write. */
export function mapProfile(resource: unknown, listNames: ReadonlyMap<string, string> = new Map()): MappedProfile {
  const r = record(resource) as KlaviyoProfileResource;
  const profileId = typeof r.id === 'string' ? r.id.trim() : '';
  if (!profileId || profileId.length > 64) return { ok: false, key: profileId.slice(0, 64) || '?', reason: 'profile without a usable id' };
  if (r.type !== undefined && r.type !== 'profile') return { ok: false, key: profileId, reason: `not a profile (${String(r.type).slice(0, 20)})` };
  const a = record(r.attributes);
  const email = profileEmail(a.email);
  const first = text(a.first_name, PERSON_NAME_MAX);
  const last = text(a.last_name, PERSON_NAME_MAX);
  const fullName = [first, last].filter(Boolean).join(' ').slice(0, PERSON_NAME_MAX).trim();
  const organization = text(a.organization, ACCOUNT_NAME_MAX);
  const phone = text(a.phone_number, PHONE_MAX);
  if (!email && !phone && !fullName && !organization) {
    return { ok: false, key: profileId, reason: 'profile carries no address, phone or name' };
  }
  const location = record(a.location);
  const countryRaw = text(location.country, 60).toUpperCase();
  const updatedRaw = typeof a.updated === 'string' ? Date.parse(a.updated) : NaN;
  const properties = record(a.properties);

  const accountName = (organization || fullName || email || phone || profileId).slice(0, ACCOUNT_NAME_MAX).trim();
  return {
    ok: true,
    lead: {
      profileId,
      email,
      fullName,
      organization,
      accountName,
      accountNameIsOrganization: Boolean(organization),
      phone,
      city: text(location.city, SHORT_MAX),
      country: /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : '',
      updatedAt: Number.isNaN(updatedRaw) ? null : new Date(updatedRaw),
      sourceInput: {
        utmSource: utmFrom(properties, 'source'),
        utmMedium: utmFrom(properties, 'medium'),
        utmCampaign: utmFrom(properties, 'campaign'),
        vendor: { name: KLAVIYO_PROVIDER, detail: vendorDetail(a.subscriptions, listNames) },
      },
      consent: consentSummary(a.subscriptions),
      attributesText: boundedAttributes(a),
    },
  };
}

/**
 * The name a person-only account takes when its plain name already belongs to
 * a DIFFERENT account: two people called "Jane Doe" are two leads, never one.
 */
export function disambiguatedAccountName(lead: Pick<KlaviyoLead, 'accountName' | 'email' | 'profileId'>): string {
  const suffix = lead.email || lead.profileId;
  return `${lead.accountName} (${suffix})`.slice(0, ACCOUNT_NAME_MAX).trim();
}

// ── Reading a stored link back (the account screen) ──────────────────────────

export interface ProfileInfo {
  provider: string;
  source: string | null;
  emailConsent: string | null;
  smsConsent: string | null;
  jobTitle: string | null;
  location: string | null;
  properties: [string, string][];
  updatedAt: Date | null;
}

function parseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return record(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** A stored link as the account screen shows it. Tolerates any stored text. */
export function profileInfo(link: {
  provider: string;
  sourceName: string | null;
  consent: string | null;
  attributes: string | null;
  profileUpdatedAt: Date | null;
}): ProfileInfo {
  const consent = parseJson(link.consent);
  const attrs = parseJson(link.attributes);
  const email = record(consent.email);
  const sms = record(consent.sms);
  const describe = (c: Record<string, unknown>) => {
    const parts = [text(c.consent, 40), text(c.method, 60), text(c.methodDetail, SHORT_MAX)].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  };
  const loc = record(attrs.location);
  const location = ['city', 'region', 'zip', 'country'].map((k) => text(loc[k], SHORT_MAX)).filter(Boolean).join(', ');
  const properties = Object.entries(record(attrs.properties))
    .map(([k, v]) => [text(k, PROPERTY_KEY_MAX), typeof v === 'string' ? v.slice(0, PROPERTY_VALUE_MAX) : String(v)] as [string, string])
    .filter(([k]) => Boolean(k));
  return {
    provider: link.provider,
    source: link.sourceName,
    emailConsent: describe(email),
    smsConsent: describe(sms),
    jobTitle: text(attrs.title, SHORT_MAX) || null,
    location: location || null,
    properties,
    updatedAt: link.profileUpdatedAt,
  };
}
