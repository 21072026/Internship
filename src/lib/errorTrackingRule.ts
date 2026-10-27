// The error tracker's rules (#1600) — dependency-free and client-safe, so the
// server adapter (`errorTracking.ts`), the browser reporter and the unit test
// all run exactly this code.
//
// PROVIDER-NEUTRAL BY PROTOCOL, NOT BY SDK. We speak the Sentry envelope
// protocol over a plain `fetch` (one POST, three NDJSON lines). That protocol
// is accepted by Sentry itself and by the self-hostable receivers that
// implement it (GlitchTip, Bugsink, …), so switching tracker is a DSN change,
// not a code change. No vendor SDK is installed: an SDK would have to be
// imported from `src/instrumentation.ts`, which Next compiles for the edge
// runtime too (see that file's header), and it would bring its own
// auto-instrumentation that collects request bodies and breadcrumbs we would
// then have to scrub after the fact.
//
// WHAT AN EVENT MAY CARRY — an allowlist, not a scrubber over everything:
//   - the error's type, its FIRST message line and its stack frames
//     (file/function/line/column) — masked by `maskText`/`maskUrl` from
//     `feedbackContext.ts`, the ONE masking path (#3130): addresses, bearer
//     tokens, JWTs, `password=`-style pairs, query values, token path segments;
//   - tags from `TAG_KEYS` only, each value in a log-safe alphabet;
//   - release (`GIT_SHA`), version, environment.
// Never: a request body, a header, a cookie, a user object, an e-mail, a name,
// a message body, CV text or a file name. Only the first line of a message
// survives because a multi-line message is where an ORM dumps the arguments of
// the failed call (`Invalid prisma.user.create() invocation: { data: { email…`).

import { maskText, maskUrl } from './feedbackContext';

export const ERROR_MESSAGE_MAX = 300;
export const ERROR_FRAMES_MAX = 40;
const TAG_VALUE_MAX = 128;

/** The only tags an event may carry. Anything else a caller passes is dropped. */
export const TAG_KEYS = [
  'source', // server | browser | job
  'route', // a route TEMPLATE (/api/users/[id]) or a masked path, never a query
  'method',
  'role',
  'orgId',
  'requestId',
  'version',
  'job',
  'attempt',
  'outcome', // job: retried | dead_letter
  'scope', // browser: which error boundary
  'digest', // Next's server error digest
] as const;
export type TagKey = (typeof TAG_KEYS)[number];
export type ErrorTags = Partial<Record<TagKey, string | number | null | undefined>>;

const TAG_VALUE = /^[A-Za-z0-9 ._:/\[\]()@-]+$/;

export type ErrorLevel = 'error' | 'warning' | 'fatal';

export interface ParsedDsn {
  /** POST target: `<origin><path>/api/<project>/envelope/`. */
  envelopeUrl: string;
  publicKey: string;
}

/**
 * A Sentry-style DSN: `https://<publicKey>@<host>[/<path>]/<projectId>`. Anything
 * else — empty, malformed, plain http to a non-local host — is `null`, and a
 * `null` DSN means the tracker is OFF: no init, no network, no console line.
 */
