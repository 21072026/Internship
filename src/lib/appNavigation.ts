import {
  ADMIN_NAV_LINKS,
  AFFILIATE_NAV_LINKS,
  MENTOR_NAV_LINKS,
  PORTAL_NAV_LINKS,
  SALES_NAV_LINKS,
  visibleNavLinks,
  type NavAudience,
  type NavLink,
} from '@/lib/navLinks';
import { hasSalesSurface } from '@/lib/salesSurface';
import type { VerticalCapability } from '@/lib/verticals';

/**
 * The sidebar a signed-in person sees on the web, for the native app (#2775).
 *
 * Inside the app the site's own top bar and drawer are hidden (they carry
 * `data-app-chrome`, see globals.css), so the app shows this menu natively
 * instead. It is the SAME list the web sidebar renders — navLinks.ts stays the
 * one source, filtered by the same vertical capabilities — so the app can never
 * offer a destination the web would not.
 *
 * The shell choice mirrors the layouts: ADMIN → admin sidebar; MENTOR → the
 * mentor sidebar, or the sales one where the vertical has no mentorship
 * (src/lib/salesSurface.ts); AFFILIATE → the partner menu, never the portal
 * (#3115); everyone else → the portal. Pure.
 */
export function appNavLinks(
  role: string | null | undefined,
  capabilities: readonly VerticalCapability[],
  opts: NavAudience = {},
): NavLink[] {
  const links =
    role === 'ADMIN'
      ? ADMIN_NAV_LINKS
      : role === 'MENTOR'
        ? hasSalesSurface(role, capabilities)
          ? SALES_NAV_LINKS
          : MENTOR_NAV_LINKS
        : role === 'AFFILIATE'
          ? AFFILIATE_NAV_LINKS
          : PORTAL_NAV_LINKS;
  return visibleNavLinks(links, capabilities, opts);
}
