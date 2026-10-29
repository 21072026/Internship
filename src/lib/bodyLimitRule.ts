/**
 * The request-body ceiling for JSON writes to /api/* (#3210) — pure, so the
 * edge middleware and a browserless unit spec read the same rule.
 *
 * WHY
 *   App Router handlers call `request.json()` with no size limit, and nothing
 *   in front of the app sets one either. Any public write route could be sent
 *   a body large enough to exhaust memory before a single zod check runs —
 *   GHSA-mrhx-c7xc-m3w5 (zod 3, "memory exhaustion while validating oversized
 *   constrained collections") is the sharp edge of that, but the gap is the
 *   unbounded body itself. This rule closes the declared-length half of it.
 *
 * WHAT IT CAN AND CANNOT SEE
 *   Middleware sees headers, not the stream. A body sent with `Content-Length`
 *   is judged before the handler buffers a byte; a chunked body (no length)
 *   passes, because refusing every chunked request would break legitimate
 *   clients. The complete fix is a cap at the reverse proxy — Caddy
 *   `request_body { max_size … }`, runbook in infra/README.md § Request body
 *   limit — which sees the real byte count. This is the half the app can own.
 *
 * THE NUMBERS
 *   1 MiB by default: the largest non-admin JSON body in the tree is a few
 *   5 000-character text fields, so a megabyte is two orders of magnitude of
 *   headroom. `/api/admin/*` gets 32 MiB because the admin importers take a
 *   whole CSV as a JSON string (migration: four sheets × 1.5 M chars; affiliate
 *   migration: 10 M chars, up to 3 bytes each in UTF-8) and are ADMIN-only.
 *   Both are overridable per deployment, never loosened by a request.
 *
 * Only JSON and text bodies are judged: multipart uploads carry their own
 * per-file limits in their handlers (documents, CV, avatar, attachments), and
 * the feedback replay is multipart with its own 80 MB decode ceiling.
 */

export const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;
export const DEFAULT_ADMIN_JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Env = Record<string, string | undefined>;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function jsonBodyLimitFor(pathname: string, env: Env): number {
  return pathname.startsWith('/api/admin/')
    ? positiveInt(env.JSON_BODY_MAX_BYTES_ADMIN, DEFAULT_ADMIN_JSON_BODY_MAX_BYTES)
    : positiveInt(env.JSON_BODY_MAX_BYTES, DEFAULT_JSON_BODY_MAX_BYTES);
}

function isJudgedContentType(contentType: string | null): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  // An absent type is judged too: `request.json()` parses whatever arrives.
  return type === '' || type === 'application/json' || type.endsWith('+json') || type.startsWith('text/');
}

export type BodyLimitVerdict = { ok: true } | { ok: false; status: 413; limit: number };

export function bodyLimitVerdict(input: {
  method: string;
  pathname: string;
  contentType: string | null;
  contentLength: string | null;
  env: Env;
}): BodyLimitVerdict {
  if (!input.pathname.startsWith('/api/') || !WRITE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  if (!isJudgedContentType(input.contentType)) return { ok: true };
  const declared = Number(input.contentLength);
  // No length (chunked) or a malformed one: not ours to judge — see the header.
  if (input.contentLength === null || !Number.isFinite(declared) || declared < 0) return { ok: true };
  const limit = jsonBodyLimitFor(input.pathname, input.env);
  return declared > limit ? { ok: false, status: 413, limit } : { ok: true };
}
