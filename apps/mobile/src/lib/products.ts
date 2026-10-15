// The products one app serves (#2775). The URL a person signs in on decides
// which account they get (docs/worlds.md) — so the app never mixes hosts: every
// request, the cookie jar and the in-app web view all belong to the ONE host of
// the product chosen at sign-in.
//
// Only the internship product is built in. Any further product — a deployment's
// marketing product — comes from the build-time JSON EXPO_PUBLIC_EXTRA_PRODUCTS
// (#2926), a list of entries shaped like
//
//   [{"id":"acme","name":"Acme Sales","color":"#0F766E",
//     "hosts":{"production":"marketing.example.test","preview":"marketing.preview.example.test"}}]
//
// Expo inlines EXPO_PUBLIC_* variables into the JS bundle when it is built (for
// an EAS build: an EAS environment variable of the build's environment), so the
// names, colours and hosts of a deployment's products live with that
// deployment, not in this repository. Keep an `id` stable once it has shipped:
// the app remembers the chosen product by it.
//
// Dependency-free so `npm test` can pin it.

export type ProductId = string;
export type AppEnv = 'production' | 'preview';

export interface Product {
  id: ProductId;
  name: string;
  /** Brand tint of the product's card on the picker. */
  color: string;
  hosts: Record<AppEnv, string>;
}

export const INTERNSHIP_PRODUCT: Product = {
  id: 'internship',
  name: 'Internship CRM',
  color: '#1D4ED8',
  hosts: { production: 'interncrm.com', preview: 'preview.interncrm.com' },
};

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
// A bare lower-case hostname: no scheme, port, path or userinfo — the app
// builds `https://<host>` from it and compares origins against that.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function isHost(value: unknown): value is string {
  return typeof value === 'string' && HOST.test(value);
}

/**
 * The products EXPO_PUBLIC_EXTRA_PRODUCTS adds, in its order. Unset or blank is
 * none. An entry that is not well-formed (or reuses an id already taken) is
 * left out and reported in `rejected` by its position, and a value that is not
 * a JSON list at all adds nothing and reports `[-1]`. The built-in internship
 * product can never be replaced.
 */
export function parseExtraProducts(raw: string | undefined): { products: Product[]; rejected: number[] } {
  const products: Product[] = [];
  const rejected: number[] = [];
  if (!raw || !raw.trim()) return { products, rejected };
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return { products, rejected: [-1] };
  }
  if (!Array.isArray(list)) return { products, rejected: [-1] };
  const taken = new Set<string>([INTERNSHIP_PRODUCT.id]);
  list.forEach((entry: unknown, i) => {
    const e = entry as Partial<Product> | null;
    const hosts = e?.hosts as Partial<Record<AppEnv, unknown>> | undefined;
    const ok =
      !!e &&
      typeof e.id === 'string' &&
      ID.test(e.id) &&
      !taken.has(e.id) &&
      typeof e.name === 'string' &&
      e.name.trim() !== '' &&
      typeof e.color === 'string' &&
      COLOR.test(e.color) &&
      !!hosts &&
      isHost(hosts.production) &&
      isHost(hosts.preview);
    if (!ok) {
      rejected.push(i);
      return;
    }
    taken.add(e.id as string);
    products.push({
      id: e.id as string,
      name: (e.name as string).trim(),
      color: e.color as string,
      hosts: { production: hosts.production as string, preview: hosts.preview as string },
    });
  });
  return { products, rejected };
}

/** The built-in product first, then the configured ones. */
export function productsFrom(raw: string | undefined): readonly Product[] {
  return [INTERNSHIP_PRODUCT, ...parseExtraProducts(raw).products];
}

// The exact `process.env.EXPO_PUBLIC_…` expression is what Expo's bundler
// replaces with the build-time value; it must not be destructured or aliased.
export const PRODUCTS: readonly Product[] = productsFrom(process.env.EXPO_PUBLIC_EXTRA_PRODUCTS);

export function productById(id: string | null | undefined, products: readonly Product[] = PRODUCTS): Product | null {
  return products.find((p) => p.id === id) ?? null;
}

/**
 * Which product a launch opens, from the id the app remembered (#2926).
 *
 * - Nothing remembered: the build's only product, else the picker (null).
 * - A remembered id this build knows: that product.
 * - A remembered id this build does NOT know (a build without the extra
 *   product, or one that renamed its id): the picker, never the only product,
 *   and `forget` tells the caller to drop the stale id. Falling through to the
 *   only product would quietly move a person of one product onto another
 *   product's host.
 */
export function launchProduct(
  storedId: string | null | undefined,
  products: readonly Product[] = PRODUCTS,
): { product: Product | null; forget: boolean } {
  if (!storedId) return { product: products.length === 1 ? products[0] : null, forget: false };
  const known = productById(storedId, products);
  return known ? { product: known, forget: false } : { product: null, forget: true };
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