export function parseDsn(raw: string | undefined | null): ParsedDsn | null {
  const s = (raw || '').trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (!u.username) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const project = parts.pop();
  if (!project || !/^[A-Za-z0-9_-]+$/.test(project)) return null;
  const prefix = parts.length ? `/${parts.join('/')}` : '';
  return {
    envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`,
    publicKey: decodeURIComponent(u.username),
  };
}

export interface StackFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

// V8: "    at fn (file:1:2)" | "    at file:1:2"; Firefox/Safari: "fn@file:1:2".
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

/** Stack frames, caller first (the order the protocol wants), masked and capped. */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = V8_FRAME.exec(line) || GECKO_FRAME.exec(line);
    if (!m) continue;
    const filename = maskUrl(m[2]).slice(0, 256) || '?';
    frames.push({
      filename,
      function: maskText(m[1] || '?', 128),
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !/node_modules|^node:|\/_next\/static\/chunks\/(framework|main|webpack)/.test(filename),
    });
  }
  return frames.slice(0, ERROR_FRAMES_MAX).reverse();
}

/** The first line of a message, masked and bounded. */
export function scrubMessage(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  const first = s.split('\n', 1)[0].trim();
  return maskText(first, ERROR_MESSAGE_MAX);
}

/** One log-safe short value, or `undefined` when it is not one. */
export function safeValue(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = maskText(String(v), TAG_VALUE_MAX);
  return TAG_VALUE.test(s) && !s.includes('[email]') ? s : undefined;
}

/** Only the known tags, only log-safe values. */
export function scrubTags(tags: ErrorTags | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tags) return out;
  for (const key of TAG_KEYS) {
    const raw = tags[key];
    // A route keeps its masked path only: query keys say nothing a stack does not.
    const s = safeValue(key === 'route' && typeof raw === 'string' ? maskUrl(raw).split('?', 1)[0] : raw);
    if (s) out[key] = s;
  }
  return out;
}

export interface ErrorInput {
  /** Whatever was thrown, or a `{ name, message, stack }` from the browser. */
  error: unknown;
  level?: ErrorLevel;
  tags?: ErrorTags;
  platform?: 'node' | 'javascript';
  /** Overrides the default grouping (e.g. `['job', name]`). */
  fingerprint?: string[];
}

export interface ReleaseInfo {
  release: string;
  version: string;
  environment: string;
}

export interface TrackerEvent {
  event_id: string;
  timestamp: number;
  platform: 'node' | 'javascript';
  level: ErrorLevel;
  release: string;
  environment: string;
  transaction?: string;
  tags: Record<string, string>;
  exception: { values: { type: string; value: string; stacktrace?: { frames: StackFrame[] } }[] };
  fingerprint?: string[];
}

function errorParts(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) return { type: error.name || 'Error', message: error.message, stack: error.stack };
  if (error && typeof error === 'object') {
    const o = error as Record<string, unknown>;
    return {
      type: typeof o.name === 'string' && o.name ? o.name : 'Error',
      message: typeof o.message === 'string' ? o.message : '',
      stack: typeof o.stack === 'string' ? o.stack : undefined,
    };
  }
  return { type: 'Error', message: typeof error === 'string' ? error : String(error) };
}

/** Builds the one event that leaves the process. Everything in it went through a scrubber. */
export function buildEvent(input: ErrorInput, release: ReleaseInfo, eventId: string, now: Date): TrackerEvent {
  const { type, message, stack } = errorParts(input.error);
  const tags = scrubTags({ ...input.tags, version: release.version });
  const frames = parseStack(stack);
  const event: TrackerEvent = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: input.platform ?? 'node',
    level: input.level ?? 'error',
    release: safeValue(release.release) ?? 'unknown',
    environment: safeValue(release.environment) ?? 'production',
    tags,
    exception: {
      values: [
        {
          type: safeValue(type) ?? 'Error',
          value: scrubMessage(message),
          ...(frames.length ? { stacktrace: { frames } } : {}),
        },
      ],
    },
  };
  if (tags.route) event.transaction = tags.route;
  if (input.fingerprint?.length) {
    event.fingerprint = input.fingerprint.map((f) => scrubMessage(f).slice(0, 128)).filter(Boolean);
  }
  return event;
}

/** The NDJSON body of one envelope carrying one event. */
export function envelopeBody(event: TrackerEvent, sentAt: Date): string {
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: sentAt.toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n') + '\n';
}

export function authHeader(dsn: ParsedDsn): string {
  return `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=interncrm-tracker/1.0`;
}

/** 32 hex characters, as the protocol wants. */
export function newEventId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/**
 * Per-process flood guard: at most `limit` events per fingerprint per window.
 * A loop that throws on every request must not turn into a bill or a DoS on
 * the receiver; the tracker groups them anyway.
 */
export class EventThrottle {
  private seen = new Map<string, { count: number; since: number }>();
  constructor(
    private readonly limit = 10,
    private readonly windowMs = 60_000,
  ) {}
  allow(key: string, nowMs: number): boolean {
    const e = this.seen.get(key);
    if (!e || nowMs - e.since >= this.windowMs) {
      if (this.seen.size > 500) this.seen.clear();
      this.seen.set(key, { count: 1, since: nowMs });
      return true;
    }
    e.count += 1;
    return e.count <= this.limit;
  }
}

/** The grouping key the throttle uses: type + first frame + message. */
export function throttleKey(event: TrackerEvent): string {
  const ex = event.exception.values[0];
  const top = ex.stacktrace?.frames[ex.stacktrace.frames.length - 1];
  return `${ex.type}|${top ? `${top.filename}:${top.lineno}` : ''}|${ex.value.slice(0, 80)}|${event.tags.job ?? ''}`;
}
