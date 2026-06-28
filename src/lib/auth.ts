import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { getToken } from 'next-auth/jwt';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import type { NextApiRequest } from 'next';

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
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Email and password are required');
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user) {
          throw new Error('No account found with this email');
        }

        const isPasswordValid = await bcrypt.compare(credentials.password, user.password);

        if (!isPasswordValid) {
          throw new Error('Invalid password');
        }

        if (!user.isActive) {
          throw new Error('This account has been deactivated. Please contact an administrator.');
        }

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          role: user.role,
          emailVerified: user.emailVerified,
        };
      },
    }),
    // Admin "login as" — start impersonating another user. The current session
    // must be an ADMIN (verified from the signed JWT, never trusting the client).
    CredentialsProvider({
      id: 'impersonate',
      name: 'impersonate',
      credentials: { targetUserId: { label: 'targetUserId', type: 'text' } },
      async authorize(credentials, req) {
        const targetUserId = credentials?.targetUserId;
        if (!targetUserId) throw new Error('targetUserId is required');

        const token = await getToken({
          req: req as unknown as NextApiRequest,
          secret: process.env.NEXTAUTH_SECRET,
        });
        if (!token || token.role !== 'ADMIN') {
          throw new Error('Only admins can impersonate');
        }
        const adminId = token.id as string;

        const target = await prisma.user.findUnique({ where: { id: targetUserId } });
        if (!target) throw new Error('Target user not found');

        const admin = await prisma.user.findUnique({ where: { id: adminId } });
        await prisma.auditLog.create({
          data: { actorId: adminId, action: 'IMPERSONATE_START', targetId: target.id },
        });

        return {
          id: target.id,
          email: target.email,
          name: target.fullName,
          role: target.role,
          emailVerified: target.emailVerified,
          impersonatorId: adminId,
          impersonatorName: admin?.fullName ?? 'Admin',
        };
      },
    }),
    // Return from an impersonated session back to the original admin. Allowed
    // only when the signed JWT carries an impersonatorId (so it can't be forged).
    CredentialsProvider({
      id: 'stop-impersonate',
      name: 'stop-impersonate',
      credentials: {},
      async authorize(_credentials, req) {
        const token = await getToken({
          req: req as unknown as NextApiRequest,
          secret: process.env.NEXTAUTH_SECRET,
        });
        const impersonatorId = token?.impersonatorId as string | undefined;
        if (!impersonatorId) throw new Error('Not impersonating');

        const admin = await prisma.user.findUnique({ where: { id: impersonatorId } });
        if (!admin) throw new Error('Original account not found');

        await prisma.auditLog.create({
          data: { actorId: admin.id, action: 'IMPERSONATE_STOP', targetId: (token?.id as string) ?? null },
        });

        return {
          id: admin.id,
          email: admin.email,
          name: admin.fullName,
          role: admin.role,
          emailVerified: admin.emailVerified,
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
        // Set when starting impersonation, absent on a normal/stop sign-in —
        // so this also clears it when returning to the original account.
        const u = user as unknown as { impersonatorId?: string; impersonatorName?: string };
        token.impersonatorId = u.impersonatorId ?? null;
        token.impersonatorName = u.impersonatorName ?? null;
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
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.emailVerified = token.emailVerified as boolean;
        session.user.impersonatorName = (token.impersonatorName as string) ?? null;
        if (token.email) session.user.email = token.email as string;
        if (token.name) session.user.name = token.name as string;
      }
      return session;
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
      impersonatorName?: string | null;
    };
  }
}
