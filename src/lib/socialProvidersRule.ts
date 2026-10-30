// Social sign-in providers (#1962) — the per-provider DIFFERENCES, pure and
// dependency-free (scripts/test/social-sign-in.test.mjs). The flow itself is
// the tenant-SSO OIDC engine (src/lib/ssoOidc.ts, #1929): discovery, PKCE,
// state + nonce in the single-use SsoAuthRequest row, ID-token verification
// against the provider's JWKS. Nothing here verifies anything; it says which
// issuer, which scopes, and how each provider spells "this email is verified".
//
// OPERATOR CONFIGURATION, installation-wide (never per tenant), from env:
//   SOCIAL_SIGN_IN=1                       the feature flag; off = no provider anywhere
//   SOCIAL_<P>_CLIENT_ID / _CLIENT_SECRET  per provider; missing = that provider is INVISIBLE
//   SOCIAL_<P>_DISCOVERY_URL / _ISSUER     overrides — the e2e stub IdP, a sovereign cloud
// with <P> one of GOOGLE, MICROSOFT, LINKEDIN. The secret stays in the
// server's environment and no API ever returns it.

export const SOCIAL_PROVIDERS = ['google', 'microsoft', 'linkedin'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export function isSocialProvider(v: unknown): v is SocialProvider {
  return typeof v === 'string' && (SOCIAL_PROVIDERS as readonly string[]).includes(v);
}

export interface SocialProviderSpec {
  label: string;
  issuer: string;
  discoveryUrl: string;
  scopes: string;
  /**
   * Microsoft's multi-tenant endpoint publishes a TEMPLATED issuer
   * ("…/{tenantid}/v2.0") and signs each token with the user's directory, so
   * the token's `iss` is checked against its own `tid` instead.
   */
  perDirectoryIssuer?: boolean;
}

/**
 * The defaults, from each provider's published OIDC configuration. LinkedIn's
 * "Sign In with LinkedIn using OpenID Connect" product needs the `profile` and
 * `email` scopes with `openid`, and authenticates the token request with
 * client_secret_post — which the engine picks from the discovery document's
 * `token_endpoint_auth_methods_supported`, so there is no LinkedIn branch for it.
 */
export const PROVIDER_SPECS: Readonly<Record<SocialProvider, SocialProviderSpec>> = Object.freeze({
  google: {
    label: 'Google',
    issuer: 'https://accounts.google.com',
    discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
    scopes: 'openid email profile',
  },
  microsoft: {
    label: 'Microsoft',
    issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
    discoveryUrl: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    scopes: 'openid email profile',
    perDirectoryIssuer: true,
  },
  linkedin: {
    label: 'LinkedIn',
    issuer: 'https://www.linkedin.com/oauth',
    discoveryUrl: 'https://www.linkedin.com/oauth/.well-known/openid-configuration',
    scopes: 'openid profile email',
  },
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Microsoft: `iss` must be the directory named by the token's own `tid`. */
export function microsoftIssuerMatches(iss: string, claims: Record<string, unknown>): boolean {
  const tid = typeof claims.tid === 'string' ? claims.tid : '';
  return GUID.test(tid) && iss === `https://login.microsoftonline.com/${tid}/v2.0`;
}

type Env = Record<string, string | undefined>;

export interface ResolvedSocialProvider extends SocialProviderSpec {
  id: SocialProvider;
  clientId: string;
  clientSecret: string;
}

/**
 * The providers this installation offers: the feature flag on AND both
 * credentials present. A provider without credentials is not returned at all,
 * so no screen can draw a button that leads nowhere.
 */
export function configuredProviders(env: Env): ResolvedSocialProvider[] {
  if (env.SOCIAL_SIGN_IN !== '1') return [];
  const out: ResolvedSocialProvider[] = [];
  for (const id of SOCIAL_PROVIDERS) {
    const P = id.toUpperCase();
    const clientId = env[`SOCIAL_${P}_CLIENT_ID`]?.trim();
    const clientSecret = env[`SOCIAL_${P}_CLIENT_SECRET`]?.trim();
    if (!clientId || !clientSecret) continue;
    const spec = PROVIDER_SPECS[id];
    const issuerOverride = env[`SOCIAL_${P}_ISSUER`]?.trim();
    out.push({
      ...spec,
      id,
      clientId,
      clientSecret,
      discoveryUrl: env[`SOCIAL_${P}_DISCOVERY_URL`]?.trim() || spec.discoveryUrl,
      issuer: issuerOverride || spec.issuer,
      // An explicit issuer is a fixed one (a single-tenant directory, the stub).
      perDirectoryIssuer: issuerOverride ? false : spec.perDirectoryIssuer,
    });
  }
  return out;
}

export interface SocialIdentityClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

const truthy = (v: unknown) => v === true || v === 'true';

/**
 * The identity a verified ID token asserts. A MISSING verification claim is
 * "not verified" — linking on an unverified address is account takeover.
 * Microsoft has no `email_verified`; its optional `xms_edov` ("email domain
 * owner verified") is the equivalent, and without it a Microsoft address never
 * links to an existing account.
 */
export function socialIdentityFrom(provider: SocialProvider, claims: Record<string, unknown>): SocialIdentityClaims | null {
  const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!subject) return null;
  const rawEmail = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const email = rawEmail && /^[^\s@]+@[^\s@]+$/.test(rawEmail) ? rawEmail : null;
  const emailVerified = !!email && (truthy(claims.email_verified) || (provider === 'microsoft' && truthy(claims.xms_edov)));
  const given = typeof claims.given_name === 'string' ? claims.given_name : '';
  const family = typeof claims.family_name === 'string' ? claims.family_name : '';
  const name = (typeof claims.name === 'string' && claims.name.trim()) || `${given} ${family}`.trim() || null;
  return { subject, email, emailVerified, name };
}

export type SocialDecision =
  | { action: 'sign_in'; userId: string }
  | { action: 'link_and_sign_in'; userId: string }
  | { action: 'link_only'; userId: string }
  | { action: 'create'; pending: boolean }
  | { action: 'refuse'; reason: 'unverified_email' | 'identity_taken' | 'no_email' };

/**
 * THE linking rule. Three facts decide it: whether this provider subject is
 * already linked, whether a signed-in person asked to connect it ("connect"
 * from account settings, after proving their password), and whether an
 * account in this world already holds the address.
 *   1. A known subject signs in to its account — always (unless a different
 *      signed-in person is trying to claim it).
 *   2. A connect request links to the signed-in account, whatever the email.
 *   3. A new subject whose address matches an account links ONLY on a
 *      verified email; otherwise nothing is linked and nothing is created.
 *   4. A new subject with no match creates an account — on a verified email
 *      only, and parked for an admin when self-registration is 'manual'.
 */
export function decideSocialSignIn(input: {
  identityUserId: string | null;
  linkUserId: string | null;
  matchedUserId: string | null;
  identity: SocialIdentityClaims;
  selfRegistration: string;
}): SocialDecision {
  const { identityUserId, linkUserId, matchedUserId, identity } = input;
  if (identityUserId) {
    if (linkUserId && linkUserId !== identityUserId) return { action: 'refuse', reason: 'identity_taken' };
    return linkUserId ? { action: 'link_only', userId: identityUserId } : { action: 'sign_in', userId: identityUserId };
  }
  if (linkUserId) return { action: 'link_only', userId: linkUserId };
  if (!identity.email) return { action: 'refuse', reason: 'no_email' };
  if (!identity.emailVerified) return { action: 'refuse', reason: 'unverified_email' };
  if (matchedUserId) return { action: 'link_and_sign_in', userId: matchedUserId };
  return { action: 'create', pending: input.selfRegistration === 'manual' };
}

/**
 * May this identity be removed? Never the last way in: an account without a
 * usable password keeps at least one linked identity.
 */
export function canUnlinkIdentity(hasUsablePassword: boolean, identityCount: number): boolean {
  return hasUsablePassword || identityCount > 1;
}
