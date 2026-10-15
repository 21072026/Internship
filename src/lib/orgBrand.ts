// Per-organization brand — the half that needs no request (#2922, #2936).
//
// Everything here reads an organization row (by id, or by the exact hostname it
// claims) and resolves it through the pure rule in ./brandRule.ts. It imports no
// request API and is not `server-only`, so the readers that run outside a page —
// mail, calendar files and feeds, Google Calendar sync, the 2FA issuer, the
// meeting-room prefix — and the unit specs that load them can use it directly.
// The request-bound readers (hostBrand, requestBrand) live in ./hostBrand.ts,
// which re-exports this module, so `@/lib/hostBrand` stays the one import for
// pages.
//
// THE DEFAULT IS TODAY'S CODE. `source: 'default'` tells every caller to keep
// the code path it had before this module existed. The default brand's fields
// are read through the functions that already own them (productNameFor,
// themeColorFor, defaultAccentFor) and are never copied here.
import { prisma } from '@/lib/prisma';
import { verticalFor } from '@/lib/verticalContext';
import { hostnameOf } from '@/lib/servedHosts';
import { worldForHostHeader } from '@/lib/hostWorld';
import { DEFAULT_VERTICAL, productNameFor, toVerticalKey, type VerticalKey } from '@/lib/verticals';
import { defaultAccentFor, isAccentColor, themeColorFor } from '@/lib/accent';
import {
  brandAssetBase,
  hostBrandSource,
  resolveBrandFields,
  type BrandDefaults,
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
const FAILURE_TTL_MS = 10_000;
const MAX_ENTRIES = 500;
type Entry = { at: number; ttl: number; row: BrandRow | null };
const brandCacheGlobal = globalThis as unknown as { __orgBrandCache?: { byHost: Map<string, Entry>; byOrg: Map<string, Entry> } };
brandCacheGlobal.__orgBrandCache ??= { byHost: new Map(), byOrg: new Map() };
const { byHost, byOrg } = brandCacheGlobal.__orgBrandCache;

function cached(map: Map<string, Entry>, key: string): Entry | undefined {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit;
  if (hit) map.delete(key);
  return undefined;
}

function remember(map: Map<string, Entry>, key: string, row: BrandRow | null, ttl = TTL_MS): void {
  if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as string);
  map.set(key, { at: Date.now(), ttl, row });
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
  let row: BrandRow | null;
  try {
    row = await prisma.organization.findUnique({ where: { publicHost: host }, select: BRAND_SELECT });
  } catch (e) {
    // A failed lookup is remembered as "no organization" for a few seconds:
    // during a database outage every public page and the manifest would
    // otherwise wait out the connection timeout first, and log it, on every
    // view — for an answer (the default brand) they get either way.
    remember(byHost, host, null, FAILURE_TTL_MS);
    throw e;
  }
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
 * The vertical and product name a person in `orgId` reads — in mail, a calendar
 * file, an authenticator entry, a meeting-room name. The vertical is read
 * fresh (verticalFor, as every one of these readers did before); the name is
 * the organization's brand name, else that vertical's default, and is never
 * another vertical's even while a brand row is still cached. No organization
 * is the default product.
 */
export async function orgProduct(orgId: string | null | undefined): Promise<{ vertical: VerticalKey; product: string }> {
  if (!orgId) return { vertical: DEFAULT_VERTICAL, product: defaultBrand(DEFAULT_VERTICAL).productName };
  const [vertical, brand] = await Promise.all([verticalFor(orgId), brandForOrg(orgId)]);
  return { vertical, product: productNameIn(brand, vertical) };
}

/** The product name alone — see orgProduct(). */
export async function productNameForOrg(orgId: string | null | undefined): Promise<string> {
  return (await orgProduct(orgId)).product;
}

/**
 * `brand.productName` when the brand belongs to `vertical`, else that vertical's
 * default name. For a caller that already resolved the vertical separately and
 * must never print one product's name in the other product's copy.
 */
export function productNameIn(brand: ResolvedBrand, vertical: VerticalKey): string {
  return brand.vertical === vertical ? brand.productName : defaultBrand(vertical).productName;
}
