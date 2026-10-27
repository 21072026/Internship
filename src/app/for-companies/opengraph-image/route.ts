import { pageCard, renderCard } from '@/lib/ogCard';
import { requestVerticalHas } from '@/lib/verticalPage';

// Share card for /for-companies (#1378) — the page's own title and subtitle.
//
// A route handler, not the `opengraph-image.tsx` file convention, on purpose
// (#3059): Next injects a file-based card into the segment's metadata whatever
// generateMetadata() returns, so the page's 404 on a host whose product lacks
// `placements` still pointed scrapers at this card. Only page.tsx names it now
// (pageMetadata), and only where the page is served.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The page is `placements`-only (page.tsx); elsewhere the card carries no copy.
export async function GET() {
  if (!(await requestVerticalHas('placements'))) return renderCard(null);
  return pageCard((t) => ({ title: t.landing.audCompanyTitle, subtitle: t.landing.audCompanySubtitle }));
}
