import { NextResponse } from 'next/server';
import { listPublishedStories } from '@/lib/testimonials';

// Public, session-less story feed (#1100). Every returned record has passed
// four server-side gates (published + shared + author consent + subject
// consent — all re-checked on this very request, so a revoked consent drops
// the story immediately). The response never carries scores, the original
// comment, or any contact field — only the approved excerpt, a display name
// formatted per the author's own preference, their role and the date.
export async function GET() {
  const stories = await listPublishedStories();
  return NextResponse.json(
    { stories },
    { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60' } }
  );
}
