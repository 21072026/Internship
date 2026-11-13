// The partner page theme's uploads (#3535, docs/affiliate-module.md § The page's
// look) — the only reader and writer of AffiliateLandingAsset. Server-only.
//
// A theme names its logo, hero and showcase by asset id (affiliateLandingRule.ts,
// theme.media), never by URL, so the public page loads files from our own
// storage only. The bytes are checked against the declared type (#888, the
// shared signature check) and served back with that type, nosniff and an
// inline disposition by /api/public/partner-media/<id>.
//
// Lifecycle: an upload is a row at once (the editor previews it before the
// landing is saved); saveLanding() checks every referenced id is this org's and
// of a kind the slot takes, and sweeps the org's rows no theme points at that
// are older than SWEEP_GRACE_MS — a fresh upload in another admin's open editor
// is not pulled from under it.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { contentMatchesType } from '@/lib/fileType';
import {
  THEME_MEDIA_KINDS,
  THEME_MEDIA_MAX_BYTES,
  THEME_MEDIA_MAX_PER_ORG,
  themeMediaKind,
  themeMediaRefs,
  themeMediaUrl,
  type LandingIssue,
  type LandingTheme,
} from '@/lib/affiliateLandingRule';
import type { ThemeMedia } from '@/lib/partnerThemeLook';

export type AssetRefusal = 'missing' | 'unsupported' | 'too_large' | 'mismatch' | 'too_many';

const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/** Stores one upload for the org's theme; the id and URL, or why not. */
export async function storeLandingAsset(
  orgId: string,
  file: File | null,
): Promise<{ ok: true; id: string; kind: 'image' | 'video'; url: string } | { ok: false; reason: AssetRefusal }> {
  if (!file || file.size === 0) return { ok: false, reason: 'missing' };
  const kind = themeMediaKind(file.type);
  if (!kind) return { ok: false, reason: 'unsupported' };
  if (file.size > THEME_MEDIA_MAX_BYTES[kind]) return { ok: false, reason: 'too_large' };
  return storeLandingAssetBytes(orgId, Buffer.from(await file.arrayBuffer()), file.type);
}

/** The checks a stored asset must pass, on bytes already in hand (the upload and the settings import, #3622). */
export function landingAssetRefusal(bytes: Buffer, contentType: string): AssetRefusal | null {
  if (bytes.length === 0) return 'missing';
  const kind = themeMediaKind(contentType);
  if (!kind) return 'unsupported';
  if (bytes.length > THEME_MEDIA_MAX_BYTES[kind]) return 'too_large';
  if (!contentMatchesType(bytes.subarray(0, 12), contentType)) return 'mismatch';
  return null;
}

/** Stores bytes as one of the org's theme uploads — the one place a row is created. */
export async function storeLandingAssetBytes(
  orgId: string,
  bytes: Buffer,
  contentType: string,
): Promise<{ ok: true; id: string; kind: 'image' | 'video'; url: string } | { ok: false; reason: AssetRefusal }> {
  const refusal = landingAssetRefusal(bytes, contentType);
  if (refusal) return { ok: false, reason: refusal };
  const kind = themeMediaKind(contentType)!;
  if ((await prisma.affiliateLandingAsset.count({ where: { orgId } })) >= THEME_MEDIA_MAX_PER_ORG) return { ok: false, reason: 'too_many' };
  const row = await prisma.affiliateLandingAsset.create({
    data: { orgId, kind, contentType: contentType.toLowerCase(), size: bytes.length, data: bytes },
    select: { id: true },
  });
  return { ok: true, id: row.id, kind, url: themeMediaUrl(row.id) };
}

/** The kind of each of the org's assets among `ids` (an id of another org is simply absent). */
export async function landingAssetKinds(orgId: string, ids: string[], db: Prisma.TransactionClient = prisma): Promise<Map<string, 'image' | 'video'>> {
  if (ids.length === 0) return new Map();
  const rows = await db.affiliateLandingAsset.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, kind: true } });
  return new Map(rows.map((r) => [r.id, r.kind === 'video' ? 'video' : 'image']));
}

/** Issues for media a theme names that are not this org's, or not a kind the slot takes. */
export async function themeMediaIssues(orgId: string, theme: LandingTheme | null, db: Prisma.TransactionClient = prisma): Promise<LandingIssue[]> {
  const refs = themeMediaRefs(theme);
  const kinds = await landingAssetKinds(orgId, [...new Set(refs.map((r) => r.id))], db);
  return refs.flatMap(({ slot, id }) => {
    const kind = kinds.get(id);
    return kind && THEME_MEDIA_KINDS[slot].includes(kind) ? [] : [{ field: `theme.media.${slot}`, code: 'invalid' as const }];
  });
}

/** Deletes the org's uploads the saved theme does not use, past the grace period. */
export async function sweepLandingAssets(db: Prisma.TransactionClient, orgId: string, theme: LandingTheme | null): Promise<void> {
  const keep = themeMediaRefs(theme).map((r) => r.id);
  await db.affiliateLandingAsset.deleteMany({
    where: { orgId, createdAt: { lt: new Date(Date.now() - SWEEP_GRACE_MS) }, ...(keep.length ? { id: { notIn: keep } } : {}) },
  });
}


export async function themeMediaFor(orgId: string, theme: LandingTheme | null): Promise<ThemeMedia> {
  const refs = themeMediaRefs(theme);
  const kinds = await landingAssetKinds(orgId, [...new Set(refs.map((r) => r.id))]);
  const out: ThemeMedia = {};
  for (const { slot, id } of refs) {
    const kind = kinds.get(id);
    // A row swept or never there: the slot is simply empty (the gradient hero, no logo).
    if (kind && THEME_MEDIA_KINDS[slot].includes(kind)) out[slot] = { url: themeMediaUrl(id), kind };
  }
  return out;
}
