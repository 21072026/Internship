// Which product this deployment serves.
//
// WHAT THIS IS
//   This codebase ships more than one product from ONE image. Which product a
//   container *is* gets decided by APP_PRODUCT at start-up — the same shape
//   DEMO_MODE uses to decide whether a deployment is the public demo
//   (src/lib/demoMode.ts): same image, its own env, its own domain, and its own
//   DATABASE_URL when that is wanted.
//
//     APP_PRODUCT unset / 'internship'   mentor <-> mentee pipeline
//     APP_PRODUCT=marketing              SaleVali customer funnel
//
// WHY ENV AND NOT THE HOST HEADER
//   Nearly every absolute URL this app signs or mails is built from
//   NEXTAUTH_URL / NEXT_PUBLIC_APP_URL: invitation links, unsubscribe tokens,
//   SSO ACS URLs, calendar callbacks, every transactional email. One process
//   answering two hostnames would mint all of them for whichever domain its env
//   happened to name, so the second product's mail would link into the first
//   product's site. One container per product keeps every one of those call
//   sites correct without touching them, and makes the product a deploy-time
//   fact instead of a per-request guess.
//
// WHY NOT NEXT_PUBLIC_
//   NEXT_PUBLIC_* is inlined into the client bundle at BUILD time (see
//   appEnv.ts), which would mean one image per product — the very property this
//   approach exists to keep. So APP_PRODUCT is read on the SERVER ONLY and
//   reaches client components through the root layout, the route DEMO_MODE and
//   the locale already take. Do not import this module from a client component:
//   there `process.env.APP_PRODUCT` is undefined and would quietly resolve to
//   the default, mislabelling the other product.
//
// WHY THE DEFAULT IS 'internship'
//   The unset case is the deployment that predates this module. A missing or
//   misspelled value must never turn the running CRM into a different product,
//   so anything unrecognised resolves to 'internship'. It deliberately does not
//   throw: a typo in an env file should not take the live site down.
//
// NOT THIS AXIS
//   Per-tenant branding — one product, many organizations, each with its own
//   name/logo/color — is Organization + src/lib/branding.ts. A product is what
//   the deployment IS; a tenant is who is looking at it. The product supplies
//   the defaults that a tenant's overrides then layer on top of, which is why
//   orgBranding.ts passes PRODUCT_BRANDING into resolveBranding().

import type { AccentColor } from '@/lib/accent';

export type ProductId = 'internship' | 'marketing';

export interface Product {
  id: ProductId;
  /** Product name in chrome and mail, before any tenant override. */
  name: string;
  /** Full document title. */
  title: string;
  /** Default meta description. */
  description: string;
  /** Compact name for the PWA / apple-web-app title. */
  shortName: string;
  /**
   * Accent applied when the viewer has expressed no preference (accent.ts).
   * Deliberately different per product: whoever has both open should be able to
   * tell which one they are typing into at a glance — the same reason the
   * preview deployment is green.
   */
  accent: AccentColor;
  /**
   * <meta name="theme-color">. Kept in the catalogue rather than derived from
   * `accent` so the internship value stays exactly what it has always been —
   * deriving it would have silently shifted the live product's browser chrome.
   */
  themeColor: string;
}

export const PRODUCTS: Record<ProductId, Product> = {
  internship: {
    id: 'internship',
    name: 'Internship CRM',
    title: 'Internship CRM - Mentor-Mentee Management',
    description:
      'A comprehensive CRM for managing mentor-mentee relationships and internship programs',
    shortName: 'InternshipCRM',
    accent: 'blue',
    themeColor: '#1D4ED8',
  },
  marketing: {
    id: 'marketing',
    name: 'SaleVali Marketing CRM',
    title: 'SaleVali Marketing CRM',
    description:
      'CRM for the SaleVali marketing team: track merchants, trials, and subscriptions.',
    shortName: 'SaleValiCRM',
    accent: 'teal',
    themeColor: '#0F766E',
  },
};

export function isProductId(value: unknown): value is ProductId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRODUCTS, value);
}

/** The product this container serves. Server-only — see the header. */
export const APP_PRODUCT: ProductId = isProductId(process.env.APP_PRODUCT)
  ? process.env.APP_PRODUCT
  : 'internship';

export const PRODUCT: Product = PRODUCTS[APP_PRODUCT];

export const IS_MARKETING = APP_PRODUCT === 'marketing';
