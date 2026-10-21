// The Klaviyo HTTP client: GET only, one fixed host, bounded in time and size
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
  KLAVIYO_INLINE_WAIT_MAX_MS,
  KLAVIYO_LIST_MAX_PAGES,
  errorCodeForStatus,
  isRetryableStatus,
  klaviyoHeaders,
  listsPath,
  nextPageCursor,
  profilesPath,
  retryAfterMs,
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

/**
 * One GET with at most one retry: a 5xx after a second's pause, a 429 after the
 * `Retry-After` it names when that is short (KLAVIYO_INLINE_WAIT_MAX_MS).
 * Anything longer is the RUN's backoff, not this request's — the caller records
 * it as `nextAttemptAt` and the scheduler moves on to the next tenant.
 */
export async function klaviyoGet(path: string, key: string, opts: KlaviyoClientOptions = {}): Promise<KlaviyoResult<unknown>> {
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
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: klaviyoHeaders(key),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch {
      if (attempt === 0) {
        await sleep(1000);
        continue;
      }
      return { ok: false, code: 'network' };
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
    const wait = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : 1000;
    if (attempt === 0 && isRetryableStatus(res.status) && wait !== null && wait <= KLAVIYO_INLINE_WAIT_MAX_MS) {
      await sleep(Math.max(wait, 250));
      continue;
    }
    return {
      ok: false,
      code: errorCodeForStatus(res.status),
      status: res.status,
      retryAfterMs: res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null,
    };
  }
  return { ok: false, code: 'upstream_error' };
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
