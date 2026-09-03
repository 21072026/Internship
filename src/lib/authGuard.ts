import type { NextAuthOptions } from 'next-auth';
import { logger } from '@/lib/logger';
import {
  AUTH_SERVICE_UNAVAILABLE,
  AUTH_UNEXPECTED_ERROR,
  INTENTIONAL_AUTH_ERRORS,
} from '@/lib/authErrors';

// The sign-in error boundary, kept apart from `@/lib/auth` so it can be unit
// tested without pulling Prisma (and the whole NextAuth config) into the test
// process. `@/lib/auth` wraps every provider with guardProviders() below.

// Prisma error codes that mean "the database is not answering", as opposed to
// "the query was wrong". P1xxx are connection/initialization faults (P1001 is
// the `Can't reach database server at …` the login form used to print verbatim
// when MySQL was OOM-killed); P2024 is the pool giving up while the server is
// overloaded.
const DB_UNAVAILABLE_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1010', 'P1011', 'P1017', 'P2024']);

export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code, errorCode } = error as { name?: string; code?: unknown; errorCode?: unknown };
  if (name === 'PrismaClientInitializationError' || name === 'PrismaClientRustPanicError') return true;
  for (const candidate of [code, errorCode]) {
    if (typeof candidate === 'string' && DB_UNAVAILABLE_CODES.has(candidate)) return true;
  }
  return false;
}

function toClientAuthError(error: unknown, provider: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (INTENTIONAL_AUTH_ERRORS.has(message)) return error instanceof Error ? error : new Error(message);
  const unavailable = isDatabaseUnavailable(error);
  logger.error(unavailable ? 'Database unavailable during sign-in' : 'Unexpected error during sign-in', {
    detail: `provider=${provider} ${error instanceof Error ? error.stack || message : message}`,
  });
  // Both are opaque to the browser; they differ only in the advice the sign-in
  // page gives ("try again shortly" vs. a generic failure).
  return new Error(unavailable ? AUTH_SERVICE_UNAVAILABLE : AUTH_UNEXPECTED_ERROR);
}

// NextAuth surfaces a thrown authorize() error's `.message` to the browser as
// ?error=<message>. Wrap every provider once, here, rather than adding a
// try/catch to each authorize(): an unexpected fault becomes a stable code and
// the real cause is logged server-side. Applies to providers added later too.
type AuthorizeFn = (...args: never[]) => Promise<unknown>;

type GuardableProvider = {
  id?: string;
  authorize?: AuthorizeFn;
  options?: { id?: string; authorize?: AuthorizeFn };
};

export function guardProviders(providers: NextAuthOptions['providers']): NextAuthOptions['providers'] {
  return providers.map((provider) => {
    const p = provider as GuardableProvider;
    const id = p.options?.id ?? p.id ?? 'credentials';
    const wrap =
      (original: AuthorizeFn): AuthorizeFn =>
      async (...args: never[]) => {
        try {
          return await original(...args);
        } catch (error) {
          throw toClientAuthError(error, id);
        }
      };

    const guarded: GuardableProvider = { ...p };
    if (typeof p.authorize === 'function') guarded.authorize = wrap(p.authorize);
    // CredentialsProvider({ … }) returns `{ authorize: () => null, options }`
    // and keeps the REAL authorize inside `options`; NextAuth's parseProviders
    // then merges `options` back OVER the provider. Wrapping only the top-level
    // authorize therefore wrapped a stub that never runs, and the real one was
    // reinstated unguarded by that merge — which is how a raw
    // `Invalid \`prisma.user.findUnique()\` invocation: Can't reach database
    // server at \`localhost:3306\`` reached the login form despite #1150.
    // Wrap both, so the guard survives the merge whichever one wins.
    if (typeof p.options?.authorize === 'function') {
      guarded.options = { ...p.options, authorize: wrap(p.options.authorize) };
    }
    return guarded;
  }) as NextAuthOptions['providers'];
}
