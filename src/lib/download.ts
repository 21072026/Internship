/**
 * Headers for serving a stored user upload (#890).
 *
 * Two things were slightly wrong across the download routes: files were served
 * `inline` from the app's own origin, and the filename went into the header
 * with only `"` stripped — a `\r\n` in a name would have split the header.
 *
 * The global `nosniff` in `next.config.js` already covers the sniffing half, so
 * this is defence in depth: a route that carries its own header keeps the
 * protection if that global config is ever narrowed.
 */

/** Strip anything that could break out of the header, and bound the length. */
function sanitizeFilename(name: string): string {
  const cleaned = (name || 'file')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '') // control chars, incl. CR/LF
    .replace(/["\\;]/g, '')
    .trim();
  return (cleaned || 'file').slice(0, 100);
}

/**
 * The plain `filename="…"` fallback must be ASCII. A header value is a byte
 * string: Node and undici refuse any character above U+00FF outright ("ş" is
 * U+015F), so a Turkish CV name used to turn the whole download into a 500
 * once Next stopped smoothing that over (15.5.29). Accents are folded where
 * Unicode can (ö → o); anything left over becomes "_". The real name travels
 * in `filename*` (RFC 6266 § 4.3), which every current browser prefers.
 */
function asciiFallback(safe: string): string {
  const folded = safe
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim();
  return folded || 'file';
}

/** RFC 5987 ext-value: percent-encode everything outside attr-char. */
function encodeExtValue(safe: string): string {
  return encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A `Content-Disposition` value for a user-supplied filename: header-safe
 * whatever the name holds (CR/LF, quotes, any script), with the original name
 * preserved through `filename*`. Every route that puts a stored upload's own
 * name into the header goes through here.
 */
export function contentDisposition(filename: string, disposition: 'inline' | 'attachment' = 'attachment'): string {
  const safe = sanitizeFilename(filename);
  return `${disposition}; filename="${asciiFallback(safe)}"; filename*=UTF-8''${encodeExtValue(safe)}`;
}

export interface DownloadHeaderOptions {
  filename: string;
  contentType: string;
  size: number;
  /**
   * `true` for files the UI actually renders in place (avatars, and images in a
   * message thread). Everything else downloads, so a document can't be coaxed
   * into rendering as a page on our own origin.
   */
  inline?: boolean;
}

export function downloadHeaders({
  filename,
  contentType,
  size,
  inline = false,
}: DownloadHeaderOptions): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(filename, inline ? 'inline' : 'attachment'),
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
