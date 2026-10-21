// The MARKETING price list a public page shows (#2927) — the database half.
//
// The rule (shape, validation, fallback) is src/lib/marketingPriceListRule.ts.
// This file reads its one input: the `marketingPriceList` setting of the
// organization bound to the request's host (`Organization.publicHost`, exact
// match — the same lookup the landing's demo form uses, src/lib/publicHostOrg.ts).
//
// Only the host decides, never the session: /pricing and the landing are public
// pages, and what a host publishes must not change with who happens to be
// signed in while reading it.
//
// FAILS TO "NO LIST", never to an error page: no host, no bound org, a bound
// org of the other vertical, an unset or unparseable setting, or a database
// that cannot be reached all read as no list, and the page shows its neutral
// "contact us for pricing" state — except that an unreachable database first
// falls back to the last list this process read for the host (below). There is
// no built-in price list in the code.
// A stored value that does not parse is logged, so a broken row is visible
// rather than silently replaced.
//
// SERVER-ONLY (Prisma).

import { prisma } from '@/lib/prisma';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { hostnameOf } from '@/lib/hostVertical';
import { toVerticalKey } from '@/lib/verticals';
import { logger } from '@/lib/logger';
import { resolvePriceList, type ResolvedPriceList } from '@/lib/marketingPriceListRule';

// SERVE STALE ON ERROR: the last list a host resolved to, per process. A
// database blip then keeps showing that host's figures instead of flipping the
// page to "prices on request" for the length of the blip. Only a successful
// lookup writes it (a host that resolves to no list clears it), so it can never
// show a list the database no longer holds once the database answers again.
const LAST_GOOD_MAX = 200;
const lastGoodGlobal = globalThis as unknown as { __marketingPriceListLastGood?: Map<string, ResolvedPriceList> };
lastGoodGlobal.__marketingPriceListLastGood ??= new Map();
const lastGood = lastGoodGlobal.__marketingPriceListLastGood;

function rememberGood(host: string, resolved: ResolvedPriceList): void {
  if (!resolved.list) {
    lastGood.delete(host);
    return;
  }
  if (!lastGood.has(host) && lastGood.size >= LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value as string);
  lastGood.set(host, resolved);
}

export async function marketingPriceListForHost(hostHeader: string | null | undefined): Promise<ResolvedPriceList> {
  const host = hostnameOf(hostHeader);
  if (!host) return { source: 'none', list: null };
  let orgId: string | null = null;
  let raw = '';
  try {
    // `Organization` is not a tenant model, so this lookup is never rewritten
    // by the middleware; the exact-match `where` is the whole rule.
    const org = await prisma.organization.findUnique({ where: { publicHost: host }, select: { id: true, vertical: true } });
    if (org && toVerticalKey(org.vertical) === 'MARKETING') {
      orgId = org.id;
      raw = await resolveSettingRaw('marketingPriceList', { orgId: org.id });
    }
  } catch (error) {
    const stale = lastGood.get(host);
    logger.warning(stale ? 'marketing price list: lookup failed, showing the last list read' : 'marketing price list: lookup failed, showing no price list', {
      error: error instanceof Error ? error.message : String(error),
    });
    return stale ?? { source: 'none', list: null };
  }
  const resolved = resolvePriceList(raw);
  rememberGood(host, resolved);
  if (resolved.source === 'invalid') {
    logger.warning('marketing price list: the stored value does not parse, showing no price list', { orgId });
  }
  return resolved;
}
