// The Klaviyo HTTP client: GET only (plus the reporting API's read-only
// queries, klaviyoQuery), one fixed host, bounded in time and size
// (docs/integrations/klaviyo.md). The rules it applies — headers, paths, what a
// status means, how long a 429 is waited out — are the pure ones in
// src/lib/klaviyoRule.ts.
//
// THE HOST IS OURS, NOT THE TENANT'S. A tenant supplies a key, never a URL:
// every request goes to KLAVIYO_API_BASE, through the SSRF guard like every
// other server-side fetch. The e2e suite points the app at a local stand-in that
// speaks the same wire format (e2e/support/klaviyo-mock.mjs) with
// `KLAVIYO_API_BASE_URL`, honoured ONLY together with
// `KLAVIYO_ALLOW_INSECURE_STUB=1`, which also skips the guard for it — a
// test-only pair no deployment sets, logged on first use.
//
// NOTHING FROM A RESPONSE BODY IS EVER LOGGED OR STORED AS AN ERROR: a body can
// echo a profile. A failure is reduced to a code (KLAVIYO_ERROR_CODES).
import { logger } from '@/lib/logger';
import { assertPublicHttpsUrl } from '@/lib/ssrfGuard';
import {
  KLAVIYO_API_BASE,
  KLAVIYO_LIST_MAX_PAGES,
  errorCodeForStatus,
  klaviyoHeaders,
  listsPath,
  nextPageCursor,
  profilesPath,
  resolveKlaviyoRevision,
  retryAfterMs,
  retryDelayMs,
  type KlaviyoErrorCode,
} from '@/lib/klaviyoRule';

const REQUEST_TIMEOUT_MS = 20_000;
/** A profiles page of 100 with subscriptions is well under 1 MB; anything near this is not one. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KlaviyoClientOptions {
  fetchImpl?: FetchLike;
  /** Injected by tests; the real one waits. */
  sleep?: (ms: number) => Promise<void>;
}

export type KlaviyoResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: KlaviyoErrorCode; status?: number; retryAfterMs?: number | null };

let warnedOverride = false;

export function insecureKlaviyoStubAllowed(): boolean {
  return process.env.KLAVIYO_ALLOW_INSECURE_STUB === '1';
}

/** The API origin: the provider's, or the e2e stand-in's when BOTH test switches are set. */
export function klaviyoBaseUrl(): string {
  const override = (process.env.KLAVIYO_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!override || !insecureKlaviyoStubAllowed()) return KLAVIYO_API_BASE;
  if (!warnedOverride) {
    warnedOverride = true;
    logger.warning('Klaviyo connector: KLAVIYO_API_BASE_URL overrides the provider host (test switch)');
  }
  return override;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readBody(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') || '0');
  if (declared > MAX_BODY_BYTES) throw new Error('body too large');
  if (!res.body) return JSON.parse(await res.text());
  // Read in chunks so a body without a Content-Length stops at the cap
  // instead of being buffered whole first.
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('body too large');
    }
    parts.push(value);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

let warnedRevision = false;

/** The revision every request names: `KLAVIYO_REVISION` when it is a GA date, else the default. */
export function klaviyoRevision(): string {
  const r = resolveKlaviyoRevision(process.env.KLAVIYO_REVISION);
  if (!r.ok && !warnedRevision) {
    warnedRevision = true;
    // The value itself is config, not a secret, but it is not echoed either:
    // the default in use is what matters to whoever reads the log.
    logger.warning('Klaviyo connector: KLAVIYO_REVISION is not a supported GA revision; using the default', { revision: r.revision });
  }
  return r.revision;
}

/**
 * The provider's per-endpoint steady limits are far apart (events 3 500/min,
 * flows 60/min, the reporting API 2/min). One process never sends two
 * requests of one family closer than this — the in-run pace, on top of the
 * strictly sequential requests of a run. A 429 is still handled per request.
 */
const lastRequestAt = new Map<string, number>();
async function pace(family: string | undefined, minIntervalMs: number | undefined, sleep: (ms: number) => Promise<void>) {
  if (!family || !minIntervalMs) return;
  const last = lastRequestAt.get(family) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(family, Date.now());
}

/**
 * The only POSTs this connector sends: the reporting API's read-only QUERIES
 * (a report is asked for with a JSON body; nothing is created, changed or
 * deleted — the key is read-only anyway). Any other path is refused before a
 * request is made, so no write endpoint can be reached through the client.
 */
export const KLAVIYO_QUERY_POST_PATHS = ['/api/campaign-values-reports'] as const;

export interface KlaviyoRequestOptions extends KlaviyoClientOptions {
  /** Pace key + minimum gap between two requests of that family (see pace()). */
  family?: string;
  minIntervalMs?: number;
}

/**
 * One request with up to KLAVIYO_MAX_ATTEMPTS tries (retryDelayMs: a short
 * `Retry-After` is waited out, a 5xx or a network failure backs off
 * exponentially with jitter). A longer wait is the RUN's backoff, not this
 * request's — the caller records it as `nextAttemptAt` and moves on.
 */
async function klaviyoRequest(
  method: 'GET' | 'POST',
  path: string,
  key: string,
  body: unknown,
  opts: KlaviyoRequestOptions = {},
): Promise<KlaviyoResult<unknown>> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  const url = `${klaviyoBaseUrl()}${path}`;
  // An injected fetch (unit tests) never leaves the process; the real one is guarded.
  if (!opts.fetchImpl && !insecureKlaviyoStubAllowed()) {
    try {
      await assertPublicHttpsUrl(url);
    } catch {
      return { ok: false, code: 'network' };
    }
  }
  const headers: Record<string, string> = klaviyoHeaders(key, klaviyoRevision());
  if (method === 'POST') headers['Content-Type'] = 'application/vnd.api+json';
  // What is logged: method, the path WITHOUT its query (a filter can carry an
  // id), status and duration. Never the key, never a body.
  const logPath = path.split('?')[0];
  for (let attempt = 1; ; attempt++) {
    await pace(opts.family, opts.minIntervalMs, sleep);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch {
      const wait = retryDelayMs(attempt, {});
      logger.debug('klaviyo request failed', { method, path: logPath, attempt, ms: Date.now() - started });
      if (wait === null) return { ok: false, code: 'network' };
      await sleep(wait);
      continue;
    }
    if (res.ok) {
      try {
        return { ok: true, data: await readBody(res) };
      } catch {
        return { ok: false, code: 'bad_response', status: res.status };
      }
    }
    // Drain without reading it into anything that is kept.
    await res.body?.cancel().catch(() => {});
    const retryAfter = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null;
    logger.debug('klaviyo request refused', { method, path: logPath, status: res.status, attempt, ms: Date.now() - started });
    const wait = retryDelayMs(attempt, { status: res.status, retryAfterMs: retryAfter });
    if (wait !== null) {
      await sleep(wait);
      continue;
    }
    return { ok: false, code: errorCodeForStatus(res.status), status: res.status, retryAfterMs: retryAfter };
  }
}

