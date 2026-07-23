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
