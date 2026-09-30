/**
 * Shared rules for the image an admin can attach to a broadcast announcement
 * (#986). Imported by BOTH the client picker and the API route so the accept
 * filter, the size cap and the type allow-list can't drift apart — the same
 * reasoning as `textLimits.ts`: a client that accepts more than the server does
 * turns into an unexplained 400 *after* the admin picked the file.
 */

import { contentMatchesType, sniffFamily, CONTENT_MISMATCH_ERROR } from './fileType';

export const ANNOUNCEMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * PNG / JPEG / WebP / GIF only — deliberately no SVG. The blob is served back
 * from our own origin, and an SVG can carry <script>, so allowing it would turn
 * "attach an image" into stored XSS against every reader.
 */
export const ANNOUNCEMENT_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export const ANNOUNCEMENT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export type AnnouncementImageError = 'unsupported' | 'tooLarge' | 'unreadable';

export { CONTENT_MISMATCH_ERROR };

/** Where an announcement's attached image is served from. */
export function announcementImageUrl(announcementId: string) {
  return `/api/announcements/${announcementId}/image`;
}

/**
 * Validates a picked file. `null` means accepted.
 *
 * The declared MIME type is attacker-controlled, so the content signature is
 * checked too — via the shared `contentMatchesType()` (#888) that every other
 * upload route uses, rather than a second copy of the magic-byte table here.
 * It matters on this route as well: the GET echoes the stored `contentType`
 * back, so a file that merely *claims* to be a PNG must never be served under
 * an image type.
 */
export async function validateAnnouncementImage(file: File): Promise<AnnouncementImageError | null> {
  if (!ANNOUNCEMENT_IMAGE_MIME.has(file.type)) return 'unsupported';
  if (file.size === 0) return 'unreadable';
  if (file.size > ANNOUNCEMENT_IMAGE_MAX_BYTES) return 'tooLarge';

  try {
    // 12 bytes covers every signature in the table (WebP's "WEBP" ends at 12).
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!contentMatchesType(bytes, file.type)) return 'unreadable';
  } catch {
    return 'unreadable';
  }
  return null;
}

// The MIME type each accepted signature family is previewed as — a Map, not an
// object literal, so no key can reach the prototype.
const PREVIEW_TYPE = new Map<string, string>([
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

/**
 * The composer's local preview of an ALREADY-VALIDATED image (#2149).
 *
 * The file may come from the clipboard, whose declared type is the sender's to
 * choose. So the preview is rebuilt from the bytes: its type is the one the
 * signature says (never the declared one), and the `<img>` only ever receives a
 * `blob:` URL. `validateAnnouncementImage()` already refuses anything that is
 * not PNG/JPEG/WebP/GIF, and an `<img>` does not parse HTML either way; this
 * makes that guarantee local to the sink instead of three calls away, which is
 * also what CodeQL's `js/xss-through-dom` needs to see. Browser-only (it calls
 * `URL.createObjectURL`); returns null when the bytes are not an image we allow.
 */
export async function announcementImagePreview(file: File): Promise<{ file: File; url: string } | null> {
  let family: string | null;
  try {
    family = sniffFamily(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  } catch {
    return null;
  }
  const type = family ? PREVIEW_TYPE.get(family) : undefined;
  if (!type) return null;
  const clean = new File([file], file.name, { type });
  const url = URL.createObjectURL(clean);
  if (!url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
    return null;
  }
  return { file: clean, url };
}
