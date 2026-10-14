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
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { resolveOrgId } from '@/lib/orgScope';
import { hostnameOf } from '@/lib/servedHosts';
import { worldForHostHeader } from '@/lib/hostWorld';
import { DEFAULT_VERTICAL, productNameFor, toVerticalKey, type VerticalKey } from '@/lib/verticals';
import { defaultAccentFor, isAccentColor, themeColorFor } from '@/lib/accent';
import {
  brandAssetBase,
  brandAssetPath,
  hostBrandSource,
  isBrandVersion,
  resolveBrandFields,
  type BrandDefaults,
  type ClientBrand,
  type OrgBrandRow,
  type ResolvedBrandFields,
} from '@/lib/brandRule';

export type ResolvedBrand = ResolvedBrandFields & {
  vertical: VerticalKey;
  /** The organization the brand came from, or null for a default. */
  orgId: string | null;
  /** `/brand/<version>` when the organization has a generated icon set, else null. */
  assetBase: string | null;
};

/** The columns every brand read selects. */
export const BRAND_SELECT = {
  id: true,
  vertical: true,
  brandName: true,
  brandColor: true,
  brandTileColor: true,
  brandAccent: true,
  brandPalette: true,
  brandMarkVersion: true,
} as const;

type BrandRow = OrgBrandRow & { id: string };

/** A vertical's default brand, read through the functions that own each value. */
export function verticalDefaultBrand(vertical: VerticalKey): BrandDefaults {
  return {
    productName: productNameFor(vertical),
    themeColor: themeColorFor(vertical),
    accent: defaultAccentFor(vertical),
  };
}

function resolve(row: BrandRow | null, vertical: VerticalKey): ResolvedBrand {
  const fields = resolveBrandFields(row, verticalDefaultBrand(vertical), isAccentColor);
  const isOrg = fields.source === 'org' && row !== null;
  return {
    ...fields,
    vertical,
    orgId: isOrg ? row.id : null,
    assetBase: isOrg && fields.markVersion ? brandAssetBase(fields.markVersion) : null,
  };
}

/** The default brand of a vertical (`source: 'default'`). */
export function defaultBrand(vertical: VerticalKey): ResolvedBrand {
  return resolve(null, vertical);
}

// ── A short in-process cache ─────────────────────────────────────────────────
// Every public page view asks "which organization claims this host?". The
// answer changes only when an operator maps a host or an admin edits the
// brand, so it is kept for a minute, and every brand write in this process
// clears it at once (invalidateBrandCache). A second replica converges within
// the TTL. Misses are cached too — an unmapped host is the common case.
//
// On globalThis, like the Prisma singleton: Next may instantiate this module
// once per server layer (a route handler and a page are bundled separately),
// and an upload in one must clear the cache the other reads.
const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
type Entry = { at: number; row: BrandRow | null };
const brandCacheGlobal = globalThis as unknown as { __orgBrandCache?: { byHost: Map<string, Entry>; byOrg: Map<string, Entry> } };
brandCacheGlobal.__orgBrandCache ??= { byHost: new Map(), byOrg: new Map() };
const { byHost, byOrg } = brandCacheGlobal.__orgBrandCache;

function cached(map: Map<string, Entry>, key: string): Entry | undefined {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  if (hit) map.delete(key);
  return undefined;
}

function remember(map: Map<string, Entry>, key: string, row: BrandRow | null): void {
  if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as string);
  map.set(key, { at: Date.now(), row });
}

/** Forget every cached brand row in this process — called after any brand write. */
export function invalidateBrandCache(): void {
  byHost.clear();
  byOrg.clear();
}

async function rowForHost(host: string): Promise<BrandRow | null> {
  const hit = cached(byHost, host);
  if (hit) return hit.row;
  // `Organization` is not a tenant model, so no bound context rewrites this
  // lookup; the exact-match `where` is the whole rule (publicHostOrg.ts).
  const row = await prisma.organization.findUnique({ where: { publicHost: host }, select: BRAND_SELECT });
  remember(byHost, host, row);
  return row;
}

async function rowForOrg(orgId: string): Promise<BrandRow | null> {
  const hit = cached(byOrg, orgId);
  if (hit) return hit.row;
  const row = await prisma.organization.findUnique({ where: { id: orgId }, select: BRAND_SELECT });
  remember(byOrg, orgId, row);
  return row;
}

/** The brand a Host / X-Forwarded-Host header value resolves to. Never throws. */
export async function hostBrandFor(hostHeader: string | null | undefined): Promise<ResolvedBrand> {
  const vertical = worldForHostHeader(hostHeader);
  const host = hostnameOf(hostHeader);
  if (!host) return defaultBrand(vertical);
  try {
    const row = await rowForHost(host);
    const mapped = row ? { ...row, vertical: toVerticalKey(row.vertical) } : null;
    if (hostBrandSource({ hostVertical: vertical, mapped }) === 'org') return resolve(row, vertical);
  } catch {
    // A public page must render: an unreachable database is the default brand.
  }
  return defaultBrand(vertical);
}

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
 * The brand of one organization: its own brand fields over its vertical's
 * defaults, or that default when it carries none. No organization → the
 * default product. Throws on a database error; callers decide how to fail.
 */
export async function brandForOrg(orgId: string | null | undefined): Promise<ResolvedBrand> {
  if (!orgId) return defaultBrand(DEFAULT_VERTICAL);
  const row = await rowForOrg(orgId);
  if (!row) return defaultBrand(DEFAULT_VERTICAL);
  return resolve(row, toVerticalKey(row.vertical));
}

/**
 * The brand the current PAGE wears: the signed-in person's own organization,
 * else the host's. Mirrors resolveRequestVertical() (src/i18n/server.ts): no
 * session cookie, or a cookie that decodes to nobody, is signed out.
 */
export const requestBrand = cache(async (): Promise<ResolvedBrand> => {
  if (!(await hasSessionCookie())) return hostBrand();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return hostBrand();
    return await brandForOrg(resolveOrgId(session));
  } catch {
    // A transient session/database error must not dress the page in another
    // brand; the host's is what a signed-out view of it would show.
    return hostBrand();
  }
});

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
