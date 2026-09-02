import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { rateLimit, clearRateLimit } from '@/lib/rateLimit';
import { verifyTotpStep } from '@/lib/totp';
import { headerSource, clientIp } from '@/lib/clientIp';
import { getActiveLockout, recordFailedAttempt, clearLockoutByEmail } from '@/lib/accountLockout';
import { logger } from '@/lib/logger';
import { AUTH_UNEXPECTED_ERROR } from '@/lib/authErrors';

// Exactly the columns the sign-in path needs — nothing else.
//
// This used to be an unqualified `findUnique({ where: { email } })`, which
// hydrates all ~60 columns of User, including its four `Json` ones (skills,
// languages, skillLevels, notificationPrefs). Prisma JSON.parse()s a Json
// column on read, so ONE row holding an invalid value ('' instead of '[]')
// made the read throw "Unexpected end of JSON input" *before* the password was
// even compared — locking that account out of the product completely, with the
// raw parser message shown on the sign-in form (#1150).
//
// Authentication must not depend on columns it does not use: keep this list
// minimal, and never add a `Json` field to it.
const AUTH_USER_SELECT = {
  id: true,
  email: true,
  password: true,
  role: true,
  fullName: true,
  emailVerified: true,
  isActive: true,
  pendingApproval: true,
  companyId: true,
  orgId: true,
  twoFactorEnabled: true,
  twoFactorSecret: true,
  lastTotpStep: true,
} as const;

// The errors authorize() raises on purpose. Their text is contractual: the
// sign-in page keys off it to show the 2FA field, offer a resend link, or
// explain a pending review. Anything NOT in here is an internal fault and must
// never reach the browser verbatim — see toClientAuthError below.
const INTENTIONAL_AUTH_ERRORS = new Set([
  'Email and password are required',
  'Invalid email or password',
  'Invalid authenticator code',
  'Too many attempts. Please try again later.',
  'This account has been deactivated. Please contact an administrator.',
  'grant is required',
  'Invalid or expired grant',
  'Invalid or expired SSO grant',
  'Target user not found',
  'User not found',
  '2FA_REQUIRED',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_PENDING_APPROVAL',
]);

function toClientAuthError(error: unknown, provider: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (INTENTIONAL_AUTH_ERRORS.has(message)) return error instanceof Error ? error : new Error(message);
  logger.error('Unexpected error during sign-in', {
    detail: `provider=${provider} ${error instanceof Error ? error.stack || message : message}`,
  });
  return new Error(AUTH_UNEXPECTED_ERROR);
}

// NextAuth surfaces a thrown authorize() error's `.message` to the browser as
// ?error=<message>. Wrap every provider once, here, rather than adding a
// try/catch to each authorize(): an unexpected fault becomes a stable code and
// the real cause is logged server-side. Applies to providers added later too.
type AuthorizeFn = (...args: never[]) => Promise<unknown>;

function guardProviders(providers: NextAuthOptions['providers']): NextAuthOptions['providers'] {
  return providers.map((provider) => {
    const original = (provider as { authorize?: AuthorizeFn }).authorize;
    if (typeof original !== 'function') return provider;
    const id = (provider as { id?: string }).id ?? 'credentials';
    return {
      ...provider,
      authorize: async (...args: never[]) => {
        try {
          return await original(...args);
        } catch (error) {
          throw toClientAuthError(error, id);
        }
      },
    };
  }) as NextAuthOptions['providers'];
}

