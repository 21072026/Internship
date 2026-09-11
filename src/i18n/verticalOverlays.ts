// Per-vertical terminology overlays (#2354, epic #2348).
//
// coreCRM serves several products from one dictionary. A MARKETING tenant should
// not read "candidate" and "mentee" where it means "lead" — so a vertical may
// override individual dictionary strings through an overlay that is deep-merged
// onto the base translation.
//
// THE NO-OP RULE: INTERNSHIP overrides nothing. Its overlay is empty in every
// locale, so getDictionary(locale, 'INTERNSHIP') deep-merges nothing and returns
// output byte-identical to getDictionary(locale). Today every tenant is
// INTERNSHIP, so the whole overlay layer is invisible for the live product — and
// the many e2e specs that assert exact strings keep passing because they run on
// INTERNSHIP/default orgs.
//
// Overlays are PARTIAL and only ever REPLACE a leaf string that already exists;
// they never add keys (check-i18n enforces both — a typo'd overlay key that
// matches nothing is a silent no-op, so it is a build error instead). The set is
// intentionally small and grows as real marketing surfaces are dressed; it does
// not attempt to translate the whole 4800-key dictionary at once.

import type { Locale } from './config';
import type { Dictionary } from './dictionaries';
import type { VerticalKey } from '@/lib/verticals';

// The default vertical, inlined as a literal (not imported as a value) so this
// module has NO runtime imports and can therefore be loaded by the plain node
// runner that scripts/check-i18n.ts uses — which is what lets that guard
// validate the overlays. Kept in sync with DEFAULT_VERTICAL in src/lib/verticals.ts
// by the vertical-overlays unit spec, which imports both.
const DEFAULT_VERTICAL: VerticalKey = 'INTERNSHIP';

// A recursively-optional view of the dictionary: an overlay may carry any
// subtree down to a replaced leaf string, and nothing it omits.
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string ? T[K] : DeepPartial<T[K]>;
};

type LocaleOverlay = DeepPartial<Dictionary>;

// One entry per vertical. INTERNSHIP is present and empty ON PURPOSE — the
// emptiness is the no-op guarantee, and a test asserts it stays empty.
const OVERLAYS: Record<VerticalKey, Record<Locale, LocaleOverlay>> = {
  INTERNSHIP: { en: {}, tr: {}, de: {} },
  MARKETING: {
    en: {
      nav: { candidates: 'Leads' },
      candidates: { title: 'Leads', subtitle: 'Browse and search leads' },
    },
    tr: {
      nav: { candidates: 'Fırsatlar' },
      candidates: { title: 'Fırsatlar', subtitle: 'Fırsatları görüntüle ve ara' },
    },
    de: {
      nav: { candidates: 'Leads' },
      candidates: { title: 'Leads', subtitle: 'Leads durchsuchen' },
    },
  },
};

// Is there anything to merge for this vertical+locale? Lets the caller skip the
// merge (and return the base object unchanged) for the common empty case.
function hasOverlay(vertical: VerticalKey, locale: Locale): boolean {
  return Object.keys(OVERLAYS[vertical]?.[locale] ?? {}).length > 0;
}

// Deep-merge an overlay onto a base dictionary, returning a NEW object; the base
// is never mutated (it is shared module state for the process). Only plain
// objects recurse; every leaf (string, array, number) is replaced wholesale.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, overlay: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return (overlay as unknown as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v as DeepPartial<unknown>) : v;
  }
  return out as T;
}

// Apply a vertical's overlay to an already-resolved base dictionary. Returns the
// base unchanged when the vertical overrides nothing for this locale — so the
// INTERNSHIP path and every not-yet-dressed locale cost nothing and stay
// referentially identical.
export function applyVerticalOverlay<T extends object>(
  base: T,
  locale: Locale,
  vertical: VerticalKey | null | undefined,
): T {
  const v = vertical ?? DEFAULT_VERTICAL;
  if (v === DEFAULT_VERTICAL || !hasOverlay(v, locale)) return base;
  return deepMerge(base, OVERLAYS[v][locale] as DeepPartial<T>);
}

// Exposed for two guards. scripts/check-i18n.ts (node, at the PR gate) flattens
// these to assert every overlay key already exists in the base and that
// INTERNSHIP is empty. The compile-time half is stronger and needs nothing
// here: `LocaleOverlay = DeepPartial<Dictionary>` over `typeof en` makes a
// misspelled overlay key a TS excess-property error, caught by `tsc --noEmit`
// in CI — so a typo is a build failure, and check-i18n is defence-in-depth plus
// the one thing types cannot see (a valid override wrongly placed in the empty
// INTERNSHIP entry).
export function overlayEntries(): { vertical: VerticalKey; locale: Locale; overlay: LocaleOverlay }[] {
  const out: { vertical: VerticalKey; locale: Locale; overlay: LocaleOverlay }[] = [];
  for (const vertical of Object.keys(OVERLAYS) as VerticalKey[]) {
    for (const locale of Object.keys(OVERLAYS[vertical]) as Locale[]) {
      out.push({ vertical, locale, overlay: OVERLAYS[vertical][locale] });
    }
  }
  return out;
}
