// Server-side PAGE gate for vertical capabilities (#2351 follow-up).
//
// A capability-tagged destination in src/lib/navLinks.ts is hidden from the
// sidebar of a vertical that lacks it; this makes its URL answer 404 as well, so
// a MARKETING admin typing /admin/newsletters gets notFound() rather than an
// internship screen whose APIs then refuse. The API handlers carry their own
// requireCapability() — this gate is the page half, never a substitute for it.
//
// WHY A SEGMENT LAYOUT, NOT THE ROOT ADMIN LAYOUT. An App Router layout has no
// pathname, and a shared layout is NOT re-rendered on a client-side navigation
// between its children — a gate in src/app/admin/layout.tsx would only ever run
// on a hard load. Each gated segment therefore has a one-line layout.tsx that
// calls `gatePage('<its href>')`: a segment's own layout renders on every entry
// into that segment, soft navigation included. Which segments need one is
// derived from navLinks, and scripts/test/nav-route-capability.test.mjs fails
// when a tagged link has no gated layout.
//
// SERVER-ONLY (session + Prisma via shellCapabilities).

import { getServerSession } from 'next-auth';
import { notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { ADMIN_NAV_LINKS, MENTOR_NAV_LINKS, PORTAL_NAV_LINKS } from '@/lib/navLinks';
import { capabilityForPath } from '@/lib/navRouteCapability';

const ALL_LINKS = [...ADMIN_NAV_LINKS, ...MENTOR_NAV_LINKS, ...PORTAL_NAV_LINKS];

/**
 * notFound() when the signed-in user's vertical lacks the capability the nav
 * tags `href` with. No session → returns (the parent layout redirects to sign-in).
 */
export async function gatePage(href: string): Promise<void> {
  const needed = capabilityForPath(ALL_LINKS, href);
  if (!needed) return;
  const session = await getServerSession(authOptions);
  if (!session) return;
  const caps = await shellCapabilities(session.user.orgId);
  if (!caps.includes(needed)) notFound();
}
