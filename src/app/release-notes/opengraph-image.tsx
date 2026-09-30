import { OG_CONTENT_TYPE, OG_SIZE, pageCard } from '@/lib/ogCard';

// Share card for /release-notes (#1378) — the page's own title and subtitle.
export const runtime = 'nodejs';
export const alt = 'Release notes';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpengraphImage() {
  return pageCard((t) => ({ title: t.releaseNotes.title, subtitle: t.releaseNotes.feedDescription }));
}
