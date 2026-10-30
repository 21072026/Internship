// SSO directory sync (#1943) — the Prisma-aware half. The rule (targets, value
// normalisation, the photo's shape) is src/lib/ssoDirectorySyncRule.ts; WHAT
// may be overwritten is src/lib/externalSyncPolicy.ts, shared with the roster
// feed. docs/sso-saml.md § Directory sync is the prose.
//
// Called by completeSsoSignIn() on EVERY SSO sign-in, after provisioning, for
// both protocols. Two guarantees:
//   - it never fails a sign-in. The caller wraps it; a refusal is recorded on
//     the user (`ssoSyncError`, a short code) for the admin to read;
//   - nothing it logs carries a value. The activity line names the fields that
//     changed; a person's department is not an operator's business.
//
// The photo runs AFTER the response (`after()` in the caller): a slow photo
// host must not hold up a sign-in, and the profile fields — what the session
// shows first — are already written by then.
//
// Sessionless (the SSO routes bind no tenant scope), so every query names the
// org explicitly, as the role mapping does.
//
// Server-only.

import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { planFieldUpdates } from '@/lib/externalSyncPolicy';
import { fetchPublicBytes, SsoFetchError } from '@/lib/ssoFetch';
import {
  attributeKeyOf,
  classifyPhotoClaim,
  MAX_PHOTO_BYTES,
  photoContentType,
  planAttributeWrites,
  planSsoProfileSync,
  SSO_PROFILE_FIELDS,
} from '@/lib/ssoDirectorySyncRule';
import type { SsoClaims } from '@/lib/ssoRoleMapping';

const profileSelect = Object.fromEntries(SSO_PROFILE_FIELDS.map((f) => [f, true])) as Record<(typeof SSO_PROFILE_FIELDS)[number], true>;

export interface ProfileSyncResult {
  /** The photo claim's value, for syncSsoPhoto() after the response; null when not mapped/sent. */
  photo: string | null;
  changed: string[];
  withheld: string[];
  rejected: string[];
}

/**
 * Refresh the profile fields and the org's own attributes from the claims of
 * a verified sign-in. A tenant with no mapping is untouched (no timestamp
 * either: nothing was synced).
 */
export async function syncSsoProfile(
  userId: string,
  org: { id: string; ssoAuthoritative: boolean },
  claims: SsoClaims,
): Promise<ProfileSyncResult | null> {
  const mappings = await prisma.ssoAttributeMapping.findMany({
    where: { orgId: org.id },
    select: { claim: true, target: true },
  });
  if (mappings.length === 0) return null;

  const keys = mappings.map((m) => attributeKeyOf(m.target)).filter((k): k is string => !!k);
  const attributes = keys.length
    ? await prisma.orgAttribute.findMany({
        where: { orgId: org.id, key: { in: keys }, appliesTo: 'USER' },
        select: { id: true, key: true, type: true, options: true },
      })
    : [];
  const plan = planSsoProfileSync(mappings, claims, attributes);

  const current = await prisma.user.findUnique({ where: { id: userId }, select: profileSelect });
  if (!current) return null;
  const fields = planFieldUpdates(current, plan.fields, { authoritative: org.ssoAuthoritative });

  const attrIds = Object.keys(plan.attributes);
  const have = attrIds.length
    ? await prisma.userAttributeValue.findMany({
        where: { orgId: org.id, userId, attributeId: { in: attrIds } },
        select: { attributeId: true, value: true },
      })
    : [];
  const attrs = planAttributeWrites(plan.attributes, new Map(have.map((v) => [v.attributeId, v.value])), org.ssoAuthoritative);
  const keyOf = new Map(attributes.map((a) => [a.id, a.key]));

  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        ...fields.changes,
        ssoLastSyncedAt: now,
        ssoSyncError: plan.rejected.length ? `rejected:${plan.rejected.join(',')}`.slice(0, 191) : null,
      },
    }),
    ...Object.entries(attrs.writes).map(([attributeId, value]) =>
      prisma.userAttributeValue.upsert({
        where: { userId_attributeId: { userId, attributeId } },
        create: { orgId: org.id, userId, attributeId, value },
        update: { value },
      }),
    ),
  ]);

  const changed = [...fields.changed, ...Object.keys(attrs.writes).map((id) => `attr:${keyOf.get(id) ?? id}`)];
  const withheld = [...fields.withheld, ...attrs.withheld.map((id) => `attr:${keyOf.get(id) ?? id}`)];
  if (changed.length || withheld.length || plan.rejected.length) {
    await logActivity({
      action: 'sso.profile_synced',
      actorId: null,
      targetType: 'user',
      targetId: userId,
      // Field NAMES only — never a value.
      detail: [
        changed.length ? `changed: ${changed.join(', ')}` : '',
        withheld.length ? `kept (not authoritative): ${withheld.join(', ')}` : '',
        plan.rejected.length ? `rejected: ${plan.rejected.join(', ')}` : '',
      ].filter(Boolean).join('; ').slice(0, 500),
    });
  }
  return { photo: plan.photo, changed, withheld, rejected: plan.rejected };
}

