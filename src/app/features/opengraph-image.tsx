import { OG_CONTENT_TYPE, OG_SIZE, pageCard } from '@/lib/ogCard';

// Share card for /features (#1378) — the page's own title and subtitle.
export const runtime = 'nodejs';
export const alt = 'Features';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpengraphImage() {
  return pageCard((t) => ({ title: t.featureCatalog.title, subtitle: t.featureCatalog.subtitle }));
}
