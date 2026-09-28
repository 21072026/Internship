import { notFound } from 'next/navigation';
import { resolveRequestVertical } from '@/i18n/server';
import { DEFAULT_VERTICAL, verticalHasCapability, type VerticalCapability } from '@/lib/verticals';

// Public pages that belong to ONE product, refusing to be served as another
// (#2544, epic #2348).
//
// The terminology overlay renames a word; it cannot rewrite a page whose whole
// CONTENT is one product's. Where a page can honestly be dressed per vertical,
// it is (/features filters its catalogue by capability, /pricing says the
// marketing price is not published yet — #2523). What is left here are the
// pages that cannot: fluent copy about a product the visitor did not come for
// is worse than no page, because it reads as if we do not know what we sell.
// Measured on the marketing host before this: /for-companies (9 visible lines
// about placing interns), /apply-as-mentor ("Kaç mentee ile ilgilenebilirsin?")
// and /release-notes (205 lines, most of them the internship changelog).
//
// Same shape as /projects, which already answers 404 when the vertical lacks
// the `projects` capability: the signal is `resolveRequestVertical()` (the
// signed-in org first, the request host second) and the answer is `notFound()`
// — not a redirect, which would claim the page moved somewhere. Gating by
// CAPABILITY rather than by vertical name means a vertical that later gains
// the module gets the page with no edit here.
//
// TRUST NOTE: this is the cosmetic use of the host signal hostVertical.ts
// permits — every page gated here is public on its own host anyway, so a forged
// X-Forwarded-Host reveals nothing. Never use it to guard non-public data.

/** 404 unless the requesting vertical carries `capability`. */
export async function requireVerticalCapability(capability: VerticalCapability): Promise<void> {
  if (!verticalHasCapability(await resolveRequestVertical(), capability)) notFound();
}

/**
 * 404 unless the requesting vertical is the default (internship) product.
 *
 * For the pages that are about the PRODUCT rather than a module — its
 * changelog, the contributor terms of the codebase it is named after — where
 * no capability says "this is ours". Prefer `requireVerticalCapability`
 * whenever a module is what the page is about.
 */
export async function requireDefaultVertical(): Promise<void> {
  if ((await resolveRequestVertical()) !== DEFAULT_VERTICAL) notFound();
}
