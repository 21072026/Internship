// Outbound requests the SSO onboarding screens make on an admin's say-so
// (#1933): fetching an IdP's metadata document by URL, and probing the entry
// point in "Test connection". Both URLs are admin-supplied and fetched from the
// server's network position, so every hop goes through `assertPublicHttpsUrl()`
// — including each redirect target, which `fetch`'s own redirect following
// would never show us — with a short timeout and a byte cap.

import { assertPublicHttpsUrl, SsrfBlockedError } from '@/lib/ssrfGuard';

const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

export class SsoFetchError extends Error {
  readonly code: 'fetch_blocked' | 'fetch_failed' | 'too_large';
  constructor(code: SsoFetchError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** One request, redirects followed by hand and each target re-checked. */
async function guardedFetch(raw: string): Promise<Response> {
  let target = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let safe: URL;
    try {
      safe = await assertPublicHttpsUrl(target);
    } catch (e) {
      if (e instanceof SsrfBlockedError) throw new SsoFetchError('fetch_blocked', e.message);
      throw e;
    }
    let res: Response;
    try {
      res = await fetch(safe, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new SsoFetchError('fetch_failed', timedOut ? `No answer within ${TIMEOUT_MS / 1000}s` : 'The host could not be reached');
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      target = new URL(location, safe).toString();
      continue;
    }
    return res;
  }
  throw new SsoFetchError('fetch_failed', `More than ${MAX_REDIRECTS} redirects`);
}

/** The body of a 2xx answer as text, refused past `maxBytes` (read incrementally). */
export async function fetchPublicText(url: string, maxBytes: number): Promise<string> {
  const res = await guardedFetch(url);
  if (!res.ok) throw new SsoFetchError('fetch_failed', `The server answered HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new SsoFetchError('too_large', 'The document is too large');
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SsoFetchError('too_large', 'The document is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The HTTP status an entry point answers with (body discarded). */
export async function probePublicUrl(url: string): Promise<number> {
  const res = await guardedFetch(url);
  await res.body?.cancel().catch(() => {});
  return res.status;
}
