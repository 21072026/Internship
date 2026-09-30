import { OG_CONTENT_TYPE, OG_SIZE, pageCard } from '@/lib/ogCard';

// Share card for /stories (#1378) — the page's own title and subtitle.
export const runtime = 'nodejs';
export const alt = 'Stories';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpengraphImage() {
  return pageCard((t) => ({ title: t.landing.stories.pageTitle, subtitle: t.landing.stories.pageSubtitle }));
}
