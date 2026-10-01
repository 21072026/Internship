import { OG_CONTENT_TYPE, OG_SIZE, pageCard } from '@/lib/ogCard';

// Share card for the landing and every public page without a card of its own (#1378) — the page's own title and subtitle.
export const runtime = 'nodejs';
export const alt = 'Share card';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpengraphImage() {
  return pageCard((t) => ({ title: t.seo.homeTitle, subtitle: t.seo.homeDescription }));
}
