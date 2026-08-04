/**
 * The href behind a "view CV" link.
 *
 * A stored CV lives at `/api/cv/<userId>`, and since #890 that route answers
 * with `Content-Disposition: attachment` — so "view CV" downloaded the file
 * instead of showing it. On a phone that reads as a dead link: the tab opens
 * blank and the file lands in Downloads.
 *
 * `?inline=1` asks the route to render it in place instead. The route only
 * honours it for a PDF (see the comment there); a Word CV downloads either way,
 * which is all a browser can do with it. An external `cvUrl` (a Drive link a
 * mentee typed in) is returned untouched.
 */
export function cvViewHref(cvUrl: string): string {
  if (!cvUrl.startsWith('/api/cv/')) return cvUrl;
  return `${cvUrl}${cvUrl.includes('?') ? '&' : '?'}inline=1`;
}
