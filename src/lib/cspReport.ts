// What a CSP violation report may put in a log line (#1552).
//
// Browsers post reports to /api/csp-report in two shapes: the legacy
// `report-uri` body (`application/csp-report`, `{ "csp-report": { … } }`) and
// the Reporting API batch (`application/reports+json`, an array of
// `{ type: 'csp-violation', body: { … } }`). Both are ANONYMOUS input from any
// browser, and the raw fields carry exactly what a log must not: the full page
// URL (query strings hold tokens — reset links, RSVP, unsubscribe) and a
// `script-sample` of the blocked code.
//
// So a report is reduced to the few fields that answer "what would the strict
// policy break, and where": the directive, the blocked resource as an ORIGIN or
// a keyword (inline / eval), the page as a PATH, the source file as origin+path,
// line and column. Everything else — the sample, the query, the fragment, the
// referrer, the original policy — is dropped, never logged. Dependency-free so
// the unit test runs on plain Node.

export interface CspViolation {
  directive: string;
  blocked: string;
  page: string | null;
  source: string | null;
  line: number | null;
  column: number | null;
  disposition: string | null;
}

const MAX_REPORTS = 20;
const TOKEN = /^[a-z][a-z0-9-]{0,40}$/;
const KEYWORDS = new Set(['inline', 'eval', 'wasm-eval', 'self', 'data', 'blob', 'trusted-types-policy', 'trusted-types-sink']);

/** `script-src-elem 'self' …` → `script-src-elem`; anything odd → `unknown`. */
function directiveOf(value: unknown): string {
  const first = typeof value === 'string' ? value.trim().split(/\s+/)[0]?.toLowerCase() : '';
  return first && TOKEN.test(first) ? first : 'unknown';
}

/** An absolute URL → its origin (+ path when asked); a CSP keyword stays a keyword. */
function urlPart(value: unknown, withPath: boolean): string | null {
  if (typeof value !== 'string' || !value) return null;
  const v = value.trim();
  if (KEYWORDS.has(v.toLowerCase())) return v.toLowerCase();
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return u.protocol.replace(/:$/, '');
    return withPath ? `${u.origin}${u.pathname}`.slice(0, 300) : u.origin;
  } catch {
    return null;
  }
}

function pathOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(value).pathname.slice(0, 200);
  } catch {
    return null;
  }
}

function intOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : null;
}

function str(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

function fromBody(b: Record<string, unknown>): CspViolation {
  return {
    directive: directiveOf(str(b, 'effectiveDirective', 'effective-directive', 'violatedDirective', 'violated-directive')),
    blocked: urlPart(str(b, 'blockedURL', 'blocked-uri', 'blockedURI'), false) ?? 'unknown',
    page: pathOf(str(b, 'documentURL', 'document-uri', 'documentURI')),
    source: urlPart(str(b, 'sourceFile', 'source-file'), true),
    line: intOf(str(b, 'lineNumber', 'line-number')),
    column: intOf(str(b, 'columnNumber', 'column-number')),
    disposition: (() => {
      const d = str(b, 'disposition');
      return d === 'report' || d === 'enforce' ? d : null;
    })(),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every violation in a parsed report body, sanitised; [] for anything else. */
export function parseCspReports(payload: unknown): CspViolation[] {
  if (isObject(payload) && isObject(payload['csp-report'])) return [fromBody(payload['csp-report'])];
  if (Array.isArray(payload)) {
    return payload
      .slice(0, MAX_REPORTS)
      .filter((r): r is Record<string, unknown> => isObject(r) && r.type === 'csp-violation' && isObject(r.body))
      .map((r) => fromBody(r.body as Record<string, unknown>));
  }
  return [];
}
