// Browser half of the bug-report context (#3130): from the moment a signed-in
// page mounts the feedback widget, the newest FEEDBACK_RING_SIZE console
// errors and failed requests are kept IN MEMORY, already masked by
// feedbackContext.ts. Nothing here touches the network — the buffer leaves the
// tab only inside a report the person chooses to send.
//
// Installed once per page (a global flag), never uninstalled: patching
// console/fetch twice would record every event twice, and unpatching under a
// still-running request would lose its outcome.

import {
  RingBuffer,
  maskText,
  maskUrl,
  type FeedbackConsoleError,
  type FeedbackContext,
  type FeedbackFailedRequest,
} from '@/lib/feedbackContext';

/** The report endpoint itself is never recorded — a failed send is not a symptom. */
const OWN_ENDPOINT = '/api/support/reports';

const consoleErrors = new RingBuffer<FeedbackConsoleError>();
// Raised while the widget takes a screenshot: the capture library fetches the
// page's own images and fonts, and a miss there is not the reported problem.
let paused = 0;
const failedRequests = new RingBuffer<FeedbackFailedRequest>();

type Flagged = typeof globalThis & { __feedbackCollector?: true };

function recordError(kind: FeedbackConsoleError['kind'], value: unknown, stack?: unknown) {
  const entry: FeedbackConsoleError = { kind, message: maskText(value), at: new Date().toISOString() };
  const s = typeof stack === 'string' ? stack : value instanceof Error ? value.stack : undefined;
  if (s) entry.stack = maskText(s);
  consoleErrors.push(entry);
}

function requestParts(input: RequestInfo | URL, init?: RequestInit): { method: string; url: string } {
  if (typeof input === 'string') return { method: init?.method ?? 'GET', url: input };
  if (input instanceof URL) return { method: init?.method ?? 'GET', url: input.href };
  return { method: init?.method ?? input.method ?? 'GET', url: input.url };
}

export function installFeedbackCollector(): void {
  if (typeof window === 'undefined') return;
  const g = globalThis as Flagged;
  if (g.__feedbackCollector) return;
  g.__feedbackCollector = true;

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const first = args.find((a): a is Error => a instanceof Error);
      // Each argument through maskText(), which stringifies objects and Errors.
      recordError('console', args.map((a) => maskText(a)).join(' '), first?.stack);
    } catch {
      // never let the recorder break the call it wraps
    }
    originalError(...args);
  };

  window.addEventListener('error', (e) => {
    recordError('error', e.error ?? e.message, e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (e) => {
    recordError('rejection', e.reason);
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now();
    const { method, url } = requestParts(input, init);
    const own = url.includes(OWN_ENDPOINT) || paused > 0;
    try {
      const res = await originalFetch(input, init);
      if (!res.ok && !own) {
        failedRequests.push({
          method: method.toUpperCase(),
          url: maskUrl(url),
          status: res.status,
          durationMs: Math.round(performance.now() - started),
          requestId: res.headers.get('x-request-id') ?? undefined,
          at: new Date().toISOString(),
        });
      }
      return res;
    } catch (err) {
      if (!own) {
        failedRequests.push({
          method: method.toUpperCase(),
          url: maskUrl(url),
          status: 0,
          durationMs: Math.round(performance.now() - started),
          at: new Date().toISOString(),
        });
      }
      throw err;
    }
  };
}

/** Runs `fn` without recording its failed requests (the screenshot capture). */
export async function withRecordingPaused<T>(fn: () => Promise<T>): Promise<T> {
  paused += 1;
  try {
    return await fn();
  } finally {
    paused -= 1;
  }
}

/** What a report sends: a copy of both buffers at the moment of the call. */
export function snapshotFeedbackContext(): FeedbackContext {
  return { consoleErrors: consoleErrors.toArray(), failedRequests: failedRequests.toArray() };
}
