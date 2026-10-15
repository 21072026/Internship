// The dictionary an e-mail is written from (#2558, mechanism decision on #2394).
//
// A page reads its copy through getServerDictionary(), which overlays the
// signed-in user's vertical onto the base dictionary. An e-mail has no request
// to read that from — it is often sent from a cron — so it resolves the
// vertical from the RECIPIENT'S org instead, and then does exactly what the
// page does: applyVerticalOverlay(getDictionary(locale), locale, vertical).
// One overlay, two entry points; there is no second terminology layer for
// mail. A later per-tenant token layer (#1627) plugs in here, on top of the
// same call, rather than opening another resolution path.
//
// The org is ALWAYS explicit (the contract in src/lib/verticalContext.ts): a
// sender that has no orgId gets the default vertical, i.e. today's copy.
//
// The overlay's `{product}` (#2936) is the recipient organization's product
// name — its brand name, else its vertical's default — read with the same
// org lookup (src/lib/orgBrand.ts), so a mail names the product the recipient
// signs in to.

import type { Locale } from './config';
import { getDictionary } from './dictionaries';
import { applyVerticalOverlay } from './verticalOverlays';
import { defaultBrand, orgProduct } from '@/lib/orgBrand';
import { DEFAULT_VERTICAL, type VerticalKey } from '@/lib/verticals';

/**
 * The pure half: a locale + vertical → the overlaid dictionary. `product` fills
 * the overlay's `{product}`; omitted, it is the vertical's default name.
 */
export function dictionaryFor(locale: Locale, vertical: VerticalKey | null | undefined, product?: string) {
  return applyVerticalOverlay(getDictionary(locale), locale, vertical, {
    product: product ?? defaultBrand(vertical ?? DEFAULT_VERTICAL).productName,
  });
}

/** The dictionary for one e-mail to someone in `orgId`. One indexed lookup (plus the cached brand row). */
export async function emailDictionary(locale: Locale, orgId: string | null | undefined) {
  const { vertical, product } = await orgProduct(orgId);
  return dictionaryFor(locale, vertical, product);
}

/**
 * The same, for a sweep that mails many people: one vertical lookup per org
 * for the lifetime of the returned function, not one per recipient. A sweep
 * is one tick, so a vertical changed mid-tick is picked up on the next one.
 */
export function emailDictionaryMemo(): (locale: Locale, orgId: string | null | undefined) => Promise<ReturnType<typeof dictionaryFor>> {
  const orgs = new Map<string, ReturnType<typeof orgProduct>>();
  return async (locale, orgId) => {
    if (!orgId) return dictionaryFor(locale, DEFAULT_VERTICAL);
    let v = orgs.get(orgId);
    if (!v) {
      v = orgProduct(orgId);
      orgs.set(orgId, v);
      // A failed lookup is not remembered: the next recipient asks again.
      v.catch(() => orgs.delete(orgId));
    }
    const { vertical, product } = await v;
    return dictionaryFor(locale, vertical, product);
  };
}
