// The strict validator an uploaded SVG mark must pass before it is rasterized
// (#2922). ZERO imports, so `node --test --experimental-strip-types` loads it
// (scripts/test/svg-mark.test.mjs runs a corpus of hostile files through it).
//
// WHY STRICT, AND WHY IT IS STILL NOT THE WHOLE DEFENCE
//   An accepted SVG is NEVER served: the upload route rasterizes it to PNG and
//   only the PNGs are reachable (src/app/brand/[version]/[file]/route.ts serves
//   an allowlist of generated kinds, and the stored original is not on it). So
//   script inside an SVG cannot reach a browser from here, and stored XSS is
//   not the risk this file is about. The risk is the RASTERIZER: librsvg (via
//   sharp) resolves references, so an SVG can ask the server to read a local
//   file (`<xi:include href="/etc/…">`, `<image href="file:…">`), to fetch a URL
//   (an SSRF from the production host), or to expand entities until it runs out
//   of memory. Every rule below closes one of those doors, and anything that is
//   merely unusual in a logo is refused rather than interpreted: a mark is a few
//   shapes and gradients, and an honest export never needs what is refused here.
//
// THE RULES
//   - at most SVG_MARK_MAX_BYTES, valid UTF-8, the root element is <svg>;
//   - no DOCTYPE, no ENTITY, no other `<!…>` declaration than a comment, no
//     processing instruction but the leading XML declaration;
//   - none of the elements that load, embed or animate something (script,
//     foreignObject, image, feImage, XInclude, iframe, fonts, set/animate…);
//   - no event-handler attribute, no `src` attribute;
//   - every `href` / `xlink:href` points inside the document (`#id`);
//   - every CSS `url(…)` points inside the document (`url(#id)`), no @import;
//   - no `javascript:` / `vbscript:` / `data:` anywhere, whitespace removed first;
//   - no backslash (CSS escapes) and no character reference beyond the five
//     predefined XML entities — an escape is how a refused word is spelled so a
//     pattern does not see it;
//   - a square `viewBox` on the root, so every icon size is the same shape;
//   - at most SVG_MARK_MAX_USES `<use>` elements, and a `<use>` may not point
//     at anything that itself contains a `<use>` (reference chains are how a
//     tiny file renders millions of shapes);
//   - no filter of any kind (`<filter>`, every `fe*` primitive, the `filter`
//     attribute or CSS property), no `<pattern>`, no `<marker>`: one filter
//     primitive is a single uninterruptible call inside librsvg, and a few of
//     them chained in a 400-byte file kept a core busy for minutes;
//   - at most SVG_MARK_MAX_ELEMENTS elements and SVG_MARK_MAX_PATH_COMMANDS
//     path commands / polygon points in the whole document;
//   - the document is well-formed as far as its tags go (every `<` opens a
//     comment or a tag with quoted attributes, tags nest), and an XML
//     declaration names UTF-8 or ASCII if it names an encoding at all — the
//     bytes judged here must be the bytes the parser reads.
//
// Elements are matched on their LOCAL name, whatever namespace prefix they
// carry (`<é:image xmlns:é="…svg">` is an image), both by the pattern below
// and by the tag walk; the rasterizer itself runs in a child process with a
// hard deadline (src/lib/brandRender.ts), so these rules bound the work a
// file can ask for and the deadline bounds whatever slips past them.

export const SVG_MARK_MAX_BYTES = 512 * 1024;
export const SVG_MARK_MAX_USES = 32;
export const SVG_MARK_MAX_ELEMENTS = 2000;
export const SVG_MARK_MAX_PATH_COMMANDS = 20000;

export type SvgMarkRefusal =
  | 'too_large'
  | 'not_utf8'
  | 'not_svg'
  | 'doctype'
  | 'declaration'
  | 'processing_instruction'
  | 'forbidden_element'
  | 'event_handler'
  | 'src_attribute'
  | 'external_reference'
  | 'external_url'
  | 'css_import'
  | 'script_url'
  | 'escape'
  | 'too_many_uses'
  | 'use_nesting'
  | 'filter'
  | 'too_many_elements'
  | 'too_many_path_commands'
  | 'malformed'
  | 'encoding'
  | 'viewbox_missing'
  | 'viewbox_not_square';

export type SvgMarkVerdict = { ok: true; viewBox: [number, number, number, number] } | { ok: false; reason: SvgMarkRefusal };

const FORBIDDEN_ELEMENTS = [
  'script',
  'foreignobject',
  'image',
  'feimage',
  'include', // XInclude: <xi:include href="…" parse="text"/> reads a file
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'canvas',
  'font',
  'font-face',
  'font-face-uri',
  'font-face-src',
  'handler',
  'listener',
  'set',
  'animate',
  'animatemotion',
  'animatetransform',
  'animatecolor',
  'discard',
  'cursor',
  'link',
  'meta',
  'base',
  // Expensive to render rather than dangerous to read: see the header.
  'filter',
  'pattern',
  'marker',
];
const FORBIDDEN_SET = new Set(FORBIDDEN_ELEMENTS);

