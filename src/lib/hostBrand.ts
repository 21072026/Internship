// Per-organization brand — the database half (#2922). The rule itself (which
// source wins, how each field falls back, how a palette is derived) is pure and
// unit-tested in ./brandRule.ts; this file only reads the rows it needs, caches
// them briefly, and hands the result to the three kinds of reader:
//
//   hostBrand()     anything fetched WITHOUT cookies — the manifest, the <head>
//                   icons and launch images, the share card, the public JSON-LD.
//                   The host's mapped organization (`Organization.publicHost`,
//                   exact match), or the vertical default.
//   requestBrand()  the page chrome: theme-color, <html data-accent>, the brand
//                   mark components. Signed in → the person's OWN organization
//                   (never the host's); signed out → hostBrand().
//   brandForOrg()   a reader that has an organization in hand (push, mail).
//
// THE DEFAULT IS TODAY'S CODE. `source: 'default'` tells every caller to keep
// the code path it had before this module existed, untouched. The default
// brand's fields are read through the functions that already own them
// (productNameFor, themeColorFor, defaultAccentFor) and are never copied here,
// so a deployment where no organization carries brand data renders exactly what
// it rendered before.
//
// FAILING. A public page must render, so a failed lookup is the default brand,
// quietly. Nothing here decides access: a forged X-Forwarded-Host (Caddy
// overwrites it anyway) can only change the cosmetics of the forger's own page.
import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { requestSession } from '@/lib/requestSession';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { resolveOrgId } from '@/lib/orgScope';
import { DEFAULT_VERTICAL, type VerticalKey } from '@/lib/verticals';
import { brandAssetPath, isBrandVersion, type ClientBrand } from '@/lib/brandRule';
import { brandForOrg, defaultBrand, hostBrandFor, productNameIn, type ResolvedBrand } from '@/lib/orgBrand';

// The request-free half (org rows, the cache, the default brand) lives in
// ./orgBrand.ts; it is re-exported so pages keep one import.
export * from '@/lib/orgBrand';

/** The brand of the current request's HOST (signed-out surfaces). Cached per request. */
export const hostBrand = cache(async (): Promise<ResolvedBrand> => {
  try {
    const h = await headers();
    return await hostBrandFor(h.get('x-forwarded-host') ?? h.get('host'));
  } catch {
    return defaultBrand(DEFAULT_VERTICAL);
  }
});

/**
 * The brand the current PAGE wears: the signed-in person's own organization,
 * else the host's. Mirrors resolveRequestVertical() (src/i18n/server.ts): no
 * session cookie, or a cookie that decodes to nobody, is signed out.
 */
export const requestBrand = cache(async (): Promise<ResolvedBrand> => {
  if (!(await hasSessionCookie())) return hostBrand();
  try {
    const session = await requestSession();
    if (!session?.user?.id) return hostBrand();
    return await brandForOrg(resolveOrgId(session));
  } catch {
    // A transient session/database error must not dress the page in another
    // brand; the host's is what a signed-out view of it would show.
    return hostBrand();
  }
});

/**
 * The product name the current page prints for `vertical` — its title, its
 * public chrome, the `{product}` in its copy. The request brand's name (the
 * signed-in person's organization, else the host's), never another vertical's,
 * and always the default name in the default vertical (brandProductName()).
 * Not for a share card: that image is publicly cacheable, so it reads the
 * host's brand only (getCardDictionary in src/i18n/server.ts).
 */
export async function requestProductName(vertical: VerticalKey): Promise<string> {
  return productNameIn(await requestBrand(), vertical);
}

/** What the client components get through BrandProvider — null for a default brand. */
export function clientBrandOf(brand: ResolvedBrand): ClientBrand | null {
  if (brand.source !== 'org') return null;
  return {
    productName: brand.productName,
    markSrc: brand.markVersion ? brandAssetPath(brand.markVersion, 'mark-128') : null,
    tileColor: brand.tileColor,
    palette: brand.palette,
    defaultAccent: brand.accent,
  };
}

/**
 * One served image of a set as a `data:` URI — for the share card, which is
 * rendered on the server and must not fetch its own origin. Null when absent.
 * Read with no tenant bound: the (version, kind) key is the whole lookup, as on
 * the public route.
 */
export async function brandAssetDataUri(version: string | null, kind: string): Promise<string | null> {
  if (!isBrandVersion(version)) return null;
  try {
    const row = await runWithOrg(null, () =>
      prisma.brandAsset.findUnique({ where: { version_kind: { version, kind } }, select: { data: true, contentType: true } }),
    );
    if (!row || row.contentType !== 'image/png') return null;
    return `data:image/png;base64,${Buffer.from(row.data).toString('base64')}`;
  } catch {
    return null;
  }
}
