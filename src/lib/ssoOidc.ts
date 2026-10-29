// OpenID Connect sign-in for Enterprise SSO (#1929, docs/sso-oidc.md) — the
// OIDC twin of src/lib/ssoSaml.ts. Server-only: it opens the sealed client
// secret, fetches the IdP's documents and writes the request store.
//
// THE FLOW — authorization code with PKCE (S256), `state` and `nonce`:
//   login route    beginOidcLogin(): one single-use SsoAuthRequest row holds
//                  the state, the nonce and the PKCE verifier; the browser goes
//                  to the IdP's authorization endpoint.
//   callback route spendOidcRequest() burns the row (conditional updateMany on
//                  usedAt: null — a replayed or raced state finds nothing), then
//                  completeOidcLogin() exchanges the code with the verifier and
//                  VERIFIES THE ID TOKEN against the IdP's JWKS: signature (an
//                  allowlist of asymmetric algorithms — never `none`, never an
//                  HMAC keyed by a value the IdP publishes), `iss` = the
//                  configured issuer, `aud` = our client ID (`azp` too when the
//                  audience is a list), `exp`/`iat` with 5 s of skew, and the
//                  `nonce` we issued. The claims then go through the SAME
//                  provisionSsoUser + SsoLoginGrant bridge SAML uses
//                  (src/lib/ssoCompletion.ts) — there is one session-minting path.
//
// EVERY OUTBOUND FETCH (discovery, JWKS, token) goes through the SSRF guard:
// the discovery URL is admin-supplied, and the endpoints it names are whatever
// that document says. Redirects are refused rather than followed, answers are
// capped in size and time. The e2e stub IdP speaks plain http on loopback, so
// SSO_ALLOW_INSECURE_STUB=1 lets exactly http://127.0.0.1 / localhost past the
// guard — a test-only switch that logs when it takes effect and is never set
// on a deployment (the same shape as HIBP_ALLOW_INSECURE_STUB).
//
// The discovery document and the JWKS are cached on the org row
// (ssoJwksCache / ssoJwksFetchedAt, #1926) for an hour, and refetched once when
// an ID token names a key id the cache does not hold — an IdP key rotation is
// therefore never an outage.

import crypto from 'node:crypto';
import { createLocalJWKSet, jwtVerify, errors as joseErrors, type JSONWebKeySet, type JWTPayload } from 'jose';
import { prisma } from '@/lib/prisma';
import { open } from '@/lib/secretBox';
import { assertPublicHttpsUrl } from '@/lib/ssrfGuard';
import { OIDC_CLIENT_SECRET_PURPOSE } from '@/lib/sso';
import { configuredOrigin } from '@/lib/servedHosts';
import { logger } from '@/lib/logger';

export const OIDC_DEFAULT_SCOPES = 'openid email profile';
/** How long a login may take between our redirect and the IdP's callback. */
export const OIDC_REQUEST_TTL_MS = 10 * 60 * 1000;
const PROVIDER_CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
// Asymmetric only. `none` and the HS* family are refused outright: an HMAC
// "verified" with a key anyone can read would verify anything.
export const OIDC_ID_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
const CLOCK_SKEW_S = 5;

/** The cookie that binds a login to the browser that started it (login CSRF). */
export const OIDC_STATE_COOKIE = 'sso_oidc_state';

export class OidcError extends Error {}

/** The org columns this module reads. */
export interface OidcOrg {
  id: string;
  slug: string;
  ssoIssuer: string | null;
  ssoClientId: string | null;
  ssoClientSecretEnc: string | null;
  ssoDiscoveryUrl: string | null;
  ssoScopes: string | null;
  ssoJwksCache: unknown;
  ssoJwksFetchedAt: Date | null;
}

interface ProviderDocs {
  discovery: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    token_endpoint_auth_methods_supported?: string[];
  };
  jwks: JSONWebKeySet;
}

/**
 * The redirect URI a customer registers at their IdP. Like the SAML ACS it
 * hangs off the configured origin (NEXTAUTH_URL): an IdP registration names one
 * URL, whatever host the sign-in started on.
 */
export function oidcCallbackUrl(slug: string, base: string = configuredOrigin()): string {
  return `${base.replace(/\/+$/, '')}/api/auth/sso/${slug}/callback`;
}

export function insecureOidcStubAllowed(): boolean {
  return process.env.SSO_ALLOW_INSECURE_STUB === '1';
}

async function guardUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcError('not a URL');
  }
  if (insecureOidcStubAllowed() && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
    logger.warning('sso.oidc: insecure loopback IdP allowed by SSO_ALLOW_INSECURE_STUB (test switch)');
    return url;
  }
  return assertPublicHttpsUrl(raw);
}

