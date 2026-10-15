// An organization's uploaded mark and the icon set generated from it (#2922) —
// the only writer of `BrandAsset` rows and of `Organization.brandMarkVersion`.
//
// One upload → one VERSION → ~27 rows: every served kind (brandRule.ts,
// BRAND_SERVED_KINDS + one launch image per iOS device) plus the original as
// `source`, which is never served and exists so a later tile-colour change can
// re-render the set without asking for the file again. The version is
// sha256(orgId : sha256(file) : tile : RENDER_VERSION), cut to 16 hex
// characters: the same upload on the same tile is the same version (an
// idempotent re-upload), it differs per organization, and it carries no
// organization id into a public URL.
//
// Replacing a set is one transaction: drop the old rows, write the new ones,
// point the organization at the new version. The public route serves by
// (version, kind) only, so the moment the transaction commits the old URLs are
// gone and the new ones are live — there is no half-written set to serve.
import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { APPLE_SPLASH_DEVICES, splashPixels } from '@/lib/appleSplash';
import { contentMatchesType, sniffFamily } from '@/lib/fileType';
import { glyphMaster, renderBrandSet, RENDER_VERSION, type GlyphRefusal } from '@/lib/brandRender';
import { validateSvgMark, type SvgMarkRefusal } from '@/lib/svgMark';
import { BRAND_SOURCE_KIND, effectiveTileColor, isBrandVersion, splashKind } from '@/lib/brandRule';
import { themeColorFor } from '@/lib/accent';
import { toVerticalKey } from '@/lib/verticals';
import { invalidateBrandCache } from '@/lib/hostBrand';

/** The largest file the upload accepts (SVG has its own, smaller cap in svgMark.ts). */
export const BRAND_MARK_MAX_BYTES = 2 * 1024 * 1024;

const SVG_TYPE = 'image/svg+xml';
const RASTER_TYPES = new Set(['image/png', 'image/webp']);

export type MarkRefusal = 'missing' | 'too_large' | 'unsupported' | 'mismatch' | SvgMarkRefusal | GlyphRefusal;

type Classified = { ok: true; kind: 'svg' | 'raster'; contentType: string } | { ok: false; reason: MarkRefusal };

/**
 * What an upload IS, from its bytes, cross-checked against what it claims. The
 * declared type is the client's to choose, so it only ever narrows: a PNG must
 * be labelled PNG and carry PNG bytes (the shared #888 signature check), and an
 * SVG must be labelled SVG and pass the strict validator.
 */
export function classifyMarkUpload(bytes: Buffer, declaredType: string): Classified {
  if (bytes.length === 0) return { ok: false, reason: 'missing' };
  if (bytes.length > BRAND_MARK_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const declared = (declaredType || '').toLowerCase();
  const family = sniffFamily(bytes.subarray(0, 12));
  if (family === 'png' || family === 'webp') {
    if (!RASTER_TYPES.has(declared) || !contentMatchesType(bytes, declared)) return { ok: false, reason: 'mismatch' };
    return { ok: true, kind: 'raster', contentType: declared };
  }
  if (family !== null) return { ok: false, reason: 'unsupported' };
  if (declared !== SVG_TYPE) return { ok: false, reason: RASTER_TYPES.has(declared) ? 'mismatch' : 'unsupported' };
  const verdict = validateSvgMark(bytes);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, kind: 'svg', contentType: SVG_TYPE };
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The version of a set — see the header. */
export function brandVersion(orgId: string, source: Buffer, tile: string): string {
  return sha256(`${orgId}:${sha256(source)}:${tile}:${RENDER_VERSION}`).slice(0, 16);
}

type OrgForMark = { id: string; vertical: string | null; brandTileColor: string | null; brandColor: string | null };

/** The tile a set of this organization is rendered on (its tile, its colour, its vertical's tint). */
export function tileFor(org: OrgForMark): string {
  return effectiveTileColor(org, themeColorFor(toVerticalKey(org.vertical)));
}

async function writeSet(
  orgId: string,
  version: string,
  source: { bytes: Buffer; contentType: string },
  rendered: { kind: string; png: Buffer }[],
): Promise<void> {
  const rows = [
    ...rendered.map((a) => ({ orgId, version, kind: a.kind, contentType: 'image/png', size: a.png.length, data: a.png })),
    { orgId, version, kind: BRAND_SOURCE_KIND, contentType: source.contentType, size: source.bytes.length, data: source.bytes },
  ];
  await runWithOrg(orgId, () =>
    prisma.$transaction([
      prisma.brandAsset.deleteMany({ where: { orgId } }),
      prisma.brandAsset.createMany({ data: rows, skipDuplicates: true }),
      prisma.organization.update({ where: { id: orgId }, data: { brandMarkVersion: version } }),
    ]),
  );
  invalidateBrandCache();
}

/**
 * Render and store a new set from an accepted upload. Returns the version, or
 * the reason the file cannot become a mark (it decodes to nothing, is not
 * square, is too small…).
 */
export async function storeBrandMark(
  org: OrgForMark,
  upload: { bytes: Buffer; kind: 'svg' | 'raster'; contentType: string },
  opts: { wait?: boolean } = {},
): Promise<{ ok: true; version: string } | { ok: false; reason: MarkRefusal }> {
  // The upload does not queue behind a render already running (it answers
  // 'busy'); a re-render of a stored mark does (glyphMaster, brandRender.ts).
  const glyph = await glyphMaster({ kind: upload.kind, bytes: upload.bytes }, { wait: opts.wait });
  if (!glyph.ok) return glyph;
  const tile = tileFor(org);
  const rendered = await renderBrandSet({
    glyph: glyph.png,
    tile,
    splash: APPLE_SPLASH_DEVICES.map(splashPixels),
    splashKind,
  });
  const version = brandVersion(org.id, upload.bytes, tile);
  await writeSet(org.id, version, { bytes: upload.bytes, contentType: upload.contentType }, rendered);
  return { ok: true, version };
}

/**
 * Re-render the organization's current set on its CURRENT tile colour, from the
 * stored original. Called after a brand edit that may have moved the tile; a
 * no-op when there is no mark or the tile did not change (same version).
 */
export async function rerenderBrandMark(orgId: string): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, vertical: true, brandTileColor: true, brandColor: true, brandMarkVersion: true },
  });
  if (!org || !isBrandVersion(org.brandMarkVersion)) return null;
  const source = await runWithOrg(orgId, () =>
    prisma.brandAsset.findUnique({
      where: { version_kind: { version: org.brandMarkVersion as string, kind: BRAND_SOURCE_KIND } },
      select: { data: true, contentType: true },
    }),
  );
  if (!source) return null;
  const bytes = Buffer.from(source.data);
  if (brandVersion(org.id, bytes, tileFor(org)) === org.brandMarkVersion) return org.brandMarkVersion;
  const kind = source.contentType === SVG_TYPE ? 'svg' : 'raster';
  const stored = await storeBrandMark(org, { bytes, kind, contentType: source.contentType }, { wait: true });
  return stored.ok ? stored.version : null;
}

/** Remove the organization's set; its chrome falls back to the vertical's static files. */
export async function removeBrandMark(orgId: string): Promise<void> {
  await runWithOrg(orgId, () =>
    prisma.$transaction([
      prisma.brandAsset.deleteMany({ where: { orgId } }),
      prisma.organization.update({ where: { id: orgId }, data: { brandMarkVersion: null } }),
    ]),
  );
  invalidateBrandCache();
}
