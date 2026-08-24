/**
 * Object-URL previews (#1005).
 *
 * Every attachment/image picker renders `URL.createObjectURL(file)` into an
 * `<img src>`. CodeQL flags each one as `js/xss-through-dom` — "DOM text is
 * reinterpreted as HTML without escaping meta-characters" — because a
 * DOM-derived `File` reaches an `src` attribute.
 *
 * The taint is real; the sink is not one that can execute it:
 *
 *   · `URL.createObjectURL()` returns `blob:<origin>/<uuid>`. The scheme is
 *     produced by the browser, not by the file, so it can never be
 *     `javascript:` or `data:`.
 *   · `<img>` does not run script even when the bytes are SVG. SVG script runs
 *     only when the document is loaded AS a document — iframe, object, or
 *     direct navigation.
 *
 * So this helper is redundant at runtime, and that is the point: it puts the
 * invariant the reasoning depends on into code, at one choke point, instead of
 * leaving it as a comment on three (and counting) call sites. If a future
 * picker ever passes something that is not a blob URL — a pasted string, a
 * server value threaded through the same prop — it renders nothing rather than
 * whatever that string was.
 */
export function objectUrlSrc(url: string | null | undefined): string {
  return typeof url === 'string' && url.startsWith('blob:') ? url : '';
}
