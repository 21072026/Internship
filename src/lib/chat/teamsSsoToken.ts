import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';

// Verifying the Teams tab's Entra token (#1954, docs/teams-tab-sso.md).
//
// The tab asks Teams for a token (microsoftTeams.authentication.getAuthToken);
// Entra mints it for OUR app registration. It is accepted only when ALL hold:
//
//   - RS256 signature against a key Entra publishes (by kid). The key set is
//     cached and refetched once on an unknown kid; a fetch that fails REFUSES.
//   - `aud` is exactly TEAMS_SSO_CLIENT_ID or api://<served host>/<id>.
//   - `iss` is login.microsoftonline.com/<tid>/v2.0 or sts.windows.net/<tid>/,
//     and that <tid> IS the token's `tid` claim.
//   - `exp`/`nbf` current with five minutes of skew; a token without `exp` is
//     refused.
//   - `tid` is a GUID and `oid` is present.
//
// The token is never logged, stored or returned — a refusal is a reason code.
// Which tenant is ours and which person `oid` is are the caller's questions
// (teamsSso.ts): this module only says what the token proves.

const CLOCK_SKEW_S = 5 * 60;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9-]{1,128}$/;
export const DEFAULT_TEAMS_SSO_JWKS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';

export type TeamsTokenRefusal = 'malformed' | 'bad_signature' | 'wrong_audience' | 'wrong_issuer' | 'expired' | 'no_tenant' | 'no_subject' | 'keys_unavailable';

export type TeamsTokenResult = { ok: true; tid: string; oid: string } | { ok: false; reason: TeamsTokenRefusal };

let jwks: { url: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

function keySet(url: string) {
  if (!jwks || jwks.url !== url) jwks = { url, set: createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000, cooldownDuration: 30_000 }) };
  return jwks.set;
}

/** Test seam: forget the cached key set. */
export function clearTeamsSsoKeyCache(): void {
  jwks = null;
}

/** The audiences a token for this app may carry on this host. */
export function teamsSsoAudiences(clientId: string, host: string | null): string[] {
  return host ? [clientId, `api://${host}/${clientId}`] : [clientId];
}

/** Does `iss` name exactly the tenant the token claims? */
export function issuerMatchesTenant(iss: unknown, tid: string): boolean {
  if (typeof iss !== 'string') return false;
  return iss === `https://login.microsoftonline.com/${tid}/v2.0` || iss === `https://sts.windows.net/${tid}/`;
}

export async function verifyTeamsSsoToken(
  token: string,
  opts: { clientId: string; host: string | null; jwksUrl?: string },
): Promise<TeamsTokenResult> {
  if (typeof token !== 'string' || token.length > 8192 || token.split('.').length !== 3) return { ok: false, reason: 'malformed' };
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, keySet(opts.jwksUrl || DEFAULT_TEAMS_SSO_JWKS_URL), {
      algorithms: ['RS256'],
      audience: teamsSsoAudiences(opts.clientId, opts.host),
      clockTolerance: CLOCK_SKEW_S,
      requiredClaims: ['exp', 'iss', 'aud'],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' };
    if (e instanceof joseErrors.JWTClaimValidationFailed) return { ok: false, reason: e.claim === 'aud' ? 'wrong_audience' : e.claim === 'nbf' ? 'expired' : 'malformed' };
    if (e instanceof joseErrors.JWKSTimeout || (e instanceof Error && /fetch|ECONN|network/i.test(e.message))) return { ok: false, reason: 'keys_unavailable' };
    if (e instanceof joseErrors.JWSSignatureVerificationFailed || e instanceof joseErrors.JWKSNoMatchingKey) return { ok: false, reason: 'bad_signature' };
    return { ok: false, reason: 'malformed' };
  }
  const tid = payload.tid;
  if (typeof tid !== 'string' || !GUID.test(tid)) return { ok: false, reason: 'no_tenant' };
  if (!issuerMatchesTenant(payload.iss, tid)) return { ok: false, reason: 'wrong_issuer' };
  const oid = payload.oid;
  if (typeof oid !== 'string' || !ID.test(oid)) return { ok: false, reason: 'no_subject' };
  return { ok: true, tid: tid.toLowerCase(), oid };
}
