'use client';

import { createContext, useContext } from 'react';
import type { ClientBrand } from '@/lib/brandRule';

// The request's organization brand for CLIENT components (#2922). The server
// resolves it once per request (root layout → Providers: the signed-in
// person's own organization, else the host's) and the mark components, the
// auth tiles and the accent picker read it here — the same value the server
// rendered with, so there is no hydration mismatch.
//
// NULL MEANS "THE DEFAULT". A request whose brand is not an organization's gets
// null, and every reader then keeps the rendering it had before this context
// existed. That is the whole guarantee that a deployment without brand data
// looks exactly as it did.
const BrandContext = createContext<ClientBrand | null>(null);

export function BrandProvider({ brand, children }: { brand: ClientBrand | null; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): ClientBrand | null {
  return useContext(BrandContext);
}