/** One GET (klaviyoRequest). Every read of the connector goes through here. */
export async function klaviyoGet(path: string, key: string, opts: KlaviyoRequestOptions = {}): Promise<KlaviyoResult<unknown>> {
  return klaviyoRequest('GET', path, key, undefined, opts);
}

/** A reporting-API query — the only POST, and only to KLAVIYO_QUERY_POST_PATHS. */
export async function klaviyoQuery(path: string, key: string, body: unknown, opts: KlaviyoRequestOptions = {}): Promise<KlaviyoResult<unknown>> {
  const bare = path.split('?')[0];
  if (!(KLAVIYO_QUERY_POST_PATHS as readonly string[]).includes(bare)) throw new Error(`klaviyoQuery: ${bare} is not a read-only query endpoint`);
  return klaviyoRequest('POST', path, key, body, opts);
}

export interface ResourcePage {
  data: unknown[];
  included: unknown[];
  nextCursor: string | null;
}

/** One JSON:API collection page: `data[]`, `included[]`, and the cursor of `links.next`. */
export async function fetchResourcePage(path: string, key: string, opts: KlaviyoRequestOptions = {}): Promise<KlaviyoResult<ResourcePage>> {
  const res = await klaviyoGet(path, key, opts);
  if (!res.ok) return res;
  const body = res.data as { data?: unknown; included?: unknown } | null;
  if (!Array.isArray(body?.data)) return { ok: false, code: 'bad_response' };
  return {
    ok: true,
    data: { data: body.data, included: Array.isArray(body.included) ? body.included : [], nextCursor: nextPageCursor(res.data) },
  };
}

export interface ProfilesPage {
  profiles: unknown[];
  nextCursor: string | null;
}

export async function fetchProfilesPage(
  key: string,
  query: { since: Date | null; cursor: string | null; pageSize?: number },
  opts: KlaviyoClientOptions = {},
): Promise<KlaviyoResult<ProfilesPage>> {
  const res = await klaviyoGet(profilesPath(query), key, opts);
  if (!res.ok) return res;
  const data = (res.data as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { ok: false, code: 'bad_response' };
  return { ok: true, data: { profiles: data, nextCursor: nextPageCursor(res.data) } };
}

/**
 * The account's list names by id, for showing which list a person subscribed
 * through. Best effort: a key without lists:read, or any failure, leaves the
 * map as far as it got — the profile then shows the list id instead.
 */
export async function fetchListNames(key: string, opts: KlaviyoClientOptions = {}): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < KLAVIYO_LIST_MAX_PAGES; page++) {
    const res = await klaviyoGet(listsPath(cursor), key, opts);
    if (!res.ok) break;
    const data = (res.data as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) break;
    for (const item of data) {
      const id = (item as { id?: unknown })?.id;
      const name = (item as { attributes?: { name?: unknown } })?.attributes?.name;
      if (typeof id === 'string' && typeof name === 'string' && name.trim()) names.set(id, name.trim().slice(0, 100));
    }
    cursor = nextPageCursor(res.data);
    if (!cursor) break;
  }
  return names;
}

/** "Test connection": one read-only call, one profile. */
export async function testKlaviyoKey(key: string, opts: KlaviyoClientOptions = {}): Promise<KlaviyoResult<{ profiles: number }>> {
  const res = await fetchProfilesPage(key, { since: null, cursor: null, pageSize: 1 }, opts);
  if (!res.ok) return res;
  return { ok: true, data: { profiles: res.data.profiles.length } };
}