/** Whether an element's local name (prefix dropped, any case) is refused. */
function isForbiddenLocalName(local: string): boolean {
  return FORBIDDEN_SET.has(local) || /^fe[a-z]/.test(local);
}

// A namespace prefix is any run of name characters before a colon — XML allows
// letters far beyond ASCII there, so the prefix is everything that cannot end a
// name rather than a list of what may start one.
const PREFIX = `(?:[^\\s<>/:="']+:)?`;
// `<` + optional `/` + optional namespace prefix + the name, then anything that
// is not a name character (so `<fontsize` is not `<font`, but `<font-face` and
// `<font ` both are).
const FORBIDDEN_RE = new RegExp(`<\\s*/?\\s*${PREFIX}(?:${FORBIDDEN_ELEMENTS.join('|')}|fe[a-z][\\w.-]*)(?![\\w.-])`, 'i');
const USE_RE = new RegExp(`<\\s*${PREFIX}use(?![\\w.-])`, 'gi');

// One tag: `<`, optional `/`, a name, quoted attributes, optional `/`, `>`.
// Sticky, so it is tried exactly at each `<` of the document.
const TAG_RE = /<(\/?)([^\s/>="'<]+)((?:\s+[^\s=/>"'<]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTR_RE = /([^\s=/>"'<]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XML_DECL_RE = /^\s*<\?xml\s([^?]*)\?>/;
const ALLOWED_ENCODINGS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

const PREDEFINED_ENTITY = /^&(?:amp|lt|gt|quot|apos);/;

function fail(reason: SvgMarkRefusal): SvgMarkVerdict {
  return { ok: false, reason };
}

/** Decode bytes as strict UTF-8, or null. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The four numbers of a viewBox attribute, or null. */
function parseViewBox(rootTag: string): [number, number, number, number] | null {
  const m = rootTag.match(/\sviewBox\s*=\s*(["'])([^"']*)\1/);
  if (!m) return null;
  const nums = m[2].trim().split(/[\s,]+/).map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  return nums as [number, number, number, number];
}

/**
 * Walk every tag of the document (comments blanked, declaration stripped) and
 * judge what the patterns cannot: that the tags are well-formed and nest, that
 * no element is refused under any prefix, the element and path-command budget,
 * and that no `<use>` points at something that itself contains a `<use>`.
 * Returns the refusal, or null.
 */
function walkTags(doc: string): SvgMarkRefusal | null {
  const src = doc.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
  if (src.includes('<!--')) return 'malformed';
  const stack: { name: string; id: string | null; containsUse: boolean }[] = [];
  const idContainsUse = new Map<string, boolean>();
  const useTargets: string[] = [];
  let elements = 0;
  let commands = 0;
  let i = src.indexOf('<');
  while (i !== -1) {
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(src);
    if (!m) return 'malformed';
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      if (attrs || selfClosing) return 'malformed';
      const open = stack.pop();
      if (!open || open.name !== name) return 'malformed';
      if (open.id !== null) idContainsUse.set(open.id, open.containsUse);
      if (open.containsUse && stack.length) stack[stack.length - 1].containsUse = true;
    } else {
      elements += 1;
      if (elements > SVG_MARK_MAX_ELEMENTS) return 'too_many_elements';
      const local = name.slice(name.lastIndexOf(':') + 1).toLowerCase();
      if (isForbiddenLocalName(local)) return 'forbidden_element';
      const isUse = local === 'use';
      let id: string | null = null;
      for (const a of attrs.matchAll(ATTR_RE)) {
        const attrLocal = a[1].slice(a[1].lastIndexOf(':') + 1).toLowerCase();
        const value = a[2] ?? a[3] ?? '';
        if (attrLocal === 'filter') return 'filter';
        if (attrLocal === 'id') id = value.trim();
        if (attrLocal === 'd') commands += value.match(/[mlhvcsqtaz]/gi)?.length ?? 0;
        if (attrLocal === 'points') commands += Math.ceil((value.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.length ?? 0) / 2);
        if (isUse && attrLocal === 'href') useTargets.push(value.trim().slice(1));
      }
      if (commands > SVG_MARK_MAX_PATH_COMMANDS) return 'too_many_path_commands';
      if (selfClosing) {
        if (isUse) {
          if (id !== null) idContainsUse.set(id, true);
          if (stack.length) stack[stack.length - 1].containsUse = true;
        } else if (id !== null && !idContainsUse.has(id)) {
          idContainsUse.set(id, false);
        }
      } else {
        stack.push({ name, id, containsUse: isUse });
      }
    }
    i = src.indexOf('<', i + m[0].length);
  }
  if (stack.length) return 'malformed';
  // A `<use>` whose target contains a `<use>` (or is one) multiplies instead
  // of adding: refused at depth two, whatever the count.
  for (const target of useTargets) if (idContainsUse.get(target)) return 'use_nesting';
  return null;
}

/**
 * Judge an uploaded SVG mark. Accepts the raw bytes (the upload) or a string
 * (tests); a string is measured in UTF-8 bytes like the upload would be.
 */
export function validateSvgMark(input: Uint8Array | string): SvgMarkVerdict {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.length > SVG_MARK_MAX_BYTES) return fail('too_large');
  const decoded = decodeUtf8(bytes);
  if (decoded === null) return fail('not_utf8');
  const text = decoded.replace(/^﻿/, '');
  if (text.includes('\u0000')) return fail('not_utf8');

  // Declarations and processing instructions, anywhere in the file.
  if (/<!\s*doctype/i.test(text)) return fail('doctype');
  if (/<!(?!--)/.test(text)) return fail('declaration');
  // The declaration may name an encoding, and the parser obeys it: a file
  // that is valid UTF-8 here but declares UTF-7 (or any other charset) reads as
  // different characters there, so every pattern below would judge the wrong
  // text. Only an encoding that reads these bytes as these characters passes.
  const decl = text.match(XML_DECL_RE);
  if (decl) {
    const enc = decl[1].match(/encoding\s*=\s*(["'])([^"']*)\1/i);
    if (enc && !ALLOWED_ENCODINGS.has(enc[2].trim().toLowerCase())) return fail('encoding');
  }
  const withoutXmlDecl = text.replace(XML_DECL_RE, '');
  if (/<\?/.test(withoutXmlDecl)) return fail('processing_instruction');

  // Character references: only the five predefined entities. A numeric
  // reference (`&#106;avascript:`) or a named one is how a refused word hides.
  for (const m of text.matchAll(/&/g)) {
    if (!PREDEFINED_ENTITY.test(text.slice(m.index ?? 0, (m.index ?? 0) + 8))) return fail('escape');
  }
  if (text.includes('\\')) return fail('escape');

  // The root element, after the declaration and any leading comments.
  const body = withoutXmlDecl.replace(/^(?:\s*<!--[\s\S]*?-->)*\s*/, '');
  if (!/^<svg[\s>]/.test(body)) return fail('not_svg');

  if (FORBIDDEN_RE.test(text)) return fail('forbidden_element');
  if (/[\s"'/]on[a-z]+\s*=/i.test(text)) return fail('event_handler');
  if (/[\s"'/]src\s*=/i.test(text)) return fail('src_attribute');

  // Whitespace and control characters removed first: a URL parser skips them,
  // so `java\tscript:` is still `javascript:` to whoever reads the value.
  const squashed = Array.from(text)
    .filter((ch) => ch.charCodeAt(0) > 0x20)
    .join('')
    .toLowerCase();
  if (/(?:javascript|vbscript|data):/.test(squashed)) return fail('script_url');
  if (squashed.includes('@import') || squashed.includes('expression(')) return fail('css_import');

  // Every href (any prefix: href, xlink:href, a re-declared alias) is an
  // in-document fragment. Counted twice — every `href=` and every well-formed
  // quoted one — so an unquoted or oddly spelled value is refused rather than
  // skipped by the pattern that reads the values.
  const allHrefs = text.match(/href\s*=/gi)?.length ?? 0;
  const quoted = [...text.matchAll(/href\s*=\s*(["'])([^"']*)\1/gi)];
  if (quoted.length !== allHrefs) return fail('external_reference');
  for (const m of quoted) {
    if (!/^#[A-Za-z_][\w.-]*$/.test(m[2].trim())) return fail('external_reference');
  }

  // Every url(…) — in a presentation attribute or a <style> — is `url(#id)`.
  const allUrls = text.match(/url\s*\(/gi)?.length ?? 0;
  const localUrls = text.match(/url\s*\(\s*(["']?)\s*#[A-Za-z_][\w.-]*\s*\1\s*\)/gi)?.length ?? 0;
  if (allUrls !== localUrls) return fail('external_url');

  // Filters in any spelling: the attribute, the CSS property (`filter:` in a
  // style attribute or a <style> block). Whitespace is already squashed out.
  if (/filter[:=]/.test(squashed)) return fail('filter');

  if ((text.match(USE_RE)?.length ?? 0) > SVG_MARK_MAX_USES) return fail('too_many_uses');

  const structure = walkTags(withoutXmlDecl);
  if (structure) return fail(structure);

  const rootTag = body.slice(0, body.indexOf('>') + 1);
  const viewBox = parseViewBox(rootTag);
  if (!viewBox) return fail('viewbox_missing');
  const [, , w, h] = viewBox;
  if (!(w > 0 && h > 0) || Math.abs(w - h) > Math.max(w, h) * 1e-6) return fail('viewbox_not_square');

  return { ok: true, viewBox };
}
