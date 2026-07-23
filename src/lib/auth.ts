import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { rateLimit, clearRateLimit } from '@/lib/rateLimit';
import { verifyTotp } from '@/lib/totp';

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
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        totp: { label: 'Authenticator code', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Email and password are required');
        }

        // Normalize (trim + lowercase) to match how emails are stored at
        // registration, so sign-in never misses on a casing/whitespace diff.
        const email = credentials.email.trim().toLowerCase();
        const failKey = `login-fail:${email}`;

        const user = await prisma.user.findUnique({
          where: { email },
        });

        const isPasswordValid = user
          ? await bcrypt.compare(credentials.password, user.password)
          : false;

        // Generic error for both unknown email and wrong password so the
        // endpoint can't be used to discover which emails are registered.
        // Only FAILED attempts count toward the brute-force limit.
        if (!user || !isPasswordValid) {
          const within = rateLimit(failKey, { limit: 10, windowMs: 15 * 60 * 1000 });
          await logActivity({
            action: 'auth.login_failed',
            level: 'warning',
            actorEmail: credentials.email,
            actorId: user?.id ?? null,
          });
          throw new Error(within.ok ? 'Invalid email or password' : 'Too many attempts. Please try again later.');
        }

        // Successful auth — reset the failure counter.
        clearRateLimit(failKey);

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
          throw new Error('This account has been deactivated. Please contact an administrator.');
        }

        // Two-factor: when enabled, a valid TOTP code is required.
        if (user.twoFactorEnabled && user.twoFactorSecret) {
          const code = (credentials.totp || '').trim();
          if (!code) throw new Error('2FA_REQUIRED');
          if (!verifyTotp(user.twoFactorSecret, code)) {
            throw new Error('Invalid authenticator code');
          }
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

        const user = await prisma.user.findUnique({ where: { id: grant.targetId } });
        if (!user) throw new Error('Target user not found');

        const isStart = grant.kind === 'START';
        const admin = isStart ? await prisma.user.findUnique({ where: { id: grant.adminId } }) : null;

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

        const user = await prisma.user.findUnique({ where: { id: grant.userId } });
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
  ],
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
          prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
        }
      }

      // Auto-expire impersonation: once the cap passes, rewrite the token back
      // to the original admin so elevated access can't linger indefinitely.
      if (token.impersonatorId && token.impersonationExpiresAt && Date.now() > (token.impersonationExpiresAt as number)) {
        const admin = await prisma.user.findUnique({ where: { id: token.impersonatorId as string } });
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
        const fresh = await prisma.user.findUnique({ where: { id: token.id as string } });
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
    async signIn({ user }) {
      await logActivity({ action: 'auth.login', actorId: user.id, actorEmail: user.email ?? null });
    },
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
