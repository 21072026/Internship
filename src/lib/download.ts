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
  const safe = sanitizeFilename(filename);
  // Both forms: the plain one for old clients, `filename*` so a Turkish or
  // otherwise non-ASCII CV name survives the trip (RFC 5987).
  const encoded = encodeURIComponent(safe);
  const disposition = inline ? 'inline' : 'attachment';

  return {
    'Content-Type': contentType,
    'Content-Disposition': `${disposition}; filename="${safe}"; filename*=UTF-8''${encoded}`,
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
