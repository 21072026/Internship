import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/prisma';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import { getAllReleaseNotes } from '@/lib/releaseNotes';
import { listPublishedStories } from '@/lib/testimonials';
import { requestSiteUrl } from '@/lib/siteUrl';
import { hostVertical } from '@/lib/hostVertical';
import { DEFAULT_VERTICAL, verticalHasCapability, type VerticalCapability, type VerticalKey } from '@/lib/verticals';

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
 *  - `/mentors` — the mentor directory is part of the signed-in mentee↔mentor
 *    matching flow (#938); its layout redirects an anonymous visitor to
 *    `/auth/signin`, so it belongs with the other authenticated areas below,
 *    not here (e2e/robots-sitemap.spec.ts caught it answering 307).
 *  - `/announcements` — same defect, same fix: its layout redirects an
 *    anonymous visitor to `/auth/signin` (available to any signed-in role,
 *    not a public page), and the same e2e spec caught it once `/mentors` no
 *    longer masked it (the spec's resolve loop stops at its first failure).
 *
 * Authenticated areas are absent by construction, and robots.ts disallows them.
 */
/**
 * Which host lists a route (#2495). One container serves both products, and a
 * host must only advertise what it serves in ITS product: `needs` mirrors the
 * page's own guard (`requireVerticalCapability` / `requireDefaultVertical` in
 * src/lib/verticalPage.ts, or the capability check in the page itself), so the
 * marketing host's sitemap never lists a page that 404s there — or one that
 * renders but tells the other product's story (the mentorship code of conduct,
 * the mentee success stories). Absent = every vertical.
 */
type RouteNeeds = VerticalCapability | 'default-vertical';

const PUBLIC_ROUTES: readonly {
  path: string;
  priority: number;
  changeFrequency: 'daily' | 'weekly' | 'monthly';
  needs?: RouteNeeds;
}[] = [
  { path: '/', priority: 1.0, changeFrequency: 'weekly' },
  { path: '/features', priority: 0.8, changeFrequency: 'weekly' },
  { path: '/for-companies', priority: 0.8, changeFrequency: 'monthly', needs: 'placements' },
  // The price is one of the two things a stranger searches for by name
  // (#1730), so it sits with /features rather than down among the legal
  // pages. `monthly` is honest: a published price list that changed weekly
  // would not be a published price list.
  { path: '/pricing', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/apply-as-mentor', priority: 0.8, changeFrequency: 'monthly', needs: 'mentorship' },
  { path: '/projects', priority: 0.7, changeFrequency: 'weekly', needs: 'projects' },
  { path: '/release-notes', priority: 0.5, changeFrequency: 'daily', needs: 'default-vertical' },
  { path: '/code-of-conduct', priority: 0.3, changeFrequency: 'monthly', needs: 'mentorship' },
  { path: '/contributor-terms', priority: 0.3, changeFrequency: 'monthly', needs: 'default-vertical' },
  { path: '/privacy', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/terms', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/imprint', priority: 0.3, changeFrequency: 'monthly' },
];

function routeListedFor(vertical: VerticalKey, needs: RouteNeeds | undefined): boolean {
  if (!needs) return true;
  if (needs === 'default-vertical') return vertical === DEFAULT_VERTICAL;
  return verticalHasCapability(vertical, needs);
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await requestSiteUrl();
  const vertical = await hostVertical();
  const shipped = lastShipped();

  const entries: MetadataRoute.Sitemap = PUBLIC_ROUTES.filter((r) => routeListedFor(vertical, r.needs)).map((r) => ({
    url: `${base}${r.path}`,
    lastModified: shipped,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  // /demo exists only on the demo deployment — everywhere else it is a 404
  // (app/demo/page.tsx), and a sitemap that lists 404s is worse than a short
  // one. Note that the demo's own robots.txt closes the whole site, so this is
  // belt-and-braces rather than an invitation.
  if (IS_DEMO_MODE && vertical === DEFAULT_VERTICAL) {
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
    // Mentee success stories are the internship product's (#2495).
    const stories = routeListedFor(vertical, 'mentorship') ? await listPublishedStories(STORIES_PAGE_LIMIT) : [];
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
    const projects = !routeListedFor(vertical, 'projects') ? [] : await prisma.project.findMany({
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
