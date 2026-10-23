import { OG_CONTENT_TYPE, OG_SIZE, pageCard, renderCard } from '@/lib/ogCard';
import { requestIsDefaultVertical } from '@/lib/verticalPage';

// Share card for /release-notes (#1378) — the page's own title and subtitle.
export const runtime = 'nodejs';
export const alt = 'Release notes';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// The page and its feed exist on the internship host only (page.tsx); elsewhere
// the card carries no copy.
export default async function OpengraphImage() {
  if (!(await requestIsDefaultVertical())) return renderCard(null);
  return pageCard((t) => ({ title: t.releaseNotes.title, subtitle: t.releaseNotes.feedDescription }));
}
