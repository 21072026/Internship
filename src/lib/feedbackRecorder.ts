// Browser half of the session replay (#3131): rrweb records the page into an
// IN-MEMORY rolling buffer (feedbackReplayRule.ts) for as long as a signed-in
// screen is open. Nothing is sent anywhere — the buffer leaves the tab only as
// the gzip attached to a report the person chooses to send, and only when they
// leave "attach the last ~90 seconds" ticked.
//
// What rrweb never sees: every input's value (`maskAllInputs`), and anything
// blocked — `.rr-block`, `[data-private]` and the feedback panel itself
// (`[data-feedback-ui]`), which replay as an empty box of the same size.

import {
  ReplayBuffer,
  checkoutEveryMs,
  RR_CUSTOM,
  type ReplayConfig,
  type ReplayEvent,
} from '@/lib/feedbackReplayRule';

// The last entry is the screenshot library's scratch iframe (feedbackScreenshot.ts):
// modern-screenshot appends `iframe#__SANDBOX__<uuid>` to <body> and builds a
// sample of every tag inside it, which rrweb — recording same-origin iframes —
// otherwise copied into the buffer on every capture.
const BLOCK_SELECTOR = '[data-private], [data-feedback-ui], iframe[id^="__SANDBOX__"]';

let buffer: ReplayBuffer | null = null;
let stop: (() => void) | undefined;
let starting = false;

export async function startFeedbackRecorder(config: ReplayConfig): Promise<void> {
  if (typeof window === 'undefined' || !config.enabled || buffer || starting) return;
  starting = true;
  try {
    const { record } = await import('@rrweb/record');
    const local = new ReplayBuffer(config.seconds * 1000);
    buffer = local;
    stop = record({
      emit: (event, isCheckout) => local.push(event as unknown as ReplayEvent, isCheckout),
      checkoutEveryNms: checkoutEveryMs(config.seconds),
      maskAllInputs: true,
      blockClass: 'rr-block',
      blockSelector: BLOCK_SELECTOR,
      // No canvas pixels, no inlined images or fonts: smaller, and an image
      // the page fetched with credentials is not copied into the recording.
      recordCanvas: false,
      inlineImages: false,
      collectFonts: false,
      slimDOMOptions: 'all',
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
    }) ?? undefined;
  } catch {
    buffer = null;
  } finally {
    starting = false;
  }
}

/** Stops recording and forgets the buffer (sign-out). */
export function stopFeedbackRecorder(): void {
  stop?.();
  stop = undefined;
  buffer?.clear();
  buffer = null;
}

export function hasReplay(): boolean {
  return (buffer?.size ?? 0) > 1;
}

/** The window as a gzip file, with a mark where the report was sent. */
export async function exportReplay(): Promise<Blob | null> {
  if (!buffer || typeof CompressionStream === 'undefined') return null;
  const events = buffer.export();
  if (events.length < 2) return null;
  const now = Date.now();
  events.push({ type: RR_CUSTOM, timestamp: now, data: { tag: 'submit', payload: {} } });
  const stream = new Blob([JSON.stringify(events)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob().then((b) => new Blob([b], { type: 'application/gzip' }));
}
