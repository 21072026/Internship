export const SUPPORT_ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.pdf';
export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MAX_COUNT = 10;

export const SUPPORT_ATTACHMENT_MIME = new Set([
  'image/png',
  'image/jpeg',
  'application/pdf',
]);

export interface SupportAttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

export type SupportFileValidationError = 'unsupported' | 'tooLarge' | 'unreadable';

/** A file picked in a composer but not yet sent (`url` is an object URL for previews). */
export interface PendingSupportAttachment {
  file: File;
  url: string;
}

/** The `support.attachment*` dictionary entries used to report rejected files. */
export interface SupportAttachmentErrorLabels {
  attachmentDuplicate: string;
  attachmentTooMany: string;
  attachmentUnsupported: string;
  attachmentTooLarge: string;
  attachmentUnreadable: string;
}

/**
 * Shared "add files to the composer" step for every support composer (the user
 * thread and the admin reply box). Applies the same duplicate / count /
 * per-file rules everywhere and returns the new pending list plus the last
 * rejection message ('' when every file was accepted).
 */
export async function appendSupportAttachments(
  current: PendingSupportAttachment[],
  selected: FileList | File[],
  labels: SupportAttachmentErrorLabels,
): Promise<{ attachments: PendingSupportAttachment[]; error: string }> {
  const next = [...current];
  let error = '';

  for (const file of Array.from(selected)) {
    const duplicate = next.some(({ file: picked }) =>
      picked.name === file.name && picked.size === file.size &&
      picked.type === file.type && picked.lastModified === file.lastModified
    );
    if (duplicate) {
      error = labels.attachmentDuplicate.replace('{name}', file.name);
      continue;
    }
    if (next.length >= SUPPORT_ATTACHMENT_MAX_COUNT) {
      error = labels.attachmentTooMany.replace('{count}', String(SUPPORT_ATTACHMENT_MAX_COUNT));
      break;
    }
    const validation = await validateSupportFile(file);
    if (validation) {
      const label = {
        unsupported: labels.attachmentUnsupported,
        tooLarge: labels.attachmentTooLarge,
        unreadable: labels.attachmentUnreadable,
      }[validation];
      error = label.replace('{name}', file.name);
      continue;
    }
    next.push({ file, url: URL.createObjectURL(file) });
  }

  return { attachments: next, error };
}

export async function validateSupportFile(file: File): Promise<SupportFileValidationError | null> {
  if (!SUPPORT_ATTACHMENT_MIME.has(file.type)) return 'unsupported';
  if (file.size === 0) return 'unreadable';
  if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) return 'tooLarge';

  try {
    const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (file.type === 'image/png' && !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'unreadable';
    if (file.type === 'image/jpeg' && !startsWith(bytes, [0xff, 0xd8, 0xff])) return 'unreadable';
    if (file.type === 'application/pdf' && !startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'unreadable';
  } catch {
    return 'unreadable';
  }
  return null;
}
