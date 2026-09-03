// RSS 2.0 feed for /release-notes (#1383). The public "what's new" page is a
// content asset — the product ships often and the landing uses that as proof —
// but until now the only way to follow it was to open the page by hand. A feed
// lets an interested reader subscribe without an account, and lets a release
// be piped somewhere else (Slack/Discord webhook, auto-posting) for free.
//
// Pure + string-returning on purpose: the same data the page renders
// (getAllReleaseNotes(), i.e. releaseNotes.ts plus the pending fragments
// inlined at build time) goes through here, so the feed can never drift from
// the page, and the document is verifiable without a server.

import { defaultLocale, type Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { getAllReleaseNotes, type ReleaseNote } from '@/lib/releaseNotes';

/** Where the feed is served — one constant, so the route, the page's
 *  `rel="alternate"` metadata and the visible link cannot disagree. */
export const RELEASE_FEED_PATH = '/release-notes/feed.xml';

/** A feed is a subscription, not an archive: readers only ever show the recent
 *  entries, and the full history is 200+ releases of XML nobody reads. */
const MAX_ITEMS = 50;

/**
 * The origin absolute links are built from. Same precedence as
 * `appBase()` in lib/ssoSaml.ts — configured value first, never a hardcoded
 * domain — with the request's own origin as a last resort so a deployment that
 * sets neither still emits working links instead of localhost ones.
 */
export function publicOrigin(requestUrl?: string): string {
  const configured = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, '');
  if (requestUrl) {
    try {
      return new URL(requestUrl).origin;
    } catch {
      // fall through to the local default
    }
  }
  return 'http://localhost:3000';
}

/** The feed URL for one locale. `en` is the default, so it carries no query. */
export function releaseFeedUrl(origin: string, locale: Locale = defaultLocale): string {
  return locale === defaultLocale
    ? `${origin}${RELEASE_FEED_PATH}`
    : `${origin}${RELEASE_FEED_PATH}?lang=${locale}`;
}

// Every interpolated value goes through this. Release notes are user-facing
// prose that may contain `&`, quotes or markdown, and a raw `&` alone is enough
// to make the document unparseable — which is exactly the failure a reader
// reports as "your feed is broken". Deliberately NOT CDATA: a CDATA section is
// itself escaping that breaks on a literal `]]>`, so there is nothing to gain.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The highlights as an HTML fragment, then escaped once more as XML text —
 *  the standard way to carry markup in `<description>` without a CDATA block. */
function descriptionHtml(highlights: string[]): string {
  const items = highlights.map((h) => `<li>${escapeXml(h)}</li>`).join('');
  return escapeXml(`<ul>${items}</ul>`);
}

/** RFC 822 date, which is what RSS 2.0 wants. `''` when the release carries no
 *  usable stamp (an uncommitted fragment has no merge date yet) — the item then
 *  simply ships without a pubDate rather than with a made-up one. */
function rfc822(note: ReleaseNote): string {
  if (!note.date) return '';
  const at = new Date(`${note.date}T${note.time || '00:00'}:00Z`);
  return Number.isNaN(at.getTime()) ? '' : at.toUTCString();
}

/** A GUID that survives a move to another domain and a re-render of the page:
 *  the version identifies the release, and one fragment = one release (#1457),
 *  so it is unique and stable. `isPermaLink="false"` says it is not a URL. */
function guid(note: ReleaseNote): string {
  return `urn:internship-crm:release:${note.version}`;
}

export function releaseFeedXml({ origin, locale }: { origin: string; locale: Locale }): string {
  const t = getDictionary(locale);
  const notes = getAllReleaseNotes().slice(0, MAX_ITEMS);
  const pageUrl = `${origin}/release-notes`;
  const selfUrl = releaseFeedUrl(origin, locale);

  const items = notes.map((note) => {
    const highlights = note.highlights[locale] ?? note.highlights[defaultLocale] ?? [];
    // The version alone is a poor headline in a reader or a chat webhook, so
    // the first highlight rides along; the full list stays in the description.
    const title = highlights[0] ? `v${note.version} — ${highlights[0]}` : `v${note.version}`;
    const published = rfc822(note);
    return [
      '    <item>',
      `      <title>${escapeXml(title)}</title>`,
      `      <link>${escapeXml(`${pageUrl}#v${note.version}`)}</link>`,
      `      <guid isPermaLink="false">${escapeXml(guid(note))}</guid>`,
      published ? `      <pubDate>${escapeXml(published)}</pubDate>` : null,
      `      <description>${descriptionHtml(highlights)}</description>`,
      '    </item>',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  });

  // lastBuildDate is the newest release, not "now": the feed is a pure function
  // of the release data, so a clock-based value would only defeat caching.
  const lastBuild = notes.map(rfc822).find(Boolean);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(`Internship CRM — ${t.releaseNotes.title}`)}</title>
    <link>${escapeXml(pageUrl)}</link>
    <description>${escapeXml(t.releaseNotes.feedDescription)}</description>
    <language>${escapeXml(locale)}</language>${lastBuild ? `\n    <lastBuildDate>${escapeXml(lastBuild)}</lastBuildDate>` : ''}
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
${items.join('\n')}
  </channel>
</rss>
`;
}