export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
    // Auth hardening: cap the session lifetime so a stolen/idle token can't live
    // forever. The token is silently refreshed (at most hourly) while in use, so
    // active users aren't logged out; an untouched session expires after 12h.
    maxAge: 12 * 60 * 60,
    updateAge: 60 * 60,
  },
  pages: {
    signIn: '/auth/signin',
  },
  providers: guardProviders([
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        totp: { label: 'Authenticator code', type: 'text' },
      },
      async authorize(credentials, req) {
        // NextAuth hands us a plain header bag, not a WHATWG Request; headerSource
        // adapts it so the audit rows carry the origin IP/user-agent (#881).
        const origin = headerSource(req?.headers as Record<string, string> | undefined);
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Email and password are required');
        }

        // Normalize (trim + lowercase) to match how emails are stored at
        // registration, so sign-in never misses on a casing/whitespace diff.
        const email = credentials.email.trim().toLowerCase();
        const failKey = `login-fail:${email}`;
        const ip = clientIp(origin);

        // Durable lockout gate (#1541), consulted BEFORE the bcrypt compare:
        // cost-12 hashing is the expensive half of a brute-force attempt, and
        // an already-locked address must not be allowed to buy one. Unlike the
        // in-process Map behind `rateLimit`, this survives a redeploy — and an
        // admin can see it and clear it.
        const lockedBefore = await getActiveLockout(email);
        if (lockedBefore) {
          await logActivity({
            action: 'auth.login_locked',
            level: 'warning',
            actorEmail: credentials.email,
            actorId: lockedBefore.userId,
            detail: `locked until ${lockedBefore.lockedUntil.toISOString()}`,
            request: origin,
          });
          throw new Error('Too many attempts. Please try again later.');
        }

        const user = await prisma.user.findUnique({
          where: { email },
          select: AUTH_USER_SELECT,
        });

        const isPasswordValid = user
          ? await bcrypt.compare(credentials.password, user.password)
          : false;

        // Generic error for both unknown email and wrong password so the
        // endpoint can't be used to discover which emails are registered.
        // Only FAILED attempts count toward the brute-force limit.
        if (!user || !isPasswordValid) {
          const within = rateLimit(failKey, { limit: 10, windowMs: 15 * 60 * 1000 });
          // Same policy, written down durably (#1541).
          const locked = await recordFailedAttempt({
            email,
            userId: user?.id ?? null,
            orgId: user?.orgId ?? null,
            reason: 'password',
            limit: 10,
            ip,
          });
          await logActivity({
            action: 'auth.login_failed',
            level: 'warning',
            actorEmail: credentials.email,
            actorId: user?.id ?? null,
            request: origin,
          });
          throw new Error(
            within.ok && !locked ? 'Invalid email or password' : 'Too many attempts. Please try again later.'
          );
        }

        // NOTE: the failure counter is NOT cleared here. It used to be, which
        // meant that once the password verified the 6-digit TOTP code below
        // could be guessed without limit — the whole 10^6 space, as fast as the
        // server would answer (#865). It is cleared only after the credential
        // check is *completely* through, at the bottom of this function.

        // Verified-but-inactive is NOT the same as never-activated. Only block
        // inactive accounts: an active-but-unverified user may still sign in
        // (read-only, nagged to verify — enforced by middleware). Among inactive
        // accounts, an unverified one is a never-activated self-registration
        // (its verification link may have expired) — surface EMAIL_NOT_VERIFIED
        // so the sign-in page can offer to resend, instead of the misleading
        // "deactivated". A verified-but-inactive account was deactivated by an
        // admin.
        if (!user.isActive) {
          if (!user.emailVerified) {
            throw new Error('EMAIL_NOT_VERIFIED');
          }
          // Verified but still waiting on a human (only possible while the
          // `selfRegistration` setting is 'manual', or after an admin turned
          // the account off). Say so instead of the dead-end "deactivated".
          if (user.pendingApproval) {
            throw new Error('ACCOUNT_PENDING_APPROVAL');
          }
          throw new Error('This account has been deactivated. Please contact an administrator.');
        }

        // Two-factor: when enabled, a valid TOTP code is required.
        if (user.twoFactorEnabled && user.twoFactorSecret) {
          const code = (credentials.totp || '').trim();
          if (!code) throw new Error('2FA_REQUIRED');

          // Its own bucket, separate from the password one: a legitimate user
          // fumbling their code shouldn't consume the password allowance, and
          // an attacker past the password shouldn't get a fresh one.
          const totpKey = `totp-fail:${email}`;
          const step = verifyTotpStep(user.twoFactorSecret, code);
          const replayed = step !== null && user.lastTotpStep !== null && step <= user.lastTotpStep;

          if (step === null || replayed) {
            const within = rateLimit(totpKey, { limit: 5, windowMs: 15 * 60 * 1000 });
            const locked = await recordFailedAttempt({
              email,
              userId: user.id,
              orgId: user.orgId,
              reason: 'totp',
              limit: 5,
              ip,
            });
            await logActivity({
              action: 'auth.totp_failed',
              level: 'warning',
              actorEmail: user.email,
              actorId: user.id,
              detail: replayed ? 'code already used' : 'invalid code',
              request: origin,
            });
            // Same message either way — which of the two it was is the
            // attacker's business to guess, not ours to confirm.
            throw new Error(
              within.ok && !locked ? 'Invalid authenticator code' : 'Too many attempts. Please try again later.'
            );
          }

          // Burn the step so the same code can't be used again inside the
          // ±1-step acceptance window.
          // `select` here is not cosmetic: an unqualified update() returns the
          // whole row, which would re-introduce the Json-column read that
          // AUTH_USER_SELECT exists to avoid.
          await prisma.user.update({
            where: { id: user.id },
            data: { lastTotpStep: step },
            select: { id: true },
          });
          clearRateLimit(totpKey);
        }

        // Fully authenticated — now the failure counter can be reset. Both
        // copies of it: the in-process one and the durable row (#1541).
        clearRateLimit(failKey);
        await clearLockoutByEmail(email);

        // Logged here rather than in events.signIn so the row carries the
        // origin IP; the event callback has no request (#881).
        await logActivity({
          action: 'auth.login',
          actorId: user.id,
          actorEmail: user.email,
          request: origin,
        });

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          role: user.role,
          emailVerified: user.emailVerified,
          companyId: user.companyId,
          orgId: user.orgId,
        };
      },
    }),
    // Impersonation sign-in. The caller's admin rights are checked in the
    // admin-guarded API route that mints the single-use grant; here we only
    // consume that grant, so there's no need to read the session cookie.
    // A START grant becomes the target (carrying impersonatorId); a STOP grant
    // returns to the admin (no impersonatorId).
    CredentialsProvider({
      id: 'impersonate',
      name: 'impersonate',
      credentials: { grant: { label: 'grant', type: 'text' } },
      async authorize(credentials) {
        const grantToken = credentials?.grant;
        if (!grantToken) throw new Error('grant is required');

        const grant = await prisma.impersonationGrant.findUnique({ where: { token: grantToken } });
        if (!grant || grant.used || grant.expiresAt < new Date()) {
          throw new Error('Invalid or expired grant');
        }
        await prisma.impersonationGrant.update({ where: { id: grant.id }, data: { used: true } });

        const user = await prisma.user.findUnique({
          where: { id: grant.targetId },
          select: AUTH_USER_SELECT,
        });
        if (!user) throw new Error('Target user not found');

        const isStart = grant.kind === 'START';
        const admin = isStart
          ? await prisma.user.findUnique({ where: { id: grant.adminId }, select: { fullName: true } })
          : null;

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          role: user.role,
          emailVerified: user.emailVerified,
          // Carry the impersonated user's company so the company portal (and any
          // companyId-scoped data) loads correctly while impersonating.
          companyId: user.companyId,
          orgId: user.orgId,
          impersonatorId: isStart ? grant.adminId : undefined,
          impersonatorName: isStart ? admin?.fullName ?? 'Admin' : undefined,
        };
      },
    }),
    // Enterprise SSO sign-in (#545). The SAML assertion is verified in the ACS
    // route, which mints a single-use SsoLoginGrant; here we only consume it and
    // issue the session — mirroring the impersonation grant flow. No password.
    CredentialsProvider({
      id: 'sso',
      name: 'sso',
      credentials: { grant: { label: 'grant', type: 'text' } },
      async authorize(credentials) {
        const token = credentials?.grant;
        if (!token) throw new Error('grant is required');

        const grant = await prisma.ssoLoginGrant.findUnique({ where: { token } });
        if (!grant || grant.used || grant.expiresAt < new Date()) {
          throw new Error('Invalid or expired SSO grant');
        }
        await prisma.ssoLoginGrant.update({ where: { id: grant.id }, data: { used: true } });

        const user = await prisma.user.findUnique({
          where: { id: grant.userId },
          select: AUTH_USER_SELECT,
        });
        if (!user) throw new Error('User not found');
        if (!user.isActive) {
          throw new Error('This account has been deactivated. Please contact an administrator.');
        }

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          role: user.role,
          emailVerified: user.emailVerified,
          companyId: user.companyId,
          orgId: user.orgId,
        };
      },
    }),
    // "Remember me" silent re-authentication (#1495). The device's long-lived
    // cookie is verified AND rotated by POST /api/auth/remember/refresh — a
    // provider cannot write the rotated cookie back, since it returns a user
    // rather than a response — which mints the single-use grant consumed here.
    // Same two-step shape as the SSO and impersonation providers, and for the
    // same reason: the session is always issued by the jwt callback below, so
    // there is exactly one place where a token's claims are decided.
    //
    // No password and no TOTP prompt: the rotating device credential IS the
    // proof, and it was issued to a browser that had already passed both. That
    // is the whole point of "remember this device" — and it stays revocable,
    // which a long-lived JWT would not be.
    CredentialsProvider({
      id: 'remember',
      name: 'remember',
      credentials: { grant: { label: 'grant', type: 'text' } },
      async authorize(credentials) {
        const token = credentials?.grant;
        if (!token) throw new Error('grant is required');

        const grant = await prisma.sessionRefreshGrant.findUnique({ where: { token } });
        if (!grant || grant.used || grant.expiresAt < new Date()) {
          throw new Error('Invalid or expired grant');
        }
        await prisma.sessionRefreshGrant.update({ where: { id: grant.id }, data: { used: true } });

        const user = await prisma.user.findUnique({
          where: { id: grant.userId },
          select: AUTH_USER_SELECT,
        });
        if (!user) throw new Error('User not found');
        // Re-checked here even though rotateTrustedDevice() just checked it:
        // the grant is a bearer token with a 60s life, and an account can be
        // deactivated inside it.
        if (!user.isActive) {
          throw new Error('This account has been deactivated. Please contact an administrator.');
        }

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          role: user.role,
          emailVerified: user.emailVerified,
          companyId: user.companyId,
          orgId: user.orgId,
        };
      },
    }),
  ]),
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.id = user.id;
        token.role = (user as unknown as { role: string }).role;
        token.emailVerified = (user as unknown as { emailVerified: boolean }).emailVerified;
        token.companyId = (user as unknown as { companyId?: string | null }).companyId ?? null;
        // Tenant the user belongs to (multi-tenancy, #543). Null until assigned.
        token.orgId = (user as unknown as { orgId?: string | null }).orgId ?? null;
        // Set when starting impersonation, absent on a normal/stop sign-in —
        // so this also clears it when returning to the original account.
        const u = user as unknown as { impersonatorId?: string; impersonatorName?: string };
        token.impersonatorId = u.impersonatorId ?? null;
        token.impersonatorName = u.impersonatorName ?? null;
        // Cap impersonation sessions; after this they auto-revert to the admin.
        token.impersonationExpiresAt = u.impersonatorId ? Date.now() + 30 * 60 * 1000 : null;
        // Millisecond mint time for "sign out of all devices" — finer than the
        // second-granular JWT `iat`, so a fresh login is never mistaken for a
        // pre-revocation token even within the same second.
        token.authTime = Date.now();
        // Stamp the last real sign-in (not impersonation) for activity reports.
        // Fire-and-forget so it never slows the login round-trip.
        if (!u.impersonatorId) {
          prisma.user
            .update({ where: { id: user.id }, data: { lastLoginAt: new Date() }, select: { id: true } })
            .catch(() => {});
        }
      }

      // Auto-expire impersonation: once the cap passes, rewrite the token back
      // to the original admin so elevated access can't linger indefinitely.
      if (token.impersonatorId && token.impersonationExpiresAt && Date.now() > (token.impersonationExpiresAt as number)) {
        const admin = await prisma.user.findUnique({
          where: { id: token.impersonatorId as string },
          select: AUTH_USER_SELECT,
        });
        if (admin) {
          token.id = admin.id;
          token.role = admin.role;
          token.email = admin.email;
          token.name = admin.fullName;
          token.companyId = admin.companyId;
          token.orgId = admin.orgId;
          token.emailVerified = admin.emailVerified;
        }
        token.impersonatorId = null;
        token.impersonatorName = null;
        token.impersonationExpiresAt = null;
      }
      // On a client-side session update() (e.g. after changing email/profile),
      // re-read the user so the token — and thus the UI that reads the session,
      // like the sidebar — reflects the latest values without a re-login.
      if (trigger === 'update' && token.id) {
        const fresh = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: AUTH_USER_SELECT,
        });
        if (fresh) {
          token.email = fresh.email;
          token.name = fresh.fullName;
          token.role = fresh.role;
          token.emailVerified = fresh.emailVerified;
          token.companyId = fresh.companyId;
          token.orgId = fresh.orgId;
        }
      }

      // Global sign-out ("all devices"): reject any token minted before the
      // account's sessionsValidFrom cutoff. Runs per request — one indexed point
      // lookup — so a revocation on one device logs the others out on their next
      // request, not just at token refresh. Uses the millisecond `authTime` we
      // stamp at sign-in (above) rather than the second-granular JWT `iat`, so a
      // fresh login is never mistaken for a pre-revocation token. Tokens minted
      // before this field existed (no authTime) are left alone.
      if (token.id && typeof token.authTime === 'number') {
        const acct = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { sessionsValidFrom: true },
        });
        if (acct?.sessionsValidFrom && token.authTime < acct.sessionsValidFrom.getTime()) {
          token.invalidated = true;
        }
      }
      return token;
    },
    async session({ session, token }) {
      // A token revoked by "sign out of all devices" yields no session, so
      // getServerSession()/useSession() treat the request as unauthenticated.
      if (token?.invalidated) return null as unknown as typeof session;
      if (token) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.emailVerified = token.emailVerified as boolean;
        session.user.impersonatorId = (token.impersonatorId as string) ?? null;
        session.user.impersonatorName = (token.impersonatorName as string) ?? null;
        session.user.companyId = (token.companyId as string) ?? null;
        session.user.orgId = (token.orgId as string) ?? null;
        if (token.email) session.user.email = token.email as string;
        if (token.name) session.user.name = token.name as string;
      }
      return session;
    },
  },
  events: {
    async signIn({ user, account }) {
      // The credentials provider logs its own `auth.login` from authorize(),
      // where the request headers are available and the row can carry an origin
      // IP (#881). Events get no request, so logging here too would only add a
      // duplicate with a blank origin.
      if (account?.provider === 'credentials') return;
      await logActivity({ action: 'auth.login', actorId: user.id, actorEmail: user.email ?? null });
    },
    // No Request is available in this callback, so sign-out rows carry no
    // origin. Left as-is deliberately: a sign-out is not the event an incident
    // review hinges on.
    async signOut({ token }) {
      await logActivity({
        action: 'auth.logout',
        actorId: (token?.id as string) ?? null,
        actorEmail: (token?.email as string) ?? null,
      });
    },
  },
};

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role: string;
      emailVerified?: boolean;
      impersonatorId?: string | null;
      impersonatorName?: string | null;
      companyId?: string | null;
      orgId?: string | null;
    };
  }
}
