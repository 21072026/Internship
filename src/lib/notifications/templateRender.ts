// The renderer for admin-written notification templates (#1718) — pure,
// dependency-free, unit-tested with hostile input
// (scripts/test/notification-templates.test.mjs). The database half, and the
// resolution chain (programme → org → code default), is ./templates.ts.
//
// A STORED TEMPLATE IS UNTRUSTED INPUT. An org admin writes it, and it is
// rendered into mail that reaches people outside that admin's control. So:
//
//   • The BODY is never passed through. It is tokenised and REBUILT from an
//     allowlist: a handful of text-formatting tags, one attribute (`href` on
//     `<a>`, http/https/mailto only), every text run HTML-escaped. Whatever the
//     allowlist does not name — `<script>`, `<style>`, `<img>`, `<iframe>`,
//     `on*=` handlers, `style=`, `javascript:` / `data:` URLs — does not reach
//     the output; the contents of `<script>`/`<style>` are dropped with them.
//     There is no "sanitise the dangerous bits" step to get wrong: what leaves
//     is only what this file writes.
//   • MERGE TAGS are `{{name}}`. The allowed names for an event are exactly the
//     catalogue entry's `params` plus the fixed brand set below. A value is
//     HTML-escaped into the body and stripped of line breaks in the subject. A
//     tag outside the allowlist renders literally — it never reads a field the
//     payload did not carry, and it never reaches into an object.
//   • The SUBJECT is plain text: tags are removed, whitespace (CR/LF included)
//     collapsed, capped at 255.

export const BRAND_TAGS = ['brand.name', 'brand.url', 'recipient.firstName'] as const;
export const SUBJECT_MAX = 255;
export const BODY_MAX = 20_000;

const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote']);
const VOID_TAGS = new Set(['br']);
// Their content is code or styling, never text a reader should see.
const DROP_CONTENT = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'svg', 'math', 'textarea', 'title', 'head']);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Decode the entities an attacker would use to hide a scheme (`&#106;avascript:`). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/**
 * A link target the body may keep: http(s) or mailto, nothing else. Control
 * characters and whitespace are removed before the scheme is read, because
 * browsers ignore them inside a scheme (`java\tscript:`).
 */
export function safeHref(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const v = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!v) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!scheme) return null; // a relative link means nothing in a mail
  const s = scheme[1].toLowerCase();
  if (s !== 'http' && s !== 'https' && s !== 'mailto') return null;
  return v;
}

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// The one merge tag a link may consist of: the recipient's own app origin,
// which the server resolves (`appUrlFor(orgId)`) — never an admin-typed value.
const BRAND_URL_HREF = /^\{\{\s*brand\.url\s*\}\}$/;

function openTag(name: string, attrs: string): string {
  if (name !== 'a') return `<${name}>`;
  let href: string | null = null;
  for (const m of attrs.matchAll(ATTR)) {
    if (m[1].toLowerCase() !== 'href') continue;
    const raw = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    href = BRAND_URL_HREF.test(raw) ? '{{brand.url}}' : safeHref(raw);
  }
  return href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">` : '<a>';
}

/**
 * The body, rebuilt from the allowlist. Unclosed allowed tags are closed at
 * the end, a stray closing tag is dropped, so the output is balanced.
 */
export function sanitizeBody(input: string): string {
  const src = String(input ?? '').slice(0, BODY_MAX);
  const out: string[] = [];
  const open: string[] = [];
  let dropping: string | null = null;
  const re = /<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const text = src.slice(last, m.index);
    if (!dropping && text) out.push(escapeHtml(decodeEntities(text)));
    last = re.lastIndex;
    if (!m[1]) continue; // a comment
    const name = m[1].toLowerCase();
    const closing = m[0].startsWith('</');
    if (dropping) {
      if (closing && name === dropping) dropping = null;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!closing && !/\/\s*$/.test(m[2])) dropping = name;
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    if (VOID_TAGS.has(name)) {
      if (!closing) out.push('<br>');
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
    } else {
      out.push(openTag(name, m[2]));
      open.push(name);
    }
  }
  if (!dropping) {
    const tail = src.slice(last);
    if (tail) out.push(escapeHtml(decodeEntities(tail)));
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}

/** The subject as plain text: no tags, no line breaks, capped. */
export function sanitizeSubject(input: string): string {
  return decodeEntities(String(input ?? '').replace(/<[^>]*>/g, ''))
    .replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUBJECT_MAX);
}

export type MergeValues = Record<string, string | number | null | undefined>;

const TAG = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

/** The merge tags a template may use for an event with these params. */
export function allowedTags(params: readonly string[]): Set<string> {
  return new Set<string>([...params, ...BRAND_TAGS]);
}

/** Every `{{tag}}` named in a text, allowed or not. */
export function tagsIn(text: string): string[] {
  return [...String(text ?? '').matchAll(TAG)].map((m) => m[1]);
}

function fill(text: string, allowed: Set<string>, values: MergeValues, encode: (v: string) => string): string {
  return text.replace(TAG, (whole, name: string) => {
    if (!allowed.has(name)) return whole; // literal
    const v = values[name];
    return v === null || v === undefined ? '' : encode(String(v));
  });
}

export type RenderRefusal = 'empty_subject' | 'unknown_subject_tag' | 'empty_body';

export type RenderResult = { ok: true; subject: string; html: string } | { ok: false; reason: RenderRefusal };

/**
 * Render one stored template. Refuses — so the caller falls back to the code
 * default — when the subject would be empty, names a tag the event does not
 * have (a subject reading "{{offerAmount}}" is not a subject), or the body
 * sanitises to nothing.
 */
export function renderStoredTemplate(
  tpl: { subject: string; body: string },
  params: readonly string[],
  values: MergeValues,
): RenderResult {
  const allowed = allowedTags(params);
  const subjectSrc = sanitizeSubject(tpl.subject);
  if (tagsIn(subjectSrc).some((t) => !allowed.has(t))) return { ok: false, reason: 'unknown_subject_tag' };
  const subject = sanitizeSubject(fill(subjectSrc, allowed, values, (v) => v));
  if (!subject) return { ok: false, reason: 'empty_subject' };
  // Sanitise FIRST, then fill: a value is escaped text and can never become markup.
  const html = fill(sanitizeBody(tpl.body), allowed, values, escapeHtml);
  if (!html.replace(/<[^>]*>/g, '').trim()) return { ok: false, reason: 'empty_body' };
  return { ok: true, subject, html };
}

/** The code default's `{placeholder}` line with values filled in, as text. */
export function interpolateDefault(line: string, values: MergeValues): string {
  return line.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, k: string) => {
    const v = values[k];
    return v === null || v === undefined ? whole : String(v);
  });
}

/** The first name a `{{recipient.firstName}}` tag renders: the first word of the full name. */
export function firstNameOf(fullName: string | null | undefined): string {
  return String(fullName ?? '').trim().split(/\s+/)[0] ?? '';
}

/**
 * Which stored row applies: the programme's, else the org-wide one ('' scope),
 * else none (the code default). Only rows of the recipient's locale are ever
 * passed in — a missing locale is the code default in that locale, never
 * another language's row.
 */
export function pickTemplateRow<R extends { programId: string }>(rows: R[], programId: string | null | undefined): R | null {
  if (programId) {
    const own = rows.find((r) => r.programId === programId);
    if (own) return own;
  }
  return rows.find((r) => r.programId === '') ?? null;
}
