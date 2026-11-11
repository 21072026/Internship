// The live figures on the public partner page (#3364). Server-only.
//
// ONE count, not two: the figures are the admin overview's own numbers
// (affiliateOverview(), src/lib/affiliateOverview.ts — active partners and the
// customers linked to them), so the page can never disagree with the admin
// screen. The page is public and signed out, so the counts are cached per
// organisation for STATS_TTL_MS (makeTtlCache): a stream of visitors costs one
// overview read an hour, not one per request. A failed read shows no live card
// (null), never an error page.
import { affiliateOverview } from '@/lib/affiliateOverview';
import { makeTtlCache } from '@/lib/affiliatePublicStatsCache';
import type { LiveStatCounts } from '@/lib/affiliateLandingRule';

export const STATS_TTL_MS = 60 * 60 * 1000;

// Pinned on globalThis: `next dev` gives each route its own module graph, and a
// per-module cache would be a second cache per route.
const g = globalThis as unknown as { __affiliatePublicStats?: ReturnType<typeof makeTtlCache<LiveStatCounts>> };
const cache = (g.__affiliatePublicStats ??= makeTtlCache<LiveStatCounts>(STATS_TTL_MS));

export function liveStatCounts(orgId: string): Promise<LiveStatCounts | null> {
  return cache.get(orgId, async () => {
    const overview = await affiliateOverview(orgId);
    return { activePartners: overview.partners.ACTIVE, customers: overview.customers };
  });
}
