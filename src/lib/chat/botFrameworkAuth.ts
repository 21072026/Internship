import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

// The Bot Framework's request authentication (#3322): every activity Teams
// sends to the bot's messaging endpoint carries `Authorization: Bearer <JWT>`,
// signed RS256 by a key the Bot Framework publishes behind its OpenID
// metadata. A token is accepted only when ALL of these hold:
//
//   - the signature verifies against a published key (by `kid`);
//   - `iss` is the Bot Framework, `aud` is OUR app id (TEAMS_APP_ID);
//   - `nbf` / `exp` are current, with five minutes of clock skew;
//   - the `serviceUrl` claim equals the activity's serviceUrl — the token was
//     minted for THIS conversation's connector, not lifted from another.
//
// node:crypto only, no JWT library: the parsing is a few lines and every
// branch is written out where it can be read. Keys are cached for an hour and
// refetched once on an unknown `kid` (Microsoft rotates them); a metadata or
// JWKS fetch that fails REFUSES the request — fail closed, an unauthenticated
// door is worse than a missed uninstall.
//
// The metadata URL comes from env (TEAMS_OPENID_METADATA_URL) with the real
// default, so the e2e can point it at a stub. Operator config, never input.

import { BOT_FRAMEWORK_ISSUER, BOT_FRAMEWORK_OPENID_METADATA_URL } from '@/lib/chat/client/botFrameworkEndpoints';

export { BOT_FRAMEWORK_ISSUER };
const CLOCK_SKEW_S = 5 * 60;
const KEYS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

export function botFrameworkMetadataUrl(): string {
  return process.env.TEAMS_OPENID_METADATA_URL || BOT_FRAMEWORK_OPENID_METADATA_URL;
}

type Jwk = JsonWebKey & { kid?: string };
let cache: { keys: Jwk[]; fetchedAt: number; source: string } | null = null;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

async function loadKeys(force: boolean): Promise<Jwk[]> {
  const source = botFrameworkMetadataUrl();
  if (!force && cache && cache.source === source && Date.now() - cache.fetchedAt < KEYS_TTL_MS) return cache.keys;
  const meta = (await fetchJson(source)) as { jwks_uri?: unknown };
  if (typeof meta?.jwks_uri !== 'string' || !/^https?:\/\//.test(meta.jwks_uri)) throw new Error('no_jwks_uri');
  const jwks = (await fetchJson(meta.jwks_uri)) as { keys?: unknown };
  const keys = Array.isArray(jwks?.keys) ? (jwks.keys as Jwk[]).filter((k) => k && k.kty === 'RSA' && typeof k.kid === 'string') : [];
  cache = { keys, fetchedAt: Date.now(), source };
  return keys;
}

/** Test seam: forget the cached keys (a spec that swaps the stub's keys). */
export function clearBotFrameworkKeyCache(): void {
  cache = null;
}

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type BotAuthRefusal =
  | 'no_token'
  | 'malformed'
  | 'bad_alg'
  | 'unknown_key'
  | 'bad_signature'
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'service_url_mismatch'
  | 'keys_unavailable'
  | 'not_configured';

/**
 * Verify the request's bearer token for an activity whose `serviceUrl` the
 * caller read from the body. Answers `{ ok: true }` or the reason for refusal
 * (for the log line — the response is a bare 401 either way).
 */
export async function verifyBotFrameworkRequest(input: {
  authorization: string | null;
  serviceUrl: string | null;
  nowS?: number;
}): Promise<{ ok: true } | { ok: false; reason: BotAuthRefusal }> {
  const appId = process.env.TEAMS_APP_ID;
  if (!appId) return { ok: false, reason: 'not_configured' };
  const m = /^Bearer\s+(\S+)$/i.exec(input.authorization ?? '');
  if (!m) return { ok: false, reason: 'no_token' };
  const parts = m[1].split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (!header || !claims) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'bad_alg' };

  let keys: Jwk[];
  try {
    keys = await loadKeys(false);
    if (!keys.some((k) => k.kid === header.kid)) keys = await loadKeys(true);
  } catch {
    return { ok: false, reason: 'keys_unavailable' };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown_key' };

  let valid = false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    valid = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  if (claims.iss !== BOT_FRAMEWORK_ISSUER) return { ok: false, reason: 'bad_issuer' };
  const aud = claims.aud;
  if (!(aud === appId || (Array.isArray(aud) && aud.includes(appId)))) return { ok: false, reason: 'bad_audience' };
  const now = input.nowS ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) return { ok: false, reason: 'not_yet_valid' };
  const strip = (u: unknown) => (typeof u === 'string' ? u.replace(/\/+$/, '') : null);
  if (!strip(claims.serviceUrl) || strip(claims.serviceUrl) !== strip(input.serviceUrl)) {
    return { ok: false, reason: 'service_url_mismatch' };
  }
  return { ok: true };
}
