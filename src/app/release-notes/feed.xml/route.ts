import { NextResponse } from 'next/server';
import { defaultLocale, isLocale } from '@/i18n/config';
import { publicOrigin, releaseFeedXml } from '@/lib/releaseFeed';

// GET /release-notes/feed.xml — the public "what's new" page as an RSS 2.0 feed
// (#1383), so releases can be followed without an account and piped somewhere
// else (Slack/Discord webhook, auto-posting). Served next to the page rather
// than under /api, so the feed URL is the one a reader would guess.
//
// Localized by query parameter (`?lang=tr`, `?lang=de`, default `en`) instead
// of the locale cookie: a feed reader sends no cookies, so the language has to
// live in the URL it subscribed to.
//
// Deliberately NOT rate-limited, unlike the other anonymous endpoints: this
// handler touches no database and no session — it renders build-time data — and
// polling on a schedule is exactly what a feed reader is supposed to do. The
// s-maxage/stale-while-revalidate pair is the protection that fits.
export async function GET(request: Request) {
  const lang = new URL(request.url).searchParams.get('lang');
  const locale = isLocale(lang) ? lang : defaultLocale;

  return new NextResponse(releaseFeedXml({ origin: publicOrigin(request.url), locale }), {
    headers: {
      // The type the page's `rel="alternate"` link advertises. Readers and
      // browsers both accept it, and it stays parseable as plain XML.
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
    },
  });
}
