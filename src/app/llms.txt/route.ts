import { getDictionary } from '@/i18n/dictionaries';
import { applyVerticalOverlay } from '@/i18n/verticalOverlays';
import { GITHUB_URL } from '@/components/landing/links';
import { hostVertical } from '@/lib/hostVertical';
import { PUBLIC_ROUTES, routeListedFor } from '@/lib/publicRoutes';
import { requestSiteUrl } from '@/lib/siteUrl';
import { productNameFor } from '@/lib/verticals';

// /llms.txt (https://llmstxt.org): a plain-markdown map of the public site for
// language-model agents — the same pages the sitemap lists, with one line each
// on what is there, so an assistant asked about the product reads our own
// pages instead of guessing from the landing's HTML.
//
// Per host, like the sitemap (#2495): the marketing host describes the
// marketing product and lists only the pages that host serves. English only —
// the format is read by machines and every page answers in the visitor's
// language at the same URL anyway.
//
// Dynamic for the same reasons as sitemap.ts: absolute links need the request
// origin, and the vertical follows the Host header.
export const dynamic = 'force-dynamic';

/** `/contributor-terms` → `Contributor terms`. */
function linkLabel(path: string): string {
  if (path === '/') return 'Home';
  const words = path.slice(1).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function GET(): Promise<Response> {
  const [base, vertical] = await Promise.all([requestSiteUrl(), hostVertical()]);
  const t = applyVerticalOverlay(getDictionary('en'), 'en', vertical);
  const product = productNameFor(vertical);

  const pages = PUBLIC_ROUTES.filter((r) => routeListedFor(vertical, r.needs)).map(
    (r) => `- [${linkLabel(r.path)}](${base}${r.path}): ${r.llms}`
  );

  const body = [
    `# ${product}`,
    '',
    `> ${t.seo.homeDescription}`,
    '',
    `${product} is open source (AGPL-3.0). Every page below answers in English, Turkish or German at the same URL, ` +
      'chosen by the visitor’s language setting. Everything behind sign-in is private and not described here.',
    '',
    '## Pages',
    '',
    ...pages,
    '',
    '## Optional',
    '',
    `- [Source code](${GITHUB_URL}): the full application, including its documentation under docs/`,
    `- [Sitemap](${base}/sitemap.xml): the same pages as XML, plus any public detail pages`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      // A map for agents, not a search result of its own.
      'x-robots-tag': 'noindex',
    },
  });
}
