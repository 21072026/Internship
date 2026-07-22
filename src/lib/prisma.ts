import { PrismaClient } from '@prisma/client';

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
