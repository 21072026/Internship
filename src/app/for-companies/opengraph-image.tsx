import { OG_CONTENT_TYPE, OG_SIZE, pageCard, renderCard } from '@/lib/ogCard';
import { requestVerticalHas } from '@/lib/verticalPage';

// Share card for /for-companies (#1378) — the page's own title and subtitle.
export const runtime = 'nodejs';
export const alt = 'For companies';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// The page is `placements`-only (page.tsx); elsewhere the card carries no copy.
export default async function OpengraphImage() {
  if (!(await requestVerticalHas('placements'))) return renderCard(null);
  return pageCard((t) => ({ title: t.landing.audCompanyTitle, subtitle: t.landing.audCompanySubtitle }));
}
