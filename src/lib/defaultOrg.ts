import { prisma } from '@/lib/prisma';

// The organization the deploy-time backfill (prisma/seed.mjs) would assign.
// Registration uses this so no account is ever created org-less (#1272):
// fail-closed org scoping (#1227) 403s COMPANY reads in the window between
// registering and the next deploy's backfill. Same upsert as the seeder, so
// the two can never disagree about which org is "the default".
let cachedId: string | null = null;

export async function defaultOrgId(): Promise<string> {
  if (cachedId) return cachedId;
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  cachedId = org.id;
  return cachedId;
}
