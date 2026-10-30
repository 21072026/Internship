// The OIDC twin of mapSamlProfile (#1929). Pure and dependency-free, so the
// browserless unit spec loads it without the server half (src/lib/ssoOidc.ts).

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
  if (!claims) throw new Error('empty ID token');
  const str = (k: string): string | null => {
    const v = claims[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const email = str('email')?.toLowerCase();
  if (!email) throw new Error('the ID token carries no email');
  if (claims.email_verified === false || claims.email_verified === 'false') {
    throw new Error('the IdP has not verified this email');
  }
  const fullName = str('name') || [str('given_name'), str('family_name')].filter(Boolean).join(' ').trim() || null;
  return { email, fullName };
}

