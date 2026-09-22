'use client';

import { createContext, useContext } from 'react';
import type { VerticalKey } from '@/lib/verticals';

// The request's vertical for CLIENT components (#2501). The server resolves it
// once per request (root layout → Providers, session-first, host-second) and
// client components read it here instead of guessing from window.location —
// the same value the server used to render, so there is no hydration mismatch.
// Defaults to INTERNSHIP so a component rendered outside Providers (a test, a
// story) behaves as the base product.
const VerticalContext = createContext<VerticalKey>('INTERNSHIP');

export function VerticalProvider({ vertical, children }: { vertical: VerticalKey; children: React.ReactNode }) {
  return <VerticalContext.Provider value={vertical}>{children}</VerticalContext.Provider>;
}

export function useVertical(): VerticalKey {
  return useContext(VerticalContext);
}