export type PhotoSyncOutcome = 'stored' | 'unchanged' | 'kept_own' | 'photo_blocked' | 'photo_failed' | 'photo_too_large' | 'photo_not_image';

async function recordPhotoError(userId: string, code: string, detail?: string) {
  await prisma.user.update({ where: { id: userId }, data: { ssoSyncError: code } });
  await logActivity({ action: 'sso.profile_photo_failed', level: 'warning', actorId: null, targetType: 'user', targetId: userId, detail: (detail ?? code).slice(0, 180) });
}

/**
 * Store the photo a claim names, the way an uploaded avatar is stored: the
 * BYTES, in AvatarFile, served by /api/avatar/[userId] — never the IdP's URL,
 * which would leak every viewer's IP to the IdP and break when it moves.
 *
 * A URL goes through the SSRF guard on every hop (ssoFetch), a 5 s timeout and
 * the 2 MB avatar cap; inline base64 is decoded under the same cap. The bytes
 * must carry an image signature. An avatar the user uploaded themselves is
 * their data: replaced only when the tenant made the IdP authoritative.
 */
export async function syncSsoPhoto(userId: string, org: { ssoAuthoritative: boolean }, claim: string): Promise<PhotoSyncOutcome> {
  const hash = crypto.createHash('sha256').update(claim).digest('hex');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ssoPhotoUrlHash: true, avatarFile: { select: { id: true } } },
  });
  if (!user) return 'unchanged';
  // The same photo as last time — stored already, or removed by the user since
  // (a removal keeps the hash, so the IdP does not put back what they took
  // down; a NEW photo at the IdP is offered again).
  if (user.ssoPhotoUrlHash === hash) return 'unchanged';
  // An avatar not from the IdP (an upload clears the hash) is the user's own.
  if (user.avatarFile && !user.ssoPhotoUrlHash && !org.ssoAuthoritative) return 'kept_own';

  const source = classifyPhotoClaim(claim);
  let bytes: Uint8Array;
  if (source.kind === 'invalid') {
    await recordPhotoError(userId, 'photo_not_image');
    return 'photo_not_image';
  }
  if (source.kind === 'inline') {
    bytes = source.bytes;
  } else {
    try {
      bytes = await fetchPublicBytes(source.url, MAX_PHOTO_BYTES);
    } catch (e) {
      const code: PhotoSyncOutcome = e instanceof SsoFetchError
        ? e.code === 'fetch_blocked' ? 'photo_blocked' : e.code === 'too_large' ? 'photo_too_large' : 'photo_failed'
        : 'photo_failed';
      await recordPhotoError(userId, code, e instanceof Error ? `${code}: ${e.message}` : code);
      return code;
    }
  }
  const contentType = photoContentType(bytes);
  if (!contentType) {
    await recordPhotoError(userId, 'photo_not_image');
    return 'photo_not_image';
  }
  const data = Buffer.from(bytes);
  await prisma.$transaction([
    prisma.avatarFile.upsert({
      where: { userId },
      create: { userId, contentType, size: data.byteLength, data },
      update: { contentType, size: data.byteLength, data, uploadedAt: new Date() },
    }),
    prisma.user.update({ where: { id: userId }, data: { avatarUrl: `/api/avatar/${userId}`, ssoPhotoUrlHash: hash } }),
  ]);
  return 'stored';
}
