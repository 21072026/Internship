// Write-path capability gate (#2352, epic #2348).
//
// Hiding a module from the sidebar (#2351) is not access control — the route is
// still there, and a direct POST reaches it whatever the navigation shows. This
// is the actual gate: a mutating handler for a mentorship-specific module calls
// requireCapability() first, and a tenant whose vertical does not carry that
// module is refused before any write.
//
// The acting user's OWN org decides it (session.user.orgId): "may a user of this
// vertical use this module?" is a question about the actor, not about whatever
// row the request names. INTERNSHIP carries every capability, so this is a strict
// no-op for today's product — every existing handler behaves exactly as before.
//
// Fail-safe direction is DENY-open only for a missing org: verticalFor(null)
// resolves to INTERNSHIP (the full product), matching #2351's shell gate, so a
// not-yet-scoped account is never locked out of the module. A resolved MARKETING
// org, however, is refused.

import { NextResponse } from 'next/server';
import { shellCapabilities } from '@/lib/shellCapabilities';
import type { VerticalCapability } from '@/lib/verticals';

// Returns a 403 NextResponse when the org's vertical lacks the capability, or
// null when the write may proceed. The 403 carries the same machine-readable
// shape the plan gate uses (a `code` the UI can branch on) plus the capability
// name, so a caller never has to re-derive why it was refused.
export async function requireCapability(
  orgId: string | null | undefined,
  capability: VerticalCapability,
): Promise<NextResponse | null> {
  const caps = await shellCapabilities(orgId);
  if (caps.includes(capability)) return null;
  return NextResponse.json(
    {
      code: 'capability_unavailable' as const,
      capability,
      error: `This module (${capability}) is not part of your organization's product.`,
    },
    { status: 403 },
  );
}
