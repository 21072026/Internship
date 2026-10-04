import { NextResponse } from 'next/server';
import { defaultLocale, isLocale } from '@/i18n/config';
import { releaseNotesSlice } from '@/lib/releaseNotesPaging';
import { worldForHeaders } from '@/lib/hostWorld';
import { DEFAULT_VERTICAL } from '@/lib/verticals';

// GET /release-notes/entries?offset=20&limit=20&lang=tr[&until=0.12.0] — the
// next slice of the "what's new" page, fetched by its "Load more" button.
// Served next to the page (like feed.xml) and under the same rules: build-time
// data only, no database, no session, hence no rate limit; only the internship
// world has release notes, read from the host alone.
export async function GET(request: Request) {
  const vary = { Vary: 'X-Forwarded-Host, Host' };
  if (worldForHeaders((n) => request.headers.get(n)) !== DEFAULT_VERTICAL) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: vary });
  }
  const params = new URL(request.url).searchParams;
  const lang = params.get('lang');
  const num = (name: string) => {
    const raw = params.get(name);
    return raw === null ? undefined : Number(raw);
  };

  const slice = releaseNotesSlice({
    locale: isLocale(lang) ? lang : defaultLocale,
    offset: num('offset'),
    limit: num('limit'),
    until: params.get('until'),
  });
  return NextResponse.json(slice, {
    headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600', ...vary },
  });
}
