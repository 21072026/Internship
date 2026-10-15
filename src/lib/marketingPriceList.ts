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
// FAILS TO THE BUILT-IN LIST, never to an error page: no host, no bound org, a
// bound org of the other vertical, an unset or unparseable setting, or a
// database that cannot be reached all read as the built-in list in
// src/lib/marketingPlans.ts — which is what every marketing host showed before
// the list became data. A stored value that does not parse is logged, so a
// broken row is visible rather than silently replaced.
//
// SERVER-ONLY (Prisma).

import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { hostnameOf } from '@/lib/hostVertical';
import { toVerticalKey } from '@/lib/verticals';
import { logger } from '@/lib/logger';
import {
  builtinPriceList,
  resolvePriceList,
  type PriceList,
  type PriceListSource,
} from '@/lib/marketingPriceListRule';

export async function marketingPriceListForHost(
  hostHeader: string | null | undefined,
): Promise<{ source: PriceListSource; list: PriceList }> {
  const host = hostnameOf(hostHeader);
  if (!host) return { source: 'builtin', list: builtinPriceList() };
  let orgId: string | null = null;
  let raw = '';
  try {
    // `Organization` is not a tenant model, so this lookup is never rewritten
    // by the middleware; the exact-match `where` is the whole rule.
    const org = await prisma.organization.findUnique({ where: { publicHost: host }, select: { id: true, vertical: true } });
    if (org && toVerticalKey(org.vertical) === 'MARKETING') {
      orgId = org.id;
      raw = await getSetting('marketingPriceList', org.id);
    }
  } catch (error) {
    logger.warning('marketing price list: lookup failed, showing the built-in list', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { source: 'builtin', list: builtinPriceList() };
  }
  const resolved = resolvePriceList(raw);
  if (resolved.source === 'invalid') {
    logger.warning('marketing price list: the stored value does not parse, showing the built-in list', { orgId });
  }
  return resolved;
}
