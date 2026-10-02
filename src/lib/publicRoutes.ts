import { DEFAULT_VERTICAL, verticalHasCapability, type VerticalCapability, type VerticalKey } from '@/lib/verticals';

// The public, signed-out pages of the site, one list for every machine-readable
// index of them: /sitemap.xml (app/sitemap.ts) and /llms.txt
// (app/llms.txt/route.ts). Two lists would drift — /trust, /ai and
// /accessibility were footer links on both hosts and in neither index.

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
export type RouteNeeds = VerticalCapability | 'default-vertical';

export const PUBLIC_ROUTES: readonly {
  path: string;
  /** One line for /llms.txt (English, product-neutral — the vertical filter decides who lists it). */
  llms: string;
  priority: number;
  changeFrequency: 'daily' | 'weekly' | 'monthly';
  needs?: RouteNeeds;
}[] = [
  { path: '/', llms: 'The home page: what the product is and who it is for', priority: 1.0, changeFrequency: 'weekly' },
  { path: '/features', llms: 'The full feature catalogue', priority: 0.8, changeFrequency: 'weekly' },
  { path: '/for-companies', llms: 'For companies that host interns: what they get and how to ask for a look', priority: 0.8, changeFrequency: 'monthly', needs: 'placements' },
  // The price is one of the two things a stranger searches for by name
  // (#1730), so it sits with /features rather than down among the legal
  // pages. `monthly` is honest: a published price list that changed weekly
  // would not be a published price list.
  { path: '/pricing', llms: 'Pricing: plans, how paying works, and free self-hosting under AGPL-3.0', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/apply-as-mentor', llms: 'Apply to mentor a student or graduate', priority: 0.8, changeFrequency: 'monthly', needs: 'mentorship' },
  { path: '/projects', llms: 'Public showcase of the projects interns work on', priority: 0.7, changeFrequency: 'weekly', needs: 'projects' },
  { path: '/release-notes', llms: 'What\'s new: every shipped release, dated', priority: 0.5, changeFrequency: 'daily', needs: 'default-vertical' },
  { path: '/code-of-conduct', llms: 'How everyone in the programme is expected to behave', priority: 0.3, changeFrequency: 'monthly', needs: 'mentorship' },
  { path: '/contributor-terms', llms: 'Terms for work contributed to projects on the platform', priority: 0.3, changeFrequency: 'monthly', needs: 'default-vertical' },
  { path: '/privacy', llms: 'Privacy policy (GDPR): what data is processed, why, for how long', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/terms', llms: 'Terms of use', priority: 0.3, changeFrequency: 'monthly' },
  // Footer-linked on both hosts but missing here until the site audit: the
  // trust page, the accessibility statement and the AI transparency page.
  { path: '/trust', llms: 'Trust centre: security controls, subprocessors and known limitations', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/ai', llms: 'How the product uses AI: what is sent to a model, what never is, how to switch it off', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/accessibility', llms: 'Accessibility statement: what is known not to work yet and how to report a barrier', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/imprint', llms: 'Imprint (legal notice, § 5 DDG)', priority: 0.3, changeFrequency: 'monthly' },
];

export function routeListedFor(vertical: VerticalKey, needs: RouteNeeds | undefined): boolean {
  if (!needs) return true;
  if (needs === 'default-vertical') return vertical === DEFAULT_VERTICAL;
  return verticalHasCapability(vertical, needs);
}
