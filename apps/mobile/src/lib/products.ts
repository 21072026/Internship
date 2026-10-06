// The two products one app serves (#2775). The URL a person signs in on decides
// which account they get (docs/worlds.md) — so the app never mixes hosts: every
// request, the cookie jar and the in-app web view all belong to the ONE host of
// the product chosen at sign-in.
//
// Dependency-free so `npm test` can pin it.

export type ProductId = 'internship' | 'salevali';
export type AppEnv = 'production' | 'preview';

export interface Product {
  id: ProductId;
  name: string;
  /** Brand tint, the same value as THEME_COLOR in src/lib/accent.ts. */
  color: string;
  hosts: Record<AppEnv, string>;
}

export const PRODUCTS: readonly Product[] = [
  {
    id: 'internship',
    name: 'Internship CRM',
    color: '#1D4ED8',
    hosts: { production: 'interncrm.com', preview: 'preview.interncrm.com' },
  },
  {
    id: 'salevali',
    name: 'SaleVali',
    color: '#b929cf',
    hosts: { production: 'marketing.bcsit-gmbh.de', preview: 'marketing.bcsit-gmbh.dev' },
  },
];

export function productById(id: string | null | undefined): Product | null {
  return PRODUCTS.find((p) => p.id === id) ?? null;
}

export function originFor(product: Product, env: AppEnv): string {
  return `https://${product.hosts[env]}`;
}

/**
 * Whether a URL the web view is about to open belongs to the signed-in product.
 * Anything else (another product, a payment page, a PDF on a CDN) leaves the
 * app for the system browser: the in-app view carries this product's session
 * and must never show it a page from somewhere else.
 */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
