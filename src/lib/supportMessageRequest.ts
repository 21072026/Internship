import {
  SUPPORT_ATTACHMENT_MAX_COUNT,
  validateSupportFile,
} from '@/lib/supportAttachments';

// Server-side half of the support attachment pipeline, shared by the user
// channel (/api/support) and the admin reply endpoint (/api/admin/support) so
// both accept exactly the same file types, counts and size limits (#788).

/** A DB-ready `SupportAttachment` row. */
export interface SupportAttachmentInput {
  filename: string;
  contentType: string;
  size: number;
  data: Buffer;
}

type Failure = { ok: false; error: string; status: number };

/**
 * Reads a support message request in either form:
 *  - `multipart/form-data` — text fields plus zero or more `files` entries;
 *  - JSON — text only (the original, still-supported shape).
 * The returned `payload` is handed to each route's own zod schema.
 */
export async function readSupportMessageRequest(
  request: Request,
): Promise<{ ok: true; payload: unknown; files: File[] } | Failure> {
  if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
    return { ok: true, payload: await request.json().catch(() => null), files: [] };
  }

  const form = await request.formData().catch(() => null);
  if (!form) return { ok: false, error: 'Invalid multipart request', status: 400 };

  const fields: Record<string, string> = {};
  const files: File[] = [];

  for (const [key, value] of form.entries()) {
    if (key === 'files') {
      if (typeof value !== 'string') files.push(value);
    } else if (typeof value === 'string') {
      fields[key] = value;
    }
  }

  return { ok: true, payload: fields, files };
}

/**
 * Applies the shared attachment rules (count, duplicates, type/size/magic-byte
 * validation) and buffers the accepted files for persistence.
 */
export async function buildSupportAttachments(
  files: File[],
): Promise<{ ok: true; attachments: SupportAttachmentInput[] } | Failure> {
  if (files.length > SUPPORT_ATTACHMENT_MAX_COUNT) {
    return {
      ok: false,
      error: `Too many attachments (max ${SUPPORT_ATTACHMENT_MAX_COUNT})`,
      status: 400,
    };
  }

  const fileKeys = new Set<string>();

  for (const file of files) {
    const key = [file.name, file.size, file.type, file.lastModified].join('\0');
    if (fileKeys.has(key)) {
      return { ok: false, error: `Duplicate attachment: ${file.name}`, status: 400 };
    }
    fileKeys.add(key);

    const validationError = await validateSupportFile(file);
    if (validationError) {
      const errors = {
        unsupported: `Unsupported file type: ${file.name}`,
        tooLarge: `File too large: ${file.name}`,
        unreadable: `File is empty, corrupted, or unreadable: ${file.name}`,
      };
      return { ok: false, error: errors[validationError], status: 400 };
    }
  }

  const attachments = await Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      contentType: file.type,
      size: file.size,
      data: Buffer.from(await file.arrayBuffer()),
    })),
  );

  return { ok: true, attachments };
}
