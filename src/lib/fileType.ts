/**
 * Content-signature ("magic byte") checks for uploads (#888).
 *
 * Every upload route validated `file.type`, which comes from the multipart
 * header and is written by the client — the bytes were never looked at. That
 * matters here more than usual: the declared type is *stored* and handed back
 * on download, so a mislabelled file arrives on an employer's machine wearing
 * the word "CV".
 *
 * Deliberately dependency-free. A sniffing library would be one more parser in
 * the trust boundary, and the signatures we care about are a handful of bytes.
 */

/** Families a signature can identify. Several MIME types map to one family. */
type Family = 'pdf' | 'zip' | 'ole2' | 'png' | 'jpeg' | 'gif' | 'webp';

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

export function sniffFamily(buf: Uint8Array): Family | null {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'gif'; // GIF8
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole2'; // legacy .doc
  // PK\x03\x04. Also PK\x05\x06 / PK\x07\x08 for empty and spanned archives —
  // not valid Office documents, but accepting them here only means the ZIP
  // family check passes and the file fails to open later, which is the same
  // outcome as any other corrupt upload.
  if (startsWith(buf, [0x50, 0x4b]) && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
  return null;
}

/**
 * Which family each accepted MIME type must have on disk.
 *
 * DOCX and XLSX are both ZIP containers and cannot be told apart by signature
 * alone — the check is therefore "the bytes are a ZIP", not "the bytes are
 * specifically a DOCX". Demanding more would reject legitimate uploads, which
 * is a worse failure than a mislabelled Office document.
 */
const EXPECTED: Record<string, Family[]> = {
  'application/pdf': ['pdf'],
  'application/msword': ['ole2', 'zip'], // some tools emit .docx labelled as msword
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
  'application/vnd.ms-excel': ['ole2', 'zip'],
  'image/png': ['png'],
  'image/jpeg': ['jpeg'],
  'image/jpg': ['jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
};

/**
 * True when the bytes match what `declaredType` claims.
 *
 * A declared type we have no signature for returns `false` — the caller has
 * already checked it against its own allowlist, so reaching here with an
 * unknown type means the two lists have drifted, and guessing is not the
 * behaviour we want from a security check.
 */
export function contentMatchesType(buf: Uint8Array, declaredType: string): boolean {
  const expected = EXPECTED[declaredType.toLowerCase()];
  if (!expected) return false;
  const actual = sniffFamily(buf);
  return actual !== null && expected.includes(actual);
}

/** Shared message so every upload route rejects in the same words. */
export const CONTENT_MISMATCH_ERROR =
  'The file contents do not match its type. Upload the original file rather than a renamed one.';
