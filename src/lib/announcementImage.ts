/**
 * Shared rules for the image an admin can attach to a broadcast announcement
 * (#986). Imported by BOTH the client picker and the API route so the accept
 * filter, the size cap and the type allow-list can't drift apart — the same
 * reasoning as `textLimits.ts`: a client that accepts more than the server does
 * turns into an unexplained 400 *after* the admin picked the file.
 */

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

/** Where an announcement's attached image is served from. */
export function announcementImageUrl(announcementId: string) {
  return `/api/announcements/${announcementId}/image`;
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

/**
 * Validates a picked file. `null` means accepted.
 *
 * The declared MIME type is attacker-controlled, so the leading bytes are
 * checked too: the route echoes `contentType` back on the GET, and a file that
 * merely *claims* to be a PNG must not get served under an image type.
 */
export async function validateAnnouncementImage(file: File): Promise<AnnouncementImageError | null> {
  if (!ANNOUNCEMENT_IMAGE_MIME.has(file.type)) return 'unsupported';
  if (file.size === 0) return 'unreadable';
  if (file.size > ANNOUNCEMENT_IMAGE_MAX_BYTES) return 'tooLarge';

  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (file.type === 'image/png' && !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'unreadable';
    if (file.type === 'image/jpeg' && !startsWith(bytes, [0xff, 0xd8, 0xff])) return 'unreadable';
    if (file.type === 'image/gif' && !startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'unreadable';
    // WebP is "RIFF" + 4 size bytes + "WEBP".
    if (file.type === 'image/webp' && !(startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.slice(8), [0x57, 0x45, 0x42, 0x50]))) {
      return 'unreadable';
    }
  } catch {
    return 'unreadable';
  }
  return null;
}