async function oidcFetchJson(raw: string, init?: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<Record<string, unknown>> {
  const url = await guardUrl(raw);
  let res: Response;
  try {
    res = await fetch(url, {
      ...(init ?? {}),
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new OidcError(`${url.host} could not be reached`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new OidcError(`${url.host} answered with an oversized document`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OidcError(`${url.host} did not answer with JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new OidcError(`${url.host} refused: ${err}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OidcError(`${url.host} answered with an unexpected document`);
  return body as Record<string, unknown>;
}

function readCache(raw: unknown): ProviderDocs | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<ProviderDocs>;
  if (!c.discovery || !c.jwks || !Array.isArray(c.jwks.keys)) return null;
  return c as ProviderDocs;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The discovery document and the JWKS, cached on the org row. */
async function providerDocs(org: OidcOrg, opts: { refresh?: boolean } = {}): Promise<ProviderDocs> {
  const cached = readCache(org.ssoJwksCache);
  const fresh = cached && org.ssoJwksFetchedAt && Date.now() - org.ssoJwksFetchedAt.getTime() < PROVIDER_CACHE_TTL_MS;
  if (cached && fresh && !opts.refresh) return cached;
  if (!org.ssoDiscoveryUrl || !org.ssoIssuer) throw new OidcError('OIDC is not configured');

  const d = await oidcFetchJson(org.ssoDiscoveryUrl);
  // OpenID Connect Discovery § 4.3: the document's issuer MUST be the one we
  // expect, or a discovery URL could hand us another IdP's endpoints.
  if (d.issuer !== org.ssoIssuer) throw new OidcError('the discovery document names a different issuer');
  if (!isStr(d.authorization_endpoint) || !isStr(d.token_endpoint) || !isStr(d.jwks_uri)) {
    throw new OidcError('the discovery document lacks an authorization, token or JWKS endpoint');
  }
  const keys = await oidcFetchJson(d.jwks_uri);
  if (!Array.isArray(keys.keys)) throw new OidcError('the JWKS has no keys');
  const docs: ProviderDocs = {
    discovery: {
      issuer: d.issuer as string,
      authorization_endpoint: d.authorization_endpoint,
      token_endpoint: d.token_endpoint,
      jwks_uri: d.jwks_uri,
      ...(Array.isArray(d.token_endpoint_auth_methods_supported)
        ? { token_endpoint_auth_methods_supported: (d.token_endpoint_auth_methods_supported as unknown[]).filter(isStr) }
        : {}),
    },
    // Public keys only: a private member published by mistake is not stored.
    jwks: { keys: (keys.keys as Record<string, unknown>[]).map(({ d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, k: _k, ...pub }) => pub) } as JSONWebKeySet,
  };
  await prisma.organization.update({
    where: { id: org.id },
    data: { ssoJwksCache: docs as object, ssoJwksFetchedAt: new Date() },
  });
  return docs;
}

/** "Test connection" (#1933 for SAML): refetch discovery + JWKS now. Throws OidcError. */
export async function probeOidcProvider(org: OidcOrg): Promise<{ keys: number }> {
  const docs = await providerDocs(org, { refresh: true });
  return { keys: docs.jwks.keys.length };
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Start a login: persist the single-use request and return the IdP URL. The
 * `state` is also returned so the route can bind it to the browser.
 */
export async function beginOidcLogin(org: OidcOrg, returnOrigin: string | null): Promise<{ url: string; state: string }> {
  if (!org.ssoClientId) throw new OidcError('OIDC client ID is missing');
  const docs = await providerDocs(org);
  const state = b64url(crypto.randomBytes(32));
  const nonce = b64url(crypto.randomBytes(32));
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  await prisma.ssoAuthRequest.create({
    data: {
      orgId: org.id,
      kind: 'oidc',
      state,
      nonce,
      codeVerifier,
      returnOrigin,
      expiresAt: new Date(Date.now() + OIDC_REQUEST_TTL_MS),
    },
  });
  const url = new URL(docs.discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', org.ssoClientId);
  url.searchParams.set('redirect_uri', oidcCallbackUrl(org.slug));
  url.searchParams.set('scope', org.ssoScopes?.trim() || OIDC_DEFAULT_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state };
}

/**
 * Burn the request named by `state` — for THIS org, unused, unexpired — and
 * return it, or null. The conditional update IS the admission: two tabs (or a
 * replay) racing for one state cannot both get a row back.
 */
export async function spendOidcRequest(state: string, orgId: string) {
  const now = new Date();
  const spent = await prisma.ssoAuthRequest.updateMany({
    where: { state, orgId, kind: 'oidc', usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (spent.count !== 1) return null;
  return prisma.ssoAuthRequest.findUnique({
    where: { state },
    select: { nonce: true, codeVerifier: true, returnOrigin: true },
  });
}

/** Exchange the code and return the VERIFIED ID-token claims. Throws OidcError. */
export async function completeOidcLogin(
  org: OidcOrg,
  code: string,
  request: { nonce: string | null; codeVerifier: string | null },
): Promise<JWTPayload> {
  if (!org.ssoClientId || !org.ssoClientSecretEnc || !org.ssoIssuer) throw new OidcError('OIDC is not configured');
  if (!request.nonce || !request.codeVerifier) throw new OidcError('the login request is incomplete');
  const secret = open(org.ssoClientSecretEnc, OIDC_CLIENT_SECRET_PURPOSE);
  if (!secret) throw new OidcError('the stored client secret cannot be opened');
  const docs = await providerDocs(org);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oidcCallbackUrl(org.slug),
    code_verifier: request.codeVerifier,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // client_secret_basic is the spec's default; post only when the IdP says it
  // does not take basic. Never both (RFC 6749 § 2.3).
  const methods = docs.discovery.token_endpoint_auth_methods_supported;
  if (!methods || methods.length === 0 || methods.includes('client_secret_basic')) {
    const enc = (v: string) => encodeURIComponent(v);
    headers.Authorization = `Basic ${Buffer.from(`${enc(org.ssoClientId)}:${enc(secret)}`).toString('base64')}`;
  } else {
    body.set('client_id', org.ssoClientId);
    body.set('client_secret', secret);
  }
  const tokens = await oidcFetchJson(docs.discovery.token_endpoint, { method: 'POST', headers, body: body.toString() });
  if (!isStr(tokens.id_token)) throw new OidcError('the token response carries no ID token');

  const verify = (keys: JSONWebKeySet) =>
    jwtVerify(tokens.id_token as string, createLocalJWKSet(keys), {
      issuer: org.ssoIssuer!,
      audience: org.ssoClientId!,
      algorithms: OIDC_ID_TOKEN_ALGORITHMS,
      clockTolerance: CLOCK_SKEW_S,
      requiredClaims: ['exp', 'iat', 'sub'],
    });
  let payload: JWTPayload;
  try {
    ({ payload } = await verify(docs.jwks));
  } catch (e) {
    // An unknown key id is a rotation at the IdP: refetch once, then judge.
    if (e instanceof joseErrors.JWKSNoMatchingKey) {
      const refreshed = await providerDocs(org, { refresh: true });
      try {
        ({ payload } = await verify(refreshed.jwks));
      } catch (e2) {
        throw new OidcError(`ID token rejected: ${e2 instanceof Error ? e2.message : 'invalid'}`);
      }
    } else {
      throw new OidcError(`ID token rejected: ${e instanceof Error ? e.message : 'invalid'}`);
    }
  }
  if (payload.nonce !== request.nonce) throw new OidcError('ID token rejected: nonce mismatch');
  // OIDC Core § 3.1.3.7: several audiences require an authorized party, and it must be us.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== org.ssoClientId) {
    throw new OidcError('ID token rejected: azp is not this client');
  }
  return payload;
}

export interface OidcIdentity {
  email: string;
  fullName: string | null;
}

/**
 * The OIDC twin of mapSamlProfile. Pure. The email is required and, where the
 * IdP says whether it is verified, it must be — an unverified address is
 * whatever the person typed into their IdP profile.
 */
export function mapOidcClaims(claims: Record<string, unknown> | null | undefined): OidcIdentity {
  if (!claims) throw new OidcError('empty ID token');
  const str = (k: string): string | null => {
    const v = claims[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const email = str('email')?.toLowerCase();
  if (!email) throw new OidcError('the ID token carries no email');
  if (claims.email_verified === false || claims.email_verified === 'false') {
    throw new OidcError('the IdP has not verified this email');
  }
  const fullName = str('name') || [str('given_name'), str('family_name')].filter(Boolean).join(' ').trim() || null;
  return { email, fullName };
}

/** Nightly: delete expired request rows (spent ones expire too). */
export async function purgeExpiredSsoAuthRequests(now: Date = new Date()): Promise<number> {
  const r = await prisma.ssoAuthRequest.deleteMany({ where: { expiresAt: { lt: now } } });
  return r.count;
}
