// The technical context of an in-app bug report (#3130) — the ONE place that
// decides what a report may carry and how it is masked. Dependency-free and
// client-safe: the browser collector (feedbackCollector.ts) masks with it
// before anything is kept, and POST /api/support/reports runs the same
// `sanitizeFeedbackContext()` again, because a request body is never trusted.
//
// Masking rules (unit-tested in e2e/feedback-context.unit.spec.ts):
//   - a URL keeps its origin + path; every query VALUE and the fragment are
//     replaced, credentials (user:pass@) dropped, and an opaque path segment of
//     32+ token characters (reset / magic-link / invite tokens) becomes `:token`;
//   - free text (console messages, stacks) loses bearer tokens, JWTs,
//     `password=`/`token=`-style pairs and e-mail addresses;
//   - every list is capped at FEEDBACK_RING_SIZE, every string at a length.

export const FEEDBACK_RING_SIZE = 20;
export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_URL_MAX = 512;
export const FEEDBACK_DESCRIPTION_MAX = 5000;
/** The serialized context a request may carry (bytes of JSON). */
export const FEEDBACK_CONTEXT_MAX_BYTES = 128 * 1024;

const MASK = '***';

export interface FeedbackConsoleError {
  /** `console.error` | `error` (window.onerror) | `unhandledrejection`. */
  kind: 'console' | 'error' | 'rejection';
  message: string;
  stack?: string;
  at: string;
}

export interface FeedbackFailedRequest {
  method: string;
  url: string;
  /** 0 = the request never got a response (network error, abort). */
  status: number;
  durationMs: number;
  requestId?: string;
  at: string;
}

export interface FeedbackContext {
  consoleErrors: FeedbackConsoleError[];
  failedRequests: FeedbackFailedRequest[];
}

/** A fixed-size FIFO: the newest `size` entries, oldest dropped first. */
export class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly size: number = FEEDBACK_RING_SIZE) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }
  toArray(): T[] {
    return [...this.items];
  }
  clear(): void {
    this.items = [];
  }
}

const TOKEN_SEGMENT = /^[A-Za-z0-9_\-.~%]{32,}$/;

/**
 * A URL with its secrets removed. Relative URLs stay relative; anything that
 * does not parse is masked whole rather than passed through.
 */
export function maskUrl(raw: string): string {
  if (!raw) return '';
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(raw);
  let u: URL;
  try {
    u = new URL(raw, 'http://relative.invalid');
  } catch {
    return MASK;
  }
  u.username = '';
  u.password = '';
  u.hash = '';
  u.pathname = u.pathname
    .split('/')
    .map((seg) => (TOKEN_SEGMENT.test(seg) ? ':token' : seg))
    .join('/');
  const keys = [...new Set(u.searchParams.keys())];
  const query = keys.length ? `?${keys.map((k) => `${encodeURIComponent(k)}=${MASK}`).join('&')}` : '';
  const out = relative ? `${u.pathname}${query}` : `${u.origin}${u.pathname}${query}`;
  return out.slice(0, FEEDBACK_URL_MAX);
}

const TEXT_RULES: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK],
  [/\b(pass(?:word)?|pwd|secret|token|api[_-]?key|authorization|cookie|session)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, `$1$2${MASK}`],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

/** Free text (a console message, a stack) with credentials and addresses removed. */
export function maskText(raw: unknown, max: number = FEEDBACK_TEXT_MAX): string {
  let s = typeof raw === 'string' ? raw : raw instanceof Error ? `${raw.name}: ${raw.message}` : safeString(raw);
  // URLs inside the text get the URL rule first, so their query values go too.
  s = s.replace(/https?:\/\/[^\s"'<>)]+/g, (m) => maskUrl(m));
  for (const [re, to] of TEXT_RULES) s = s.replace(re, to);
  return s.slice(0, max);
}

function safeString(v: unknown): string {
  if (v === undefined) return 'undefined';
  try {
    return typeof v === 'object' ? JSON.stringify(v) ?? String(v) : String(v);
  } catch {
    return String(v);
  }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v: unknown, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(hi, Math.max(lo, n));
}

function isoOr(v: unknown): string {
  const s = str(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : '';
}

const KINDS = new Set(['console', 'error', 'rejection']);
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Normalises an untrusted context object: unknown keys dropped, lists capped
 * to the newest FEEDBACK_RING_SIZE, every string bounded and masked again.
 */
export function sanitizeFeedbackContext(raw: unknown): FeedbackContext {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(-FEEDBACK_RING_SIZE) : []);
  const consoleErrors = list(obj.consoleErrors)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => {
      const out: FeedbackConsoleError = {
        kind: (KINDS.has(e.kind as string) ? e.kind : 'console') as FeedbackConsoleError['kind'],
        message: maskText(str(e.message, FEEDBACK_TEXT_MAX * 2)),
        at: isoOr(e.at),
      };
      const stack = str(e.stack, FEEDBACK_TEXT_MAX * 2);
      if (stack) out.stack = maskText(stack);
      return out;
    });
  const failedRequests = list(obj.failedRequests)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => {
      const out: FeedbackFailedRequest = {
        method: str(e.method, 10).toUpperCase().match(/^[A-Z]+$/)?.[0] ?? 'GET',
        url: maskUrl(str(e.url, FEEDBACK_URL_MAX * 4)),
        status: num(e.status, 0, 599),
        durationMs: num(e.durationMs, 0, 10 * 60 * 1000),
        at: isoOr(e.at),
      };
      const rid = str(e.requestId, 128);
      if (REQUEST_ID.test(rid)) out.requestId = rid;
      return out;
    });
  return { consoleErrors, failedRequests };
}
