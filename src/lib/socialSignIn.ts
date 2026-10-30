// Social sign-in (#1962, docs/social-sign-in.md) — the Prisma-aware half.
// The per-provider differences and THE linking rule are pure in
// src/lib/socialProvidersRule.ts; the OIDC flow is the tenant-SSO engine
// (src/lib/ssoOidc.ts) run with a provider's OidcClient.
//
// HOW A SOCIAL SIGN-IN BECOMES A SESSION: it does not mint one itself. Once
// the provider's ID token is verified and the linking rule names an account,
// this mints a single-use sign-in link (createLoginLinkToken, #1959) and the
// browser redeems it through the `magic` NextAuth provider — the
// password-equivalent door. So every rule that door applies applies here too,
// with no second copy: inactive / unverified / pending accounts, enforced SSO
// (#1950), the archived tenant, the world of the host, and above all the
// account's own second factor (requireSecondFactor) — a Google login never
// skips an enrolled authenticator.
//
// WHERE: the INTERNSHIP world only. The MARKETING product is invitation-only
// (#2501), and an account is matched in the world of the host, so a social
// identity can never reach the other product's account or move a user between
// tenants: an existing account is signed in to its own org, and a new one is
// created in the default organization.
//
// Server-only.

import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { createUser } from '@/lib/userCreate';
import { defaultOrgId } from '@/lib/defaultOrg';
import { findUserInWorld, emailTakenInWorld } from '@/lib/userWorld';
import { resolveSetting } from '@/lib/settingsResolver';
import { isOrgEnforcingSso, isPasswordLoginBlocked } from '@/lib/ssoEnforcement';
import { configuredOrigin } from '@/lib/servedHosts';
import { worldForHeaders } from '@/lib/hostWorld';
import type { OidcClient, ProviderDocs } from '@/lib/ssoOidc';
import {
  configuredProviders,
  decideSocialSignIn,
  microsoftIssuerMatches,
  type ResolvedSocialProvider,
  type SocialIdentityClaims,
  type SocialProvider,
} from '@/lib/socialProvidersRule';

/** The providers this installation offers right now (flag on + credentials). */
export function enabledSocialProviders(): ResolvedSocialProvider[] {
  return configuredProviders(process.env);
}

export function socialProvider(id: string): ResolvedSocialProvider | null {
  return enabledSocialProviders().find((p) => p.id === id) ?? null;
}

/** The one registered redirect URI per provider, on the configured origin (like the SSO callback). */
export function socialCallbackUrl(id: SocialProvider): string {
  return `${configuredOrigin().replace(/\/+$/, '')}/api/auth/social/${id}/callback`;
}

/** The cookie that binds a social login to the browser that started it (login CSRF). */
export const SOCIAL_STATE_COOKIE = 'social_oidc_state';

/** The SsoAuthRequest `kind` of a social login. */
export const socialKind = (id: SocialProvider) => `social:${id}`;

// The providers' discovery documents and keys, per process for an hour — an
// installation-wide provider has no row to cache on. A key the cache does not
// hold is refetched by the engine at once, so a rotation is not an outage.
const docsCache = new Map<SocialProvider, { docs: ProviderDocs; at: Date }>();

export function socialClient(p: ResolvedSocialProvider): OidcClient {
  return {
    issuer: p.issuer,
    clientId: p.clientId,
    clientSecret: () => p.clientSecret,
    discoveryUrl: p.discoveryUrl,
    scopes: p.scopes,
    redirectUri: socialCallbackUrl(p.id),
    ...(p.perDirectoryIssuer ? { issuerMatches: (iss: string, claims: Record<string, unknown>) => microsoftIssuerMatches(iss, claims) } : {}),
    cache: {
      read: () => {
        const hit = docsCache.get(p.id);
        return { docs: hit?.docs ?? null, fetchedAt: hit?.at ?? null };
      },
      write: async (docs) => {
        docsCache.set(p.id, { docs, at: new Date() });
      },
    },
  };
}

export type SocialOutcome =
  | { kind: 'sign_in'; userId: string }
  | { kind: 'linked'; userId: string }
  | { kind: 'pending' }
  | { kind: 'refuse'; reason: 'unverified_email' | 'identity_taken' | 'no_email' | 'sso_required' | 'unavailable' };

