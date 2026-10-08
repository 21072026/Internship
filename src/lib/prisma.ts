import { PrismaClient } from '@prisma/client';
import { observeQuery } from './dbQueryObserver';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  // Guards one-time registration of the tenant-isolation middleware (#543),
  // which lives in orgContext.ts (server-only — it imports node:async_hooks and
  // must never enter a client bundle). See orgContext.ensureTenantMiddleware().
  tenantMiddlewareInstalled: boolean | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Every operation is timed once, here, and handed to `observeQuery` — which logs
// the slow ones, counts it against the request in flight and (in the e2e server
// only) tallies it per model for the N+1 report (#1608). Model, action and
// duration only: the params carry personal data and never leave this callback.
// Registered FIRST, so the time includes every middleware after it (the tenant
// filter) — the cost the caller actually paid.
//
// The once-only guard lives ON THE CLIENT, not on globalThis: a dev-server
// re-evaluation reuses the client above and must not stack a second timer on
// it, while a second module instance that builds its own client must still get
// one — a global flag would leave that client unmeasured.
const OBSERVED = Symbol.for('internship.prisma.queryObserver');
const observable = prisma as PrismaClient & { [OBSERVED]?: true };
if (!observable[OBSERVED]) {
  observable[OBSERVED] = true;
  prisma.$use(async (params, next) => {
    const started = performance.now();
    try {
      return await next(params);
    } finally {
      observeQuery(params.model, params.action, performance.now() - started);
    }
  });
}
