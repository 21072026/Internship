// Resolving a shell's vertical capabilities server-side (#2351, epic #2348).
//
// A layout renders inside a request, so it CAN answer "which vertical?" — it has
// the session, and the session carries orgId. This is the one place that turns
// that orgId into the capability set the sidebar and the shell gate read. Kept
// out of the client nav components on purpose: verticalFor() touches the
// database, and the catalogue lookup is server work; the components receive the
// resolved list as a prop.
//
// INTERNSHIP carries every capability, so for today's single-tenant product this
// resolves to "everything" and every downstream filter/gate is a no-op.

import { verticalFor } from '@/lib/verticalContext';
import { verticalCapabilities, type VerticalCapability } from '@/lib/verticals';

export async function shellCapabilities(
  orgId: string | null | undefined,
): Promise<VerticalCapability[]> {
  // No org resolves to the default vertical (INTERNSHIP) — same fail-safe as
  // verticalFor: a shell with no tenant shows the full product, never a blank
  // one. verticalFor already treats a falsy orgId this way; the `?? ''` only
  // keeps the type honest.
  const vertical = await verticalFor(orgId ?? '');
  return verticalCapabilities(vertical);
}

// Does this shell's vertical carry a given capability? Used by the mentorship
// shells (/mentor, /portal) to redirect a vertical that has switched the whole
// module off, rather than render a shell its product does not include.
export async function shellHasCapability(
  orgId: string | null | undefined,
  capability: VerticalCapability,
): Promise<boolean> {
  return (await shellCapabilities(orgId)).includes(capability);
}
