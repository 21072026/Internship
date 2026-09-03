import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/prisma';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import { getAllReleaseNotes } from '@/lib/releaseNotes';
import { listPublishedStories } from '@/lib/testimonials';
import { siteUrl } from '@/lib/siteUrl';

// /sitemap.xml (#1380). Most public pages are reachable only from the footer
// (components/landing/PublicFooter.tsx), so a crawler finding them was a matter
// of luck. This is the explicit list.
//
// Dynamic for two reasons: the `<loc>`s must be absolute and the origin is a
// runtime variable (lib/siteUrl.ts), and the project/story rows below are read
// per request — a prerendered sitemap would freeze whatever was public on the
// day of the build (and `next build` has no database at all).
export const dynamic = 'force-dynamic';

/**
 * What the static entries claim as their last change.
 *
 * These pages are code, not content: the landing copy, the feature catalogue
 * and the legal texts change only when a release ships, and in this repo every
 * merge deploys. So the newest release-notes date is the honest answer — and,
 * unlike `new Date()`, it does not tell a crawler that all fifteen pages
 * changed the instant it asked.
 */
const lastShipped = (): Date => {
  const date = getAllReleaseNotes()[0]?.date;
  const parsed = date ? new Date(`${date}T00:00:00.000Z`) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
};

/** Same page size app/stories/page.tsx asks for — see the call site below. */
const STORIES_PAGE_LIMIT = 50;

/**
 * Every route that renders for a signed-out visitor, with the two deliberate
 * omissions:
 *
 *  - `/p/<userId>` — a public profile is a share link the person chose to turn
 *    on; putting it in a search index is a separate consent question and is
 *    left to its own issue.
 *  - `/apply/<mentorId>` — the per-mentor application form is a link a mentor
 *    hands out, not a landing page, and it duplicates /apply-as-mentor's
 *    funnel.
 *
 * Authenticated areas are absent by construction, and robots.ts disallows them.
 */
const PUBLIC_ROUTES: readonly { path: string; priority: number; changeFrequency: 'daily' | 'weekly' | 'monthly' }[] = [
  { path: '/', priority: 1.0, changeFrequency: 'weekly' },
  { path: '/features', priority: 0.8, changeFrequency: 'weekly' },
  { path: '/for-companies', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/apply-as-mentor', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/mentors', priority: 0.7, changeFrequency: 'weekly' },
  { path: '/projects', priority: 0.7, changeFrequency: 'weekly' },
  { path: '/announcements', priority: 0.5, changeFrequency: 'daily' },
  { path: '/release-notes', priority: 0.5, changeFrequency: 'daily' },
  { path: '/code-of-conduct', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/contributor-terms', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/privacy', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/terms', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/imprint', priority: 0.3, changeFrequency: 'monthly' },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const shipped = lastShipped();

  const entries: MetadataRoute.Sitemap = PUBLIC_ROUTES.map((r) => ({
    url: `${base}${r.path}`,
    lastModified: shipped,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  // /demo exists only on the demo deployment — everywhere else it is a 404
  // (app/demo/page.tsx), and a sitemap that lists 404s is worse than a short
  // one. Note that the demo's own robots.txt closes the whole site, so this is
  // belt-and-braces rather than an invitation.
  if (IS_DEMO_MODE) {
    entries.push({
      url: `${base}/demo`,
      lastModified: shipped,
      changeFrequency: 'monthly',
      priority: 0.6,
    });
  }

  // The two database-backed public surfaces. A sitemap must not fail the whole
  // route because the database hiccuped — the static list above is still worth
  // serving — so a query error degrades to "no dynamic entries".
  try {
    // /stories 404s while nothing is published (a deliberate honesty rule, see
    // app/stories/page.tsx), so it is listed only once there is something on
    // it. Individual stories have no URL of their own; the page is the entry.
    //
    // Asked with the SAME limit the page uses, not `1`: listPublishedStories
    // applies `take` in SQL and *then* drops rows in JS (an interview
    // scorecard has no relation, an admin-authored evaluation has no
    // participant author — neither is ever a story). With `take: 1` a single
    // such row at the top of the list answers "no stories" while the page
    // renders content, and the sitemap would silently omit a live page.
    const stories = await listPublishedStories(STORIES_PAGE_LIMIT);
    if (stories.length > 0) {
      entries.push({
        url: `${base}/stories`,
        lastModified: new Date(stories[0].publishedAt),
        changeFrequency: 'monthly',
        priority: 0.7,
      });
    }

    // Showcase projects. `isPublic` is the opt-in the detail page checks, and
    // ACTIVE keeps drafts, cancelled and archived work out of the index even
    // though their pages would render.
    const projects = await prisma.project.findMany({
      where: { isPublic: true, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, updatedAt: true },
    });
    for (const p of projects) {
      entries.push({
        url: `${base}/projects/${p.id}`,
        lastModified: p.updatedAt,
        changeFrequency: 'monthly',
        priority: 0.5,
      });
    }
  } catch {
    // ignore — serve the static routes rather than a 500
  }

  return entries;
}
