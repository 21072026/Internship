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

        const failKey = `login-fail:${credentials.email.toLowerCase()}`;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
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

        // Unverified email is the most common lockout for self-registrations
        // (their verification link may have expired). Surface a distinct error
        // so the sign-in page can offer to resend the link — do NOT call this
        // "deactivated", which misleads a never-activated user.
        if (!user.emailVerified) {
          throw new Error('EMAIL_NOT_VERIFIED');
        }

        if (!user.isActive) {
          // Covers both self-registrations awaiting admin approval and accounts
          // an admin has deactivated — either way it's an admin action.
          throw new Error('Your account is not active yet. If you just verified your email, an administrator needs to approve it; otherwise please contact an administrator.');
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
          impersonatorId: isStart ? grant.adminId : undefined,
          impersonatorName: isStart ? admin?.fullName ?? 'Admin' : undefined,
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
        // Set when starting impersonation, absent on a normal/stop sign-in —
        // so this also clears it when returning to the original account.
        const u = user as unknown as { impersonatorId?: string; impersonatorName?: string };
        token.impersonatorId = u.impersonatorId ?? null;
        token.impersonatorName = u.impersonatorName ?? null;
        // Cap impersonation sessions; after this they auto-revert to the admin.
        token.impersonationExpiresAt = u.impersonatorId ? Date.now() + 30 * 60 * 1000 : null;
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
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.emailVerified = token.emailVerified as boolean;
        session.user.impersonatorId = (token.impersonatorId as string) ?? null;
        session.user.impersonatorName = (token.impersonatorName as string) ?? null;
        session.user.companyId = (token.companyId as string) ?? null;
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
    };
  }
}
