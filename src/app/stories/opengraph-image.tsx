import { OG_CONTENT_TYPE, OG_SIZE, pageCard, renderCard } from '@/lib/ogCard';
import { requestVerticalHas } from '@/lib/verticalPage';

// Share card for /stories (#1378) — the page's own title and subtitle.
export const runtime = 'nodejs';
export const alt = 'Stories';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// The page is `mentorship`-only (page.tsx); elsewhere the card carries no copy.
export default async function OpengraphImage() {
  if (!(await requestVerticalHas('mentorship'))) return renderCard(null);
  return pageCard((t) => ({ title: t.landing.stories.pageTitle, subtitle: t.landing.stories.pageSubtitle }));
}
