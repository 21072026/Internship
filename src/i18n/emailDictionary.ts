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

import type { Locale } from './config';
import { getDictionary } from './dictionaries';
import { applyVerticalOverlay } from './verticalOverlays';
import { verticalFor } from '@/lib/verticalContext';
import { DEFAULT_VERTICAL, type VerticalKey } from '@/lib/verticals';

/** The pure half: a locale + vertical → the overlaid dictionary. */
export function dictionaryFor(locale: Locale, vertical: VerticalKey | null | undefined) {
  return applyVerticalOverlay(getDictionary(locale), locale, vertical);
}

/** The dictionary for one e-mail to someone in `orgId`. One indexed lookup. */
export async function emailDictionary(locale: Locale, orgId: string | null | undefined) {
  return dictionaryFor(locale, orgId ? await verticalFor(orgId) : DEFAULT_VERTICAL);
}

/**
 * The same, for a sweep that mails many people: one vertical lookup per org
 * for the lifetime of the returned function, not one per recipient. A sweep
 * is one tick, so a vertical changed mid-tick is picked up on the next one.
 */
export function emailDictionaryMemo(): (locale: Locale, orgId: string | null | undefined) => Promise<ReturnType<typeof dictionaryFor>> {
  const verticals = new Map<string, Promise<VerticalKey>>();
  return async (locale, orgId) => {
    if (!orgId) return dictionaryFor(locale, DEFAULT_VERTICAL);
    let v = verticals.get(orgId);
    if (!v) {
      v = verticalFor(orgId);
      verticals.set(orgId, v);
      // A failed lookup is not remembered: the next recipient asks again.
      v.catch(() => verticals.delete(orgId));
    }
    return dictionaryFor(locale, await v);
  };
}
