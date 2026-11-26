// Images on a follow-up (#3931) — the rules, dependency-free so a plain
// `node --experimental-strip-types` unit test can import them.
//
// An image is a screenshot a rep pastes beside the next step ("look at this
// screen"). Images only for now (decision 2026-11-25): the type is read from
// the bytes, never from the name or the browser's claim, and only the four
// formats every browser draws are accepted. A follow-up carries at most
// FOLLOW_UP_IMAGE_MAX of them, each at most FOLLOW_UP_IMAGE_BYTES.

export const FOLLOW_UP_IMAGE_MAX = 3;
export const FOLLOW_UP_IMAGE_BYTES = 5 * 1024 * 1024;
/** Unattached uploads a person may hold on one record at once (a dialog opened twice). */
export const FOLLOW_UP_IMAGE_DRAFT_MAX = 6;
/** A draft nobody attached within this long is deleted on the uploader's next upload. */
export const FOLLOW_UP_IMAGE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export type FollowUpImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** The image type the bytes say, or null for anything else. */
export function sniffImageType(bytes: Uint8Array): FollowUpImageType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export type UploadCheck = { ok: true; type: FollowUpImageType } | { ok: false; error: 'not_an_image' | 'too_large' | 'empty' };

export function checkUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.length === 0) return { ok: false, error: 'empty' };
  if (bytes.length > FOLLOW_UP_IMAGE_BYTES) return { ok: false, error: 'too_large' };
  const type = sniffImageType(bytes);
  return type ? { ok: true, type } : { ok: false, error: 'not_an_image' };
}

export interface ImageRow {
  id: string;
  /** null = a draft nobody attached yet. */
  attachedAt: Date | null;
  clearedAt: Date | null;
  uploaderId: string | null;
}

export type ImageSetPlan =
  | { ok: true; attach: string[]; clear: string[] }
  | { ok: false; error: 'unknown_image' | 'too_many_images' };

/**
 * The follow-up's image set after a write that names it (`wanted` = the ids the
 * form holds, in order): the current images not named leave the panel
 * (`clear`), the named drafts are attached (`attach`). A named id must be one
 * of this record's current images or the actor's own draft on it — anything
 * else (another record's image, someone else's draft, a cleared one) is
 * refused rather than skipped, so a client cannot attach what it never uploaded.
 */
export function planImageSet(rows: readonly ImageRow[], wanted: readonly string[], actorId: string): ImageSetPlan {
  const unique = [...new Set(wanted)];
  if (unique.length > FOLLOW_UP_IMAGE_MAX) return { ok: false, error: 'too_many_images' };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const attach: string[] = [];
  for (const id of unique) {
    const r = byId.get(id);
    if (!r || r.clearedAt) return { ok: false, error: 'unknown_image' };
    if (!r.attachedAt) {
      if (r.uploaderId !== actorId) return { ok: false, error: 'unknown_image' };
      attach.push(id);
    }
  }
  const clear = rows.filter((r) => r.attachedAt && !r.clearedAt && !unique.includes(r.id)).map((r) => r.id);
  return { ok: true, attach, clear };
}

/** The images that are on the follow-up now (attached, not cleared). */
export function currentImages<T extends ImageRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.attachedAt && !r.clearedAt);
}
