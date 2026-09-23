import { notFound } from 'next/navigation';
import { resolveRequestVertical } from '@/i18n/server';

/**
 * A public page that describes ONE product, refusing to serve any other.
 *
 * WHY THIS IS A 404 AND NOT AN OVERLAY. The terminology overlay
 * (src/i18n/verticalOverlays.ts) replaces a word: "candidate" becomes "lead".
 * That works where the sentence is the same sentence in both products. It does
 * not work for a page whose entire CONTENT belongs to one product — the
 * internship feature catalogue, a pricing model metered in matched
 * mentor/mentee pairs, a landing page about placing interns at companies, the
 * internship changelog. Renaming the nouns there would produce fluent copy
 * about a product the visitor did not come for, which is worse than not
 * serving the page: it reads as if we do not know what we sell.
 *
 * Measured on a marketing host before this existed: `/features` opened with
 * "InternshipCRM neler yapabilir" and listed self-service mentee applications
 * and weekly internship reports; `/pricing` had "Fiyatlandırma — InternshipCRM"
 * in the tab title; `/release-notes` carried 202 lines of the other product's
 * changelog.
 *
 * The signal is `resolveRequestVertical()`, not the host alone: a signed-in
 * marketing tenant browsing the internship host has no more business reading
 * the internship catalogue than a signed-out visitor on the marketing one.
 *
 * `notFound()` rather than a redirect because the page genuinely does not
 * exist for this product — a redirect would claim we moved it somewhere.
 * The nav entries are dropped in the same change (PublicShell's
 * `hideInternshipLinks`), so this is the direct-URL and crawler backstop, not
 * the only thing standing between a visitor and the wrong page.
 */
export async function internshipProductPage(): Promise<void> {
  if ((await resolveRequestVertical()) !== 'INTERNSHIP') notFound();
}
