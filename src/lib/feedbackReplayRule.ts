// Session replay for a bug report (#3131) — the pure rules, dependency-free so
// the browser recorder, the report route and the unit test read the same ones
// (e2e/feedback-replay.unit.spec.ts). Design: docs/feedback-reports.md § Replay.
//
//   - the switch: FEEDBACK_REPLAY_ENABLED `1`/`true` on, `0`/`false` off, unset
//     = on in a preview build and OFF in production, so turning it on for real
//     users is a deliberate env change, never a side effect of a deploy;
//   - the window: FEEDBACK_REPLAY_SECONDS (default 90, clamped 30…300);
//   - the buffer: rrweb takes a full snapshot every window/3 (`checkoutEveryNms`)
//     and each snapshot opens a segment; only segments still needed to cover
//     the window are kept, so memory stays bounded and a replay always starts
//     on a full snapshot it can render;
//   - the upload: gzip, at most FEEDBACK_REPLAY_MAX_BYTES, and it must decode
//     to rrweb events that contain a full snapshot.

export const FEEDBACK_REPLAY_DEFAULT_SECONDS = 90;
export const FEEDBACK_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
/** Decompressed ceiling the server accepts (a gzip bomb stops here). */
export const FEEDBACK_REPLAY_MAX_JSON_BYTES = 80 * 1024 * 1024;

/** rrweb's EventType numbers we rely on (stable since rrweb 1.0). */
export const RR_FULL_SNAPSHOT = 2;
export const RR_META = 4;
export const RR_CUSTOM = 5;

export interface ReplayConfig {
  enabled: boolean;
  seconds: number;
}

export function replayConfig(env: Record<string, string | undefined>, appEnv: 'production' | 'preview'): ReplayConfig {
  const raw = (env.FEEDBACK_REPLAY_ENABLED ?? '').trim().toLowerCase();
  const enabled = raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : appEnv === 'preview';
  const n = Number.parseInt(env.FEEDBACK_REPLAY_SECONDS ?? '', 10);
  const seconds = Number.isFinite(n) ? Math.min(300, Math.max(30, n)) : FEEDBACK_REPLAY_DEFAULT_SECONDS;
  return { enabled, seconds };
}

export function checkoutEveryMs(seconds: number): number {
  return Math.round((seconds * 1000) / 3);
}

export interface ReplayEvent {
  type: number;
  timestamp: number;
  [key: string]: unknown;
}

/**
 * The rolling buffer: segments of events, each opened by a full snapshot.
 * `push` with `isCheckout` (rrweb's second emit argument) starts a segment.
 */
export class ReplayBuffer {
  private segments: ReplayEvent[][] = [];
  constructor(private readonly windowMs: number) {}

  push(event: ReplayEvent, isCheckout?: boolean): void {
    if (isCheckout || this.segments.length === 0) this.segments.push([]);
    this.segments[this.segments.length - 1].push(event);
    this.trim(event.timestamp);
  }

  /** Drops segments wholly older than the window, keeping one that starts before it. */
  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.segments.length > 1 && (this.segments[1][0]?.timestamp ?? Infinity) <= cutoff) {
      this.segments.shift();
    }
  }

  /** The events covering (at least) the window, oldest first. */
  export(now: number = Date.now()): ReplayEvent[] {
    this.trim(now);
    return this.segments.flat();
  }

  clear(): void {
    this.segments = [];
  }

  get size(): number {
    return this.segments.reduce((n, s) => n + s.length, 0);
  }
}

export type ReplayRefusal = 'not_array' | 'too_few' | 'bad_event' | 'no_snapshot';

/** Shape check of a decoded upload: rrweb events, with something to render. */
export function checkReplayEvents(value: unknown): ReplayRefusal | null {
  if (!Array.isArray(value)) return 'not_array';
  if (value.length < 2) return 'too_few';
  for (const e of value) {
    if (!e || typeof e !== 'object') return 'bad_event';
    const { type, timestamp } = e as Record<string, unknown>;
    if (typeof type !== 'number' || !Number.isInteger(type) || type < 0 || type > 6) return 'bad_event';
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'bad_event';
  }
  if (!value.some((e) => (e as ReplayEvent).type === RR_FULL_SNAPSHOT)) return 'no_snapshot';
  return null;
}

/** Is this the gzip magic number? */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export interface TimelineMark {
  tag: 'console' | 'network' | 'submit';
  at: number;
  label: string;
}

/**
 * The report's console errors and failed requests as rrweb custom events, so
 * the player's timeline marks them; marks outside the recording are dropped.
 */
export function withTimelineMarks(events: ReplayEvent[], marks: TimelineMark[]): ReplayEvent[] {
  if (events.length === 0) return events;
  const first = events[0].timestamp;
  const last = events[events.length - 1].timestamp;
  const extra = marks
    .filter((m) => Number.isFinite(m.at) && m.at >= first && m.at <= last)
    .map((m) => ({ type: RR_CUSTOM, timestamp: m.at, data: { tag: m.tag, payload: { label: m.label } } }));
  return [...events, ...extra].sort((a, b) => a.timestamp - b.timestamp);
}
