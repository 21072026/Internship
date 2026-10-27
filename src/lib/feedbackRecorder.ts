// Browser half of the session replay (#3131): rrweb records the page into
// IN-MEMORY buffers (feedbackReplayRule.ts) for as long as a signed-in screen
// is open. Nothing is sent anywhere — a recording leaves the tab only as the
// gzip attached to a report the person chooses to send, after they could
// preview it.
//
// Two kinds of recording, from one rrweb session:
//   - the rolling window: always on, the last ~90 s, what a report attaches
//     by default;
//   - a manual recording: the person presses "Start recording", does what
//     breaks, presses "Stop" — everything in between (up to 20 minutes), from
//     a full snapshot taken at the start.
//
// What rrweb never sees: every input's value (`maskAllInputs`), and anything
// blocked — `.rr-block`, `[data-private]` and the feedback UI itself
// (`[data-feedback-ui]`), which replay as an empty box of the same size.

import {
  ManualRecording,
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
let manual: ManualRecording | null = null;
let onManualFull: (() => void) | null = null;
let stop: (() => void) | undefined;
let snapshot: ((isCheckout?: boolean) => void) | undefined;
let starting = false;

export async function startFeedbackRecorder(config: ReplayConfig): Promise<void> {
  if (typeof window === 'undefined' || !config.enabled || buffer || starting) return;
  starting = true;
  try {
    const { record } = await import('@rrweb/record');
    const local = new ReplayBuffer(config.seconds * 1000);
    buffer = local;
    snapshot = record.takeFullSnapshot;
    stop = record({
      emit: (raw, isCheckout) => {
        const event = raw as unknown as ReplayEvent;
        local.push(event, isCheckout);
        if (manual && !manual.push(event) && manual.full && onManualFull) {
          const notify = onManualFull;
          onManualFull = null; // once
          notify();
        }
      },
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

/** Stops recording and forgets every buffer (sign-out). */
export function stopFeedbackRecorder(): void {
  stop?.();
  stop = undefined;
  snapshot = undefined;
  buffer?.clear();
  buffer = null;
  manual = null;
  onManualFull = null;
}

export function isRecorderRunning(): boolean {
  return !!stop;
}

/** The rolling window as it is now, frozen — what a report attaches by default. */
export function freezeRollingWindow(): ReplayEvent[] | null {
  const events = buffer?.export() ?? [];
  return events.length > 1 ? events : null;
}

/**
 * Starts a manual recording from a fresh full snapshot. `whenFull` runs once
 * if it reaches its 20-minute limit, so the widget can stop it.
 */
export function startManualRecording(whenFull: () => void): boolean {
  if (!stop || !snapshot || manual) return false;
  manual = new ManualRecording(Date.now());
  onManualFull = whenFull;
  // isCheckout = true: the rolling buffer opens a segment here too, so both
  // start on the same renderable snapshot.
  snapshot(true);
  return true;
}

export function manualElapsedMs(): number | null {
  return manual ? manual.elapsed(Date.now()) : null;
}

/** Stops the manual recording and hands back its events, frozen. */
export function stopManualRecording(): ReplayEvent[] | null {
  const events = manual?.freeze() ?? null;
  manual = null;
  onManualFull = null;
  return events && events.length > 1 ? events : null;
}

/** A frozen recording as the gzip a report carries, with a mark where it was sent. */
export async function packReplay(events: ReplayEvent[]): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined' || events.length < 2) return null;
  const marked = [...events, { type: RR_CUSTOM, timestamp: Date.now(), data: { tag: 'submit', payload: {} } }];
  const stream = new Blob([JSON.stringify(marked)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob().then((b) => new Blob([b], { type: 'application/gzip' }));
}
