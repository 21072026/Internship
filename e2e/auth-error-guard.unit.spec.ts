import { test, expect } from '@playwright/test';
import CredentialsProvider from 'next-auth/providers/credentials';
import type { NextAuthOptions } from 'next-auth';
import { guardProviders } from '@/lib/authGuard';
import { AUTH_SERVICE_UNAVAILABLE, AUTH_UNEXPECTED_ERROR } from '@/lib/authErrors';

// NextAuth's parseProviders() merges a provider's `options` bag back OVER the
// provider object before calling authorize(). CredentialsProvider keeps the
// caller's real authorize() in exactly that bag (its top-level one is a stub
// returning null), so this merge decides which function actually runs — and a
// guard applied only to the top level is silently discarded by it. That is what
// let a raw
//   Invalid `prisma.user.findUnique()` invocation: Can't reach database server
//   at `localhost:3306`
// onto the login form while MySQL was down, even though #1150 had "fixed" it.
// Reproduce the merge here so the guard is tested through the same path.
const effectiveAuthorize = (provider: unknown) => {
  const p = provider as { authorize?: unknown; options?: Record<string, unknown> };
  const merged = { ...p, ...(p.options ?? {}) } as {
    authorize: (credentials: unknown, req: unknown) => Promise<unknown>;
  };
  return () => merged.authorize({}, {});
};

// The provider's own signature wants `Awaitable<User | null>`; these stubs
// exist to throw, so they are cast to it rather than pretending to return one.
type ProviderAuthorize = NonNullable<Parameters<typeof CredentialsProvider>[0]['authorize']>;

const guardOne = (authorize: () => Promise<unknown>) =>
  effectiveAuthorize(
    guardProviders([
      CredentialsProvider({
        id: 'test',
        name: 'test',
        credentials: {},
        authorize: authorize as unknown as ProviderAuthorize,
      }),
    ] as NextAuthOptions['providers'])[0]
  );

const prismaUnreachable = () =>
  Object.assign(
    new Error(
      "Invalid `prisma.user.findUnique()` invocation: Can't reach database server at `localhost:3306`"
    ),
    { name: 'PrismaClientInitializationError', errorCode: 'P1001' }
  );

test('an unreachable database never reaches the browser verbatim', async () => {
  const run = guardOne(async () => {
    throw prismaUnreachable();
  });
  const error = await run().catch((e: Error) => e);
  expect((error as Error).message).toBe(AUTH_SERVICE_UNAVAILABLE);
  expect((error as Error).message).not.toContain('prisma');
  expect((error as Error).message).not.toContain('3306');
});

test('a pool timeout is reported as unavailable, not as a generic fault', async () => {
  const run = guardOne(async () => {
    throw Object.assign(new Error('Timed out fetching a new connection from the connection pool'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2024',
    });
  });
  await expect(run()).rejects.toThrow(AUTH_SERVICE_UNAVAILABLE);
});

test('any other internal fault becomes the stable unexpected code', async () => {
  const run = guardOne(async () => {
    throw new Error('Unexpected end of JSON input');
  });
  await expect(run()).rejects.toThrow(AUTH_UNEXPECTED_ERROR);
});

test('deliberate sign-in errors still pass through unchanged', async () => {
  for (const message of ['Invalid email or password', '2FA_REQUIRED', 'EMAIL_NOT_VERIFIED']) {
    const run = guardOne(async () => {
      throw new Error(message);
    });
    await expect(run()).rejects.toThrow(message);
  }
});

test('a successful authorize is passed through untouched', async () => {
  const user = { id: 'u1', email: 'someone@example.com' };
  const run = guardOne(async () => user);
  expect(await run()).toEqual(user);
});