const userSelect = { id: true, orgId: true, ssoExempt: true, isActive: true } as const;

async function link(provider: SocialProvider, identity: SocialIdentityClaims, userId: string, how: string) {
  await prisma.userIdentity.upsert({
    where: { provider_subject: { provider, subject: identity.subject } },
    create: { userId, provider, subject: identity.subject, email: identity.email },
    update: { lastUsedAt: new Date(), email: identity.email },
  });
  // Linking an identity grants a credential — warning level, names only.
  await logActivity({ action: 'auth.identity_linked', level: 'warning', actorId: userId, targetType: 'user', targetId: userId, detail: `${provider} (${how})` });
}

/**
 * Apply THE linking rule (socialProvidersRule.ts) to a verified identity.
 * `linkUserId` is the signed-in account that asked to connect this provider
 * (set by the login route from the session, never from a request body).
 */
export async function resolveSocialSignIn(
  provider: SocialProvider,
  identity: SocialIdentityClaims,
  linkUserId: string | null,
): Promise<SocialOutcome> {
  const existing = await prisma.userIdentity.findUnique({
    where: { provider_subject: { provider, subject: identity.subject } },
    select: { userId: true },
  });
  const matched = identity.email ? await findUserInWorld(identity.email, 'INTERNSHIP', { id: true }) : null;
  const orgId = await defaultOrgId();
  const decision = decideSocialSignIn({
    identityUserId: existing?.userId ?? null,
    linkUserId,
    matchedUserId: matched?.id ?? null,
    identity,
    selfRegistration: String(await resolveSetting('selfRegistration', { orgId })),
  });

  switch (decision.action) {
    case 'refuse':
      return { kind: 'refuse', reason: decision.reason };
    case 'link_only': {
      await link(provider, identity, decision.userId, 'connected by the signed-in account');
      return { kind: 'linked', userId: decision.userId };
    }
    case 'sign_in':
    case 'link_and_sign_in': {
      const user = await prisma.user.findUnique({ where: { id: decision.userId }, select: userSelect });
      if (!user) return { kind: 'refuse', reason: 'unavailable' };
      // Enforced SSO (#1950): this tenant's people sign in through its IdP only.
      if (await isPasswordLoginBlocked(user)) return { kind: 'refuse', reason: 'sso_required' };
      if (decision.action === 'link_and_sign_in') await link(provider, identity, user.id, 'verified email match');
      else await prisma.userIdentity.update({ where: { provider_subject: { provider, subject: identity.subject } }, data: { lastUsedAt: new Date() } });
      return { kind: 'sign_in', userId: user.id };
    }
    case 'create': {
      if (await isOrgEnforcingSso(orgId)) return { kind: 'refuse', reason: 'sso_required' };
      // Asked again right before the write: the database only catches a
      // duplicate inside one org (docs/worlds.md rule 1).
      if (await emailTakenInWorld(identity.email!, 'INTERNSHIP')) return { kind: 'refuse', reason: 'unavailable' };
      const user = await createUser(
        prisma,
        {
          data: {
            email: identity.email!,
            // No password door: the account is reached through its identities
            // (and can set a password through "forgot password" later).
            password: '!social-no-login',
            fullName: identity.name?.slice(0, 191) || identity.email!,
            role: 'MENTEE',
            orgId,
            emailVerified: true, // the provider asserted it — only verified addresses get here
            isActive: !decision.pending,
            pendingApproval: decision.pending,
            skills: [],
          },
          select: { id: true },
        },
        { source: 'social' },
      );
      await link(provider, identity, user.id, 'new account');
      return decision.pending ? { kind: 'pending' } : { kind: 'sign_in', userId: user.id };
    }
  }
}

/** An account's password is usable when it is a bcrypt hash (the sentinels start with "!"). */
export function hasUsablePassword(password: string | null | undefined): boolean {
  return typeof password === 'string' && password.startsWith('$2');
}

/** What the sign-in and register screens may draw on this host: id + label only, never a secret. */
export function socialButtonsForHeaders(get: (name: string) => string | null): { id: SocialProvider; label: string }[] {
  if (worldForHeaders(get) !== 'INTERNSHIP') return [];
  return enabledSocialProviders().map((p) => ({ id: p.id, label: p.label }));
}
