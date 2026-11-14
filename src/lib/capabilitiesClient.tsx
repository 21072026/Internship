'use client';

import { createContext, useContext } from 'react';
import { verticalCapabilities, DEFAULT_VERTICAL, type VerticalCapability } from '@/lib/verticals';

// The shell's vertical capabilities for CLIENT components (#2348).
//
// `shellCapabilities()` resolves the module set on the server (it reads the
// org's vertical from the database), and a role layout already calls it for
// its sidebar and command palette. A client page inside that layout — the
// admin lead page above all — had no way to ask the same question, so it
// rendered internship panels (offers, evaluations, goals, cadence,
// certificates) to a MARKETING tenant. The layout now hands the list it already
// resolved to this provider, so the page reads exactly what the sidebar reads:
// one resolution per request, no second lookup, no hydration mismatch.
//
// Presentation only. Hiding a panel is not the check: every API keeps its own
// `requireCapability()` gate.
//
// Outside a provider (a test, a story, a page whose layout does not mount one)
// the default is the base product's full set — the same fail-safe as
// `shellCapabilities()` for a request without an org: a missing provider can
// only ever show what already worked, never blank a screen.
const CapabilitiesContext = createContext<readonly VerticalCapability[]>(verticalCapabilities(DEFAULT_VERTICAL));

export function CapabilitiesProvider({
  capabilities,
  children,
}: {
  capabilities: readonly VerticalCapability[];
  children: React.ReactNode;
}) {
  return <CapabilitiesContext.Provider value={capabilities}>{children}</CapabilitiesContext.Provider>;
}

/** The capability set of the shell this component renders in. */
export function useCapabilities(): readonly VerticalCapability[] {
  return useContext(CapabilitiesContext);
}

/** Whether the shell's vertical carries `capability`. */
export function useHasCapability(capability: VerticalCapability): boolean {
  return useContext(CapabilitiesContext).includes(capability);
}
