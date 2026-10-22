import { test, expect } from '@playwright/test';
import {
  ReplayBuffer,
  checkReplayEvents,
  checkoutEveryMs,
  isGzip,
  replayConfig,
  withTimelineMarks,
  RR_CUSTOM,
  RR_FULL_SNAPSHOT,
  RR_META,
} from '../src/lib/feedbackReplayRule';

// The session-replay rules of a bug report (#3131): the switch, the rolling
// window and what the server accepts.

const ev = (type: number, timestamp: number) => ({ type, timestamp });

test.describe('feedback replay rules', { tag: '@smoke' }, () => {
  test('the switch is off in production unless set, on in preview unless set', () => {
    expect(replayConfig({}, 'production').enabled).toBe(false);
    expect(replayConfig({}, 'preview').enabled).toBe(true);
    expect(replayConfig({ FEEDBACK_REPLAY_ENABLED: '1' }, 'production').enabled).toBe(true);
    expect(replayConfig({ FEEDBACK_REPLAY_ENABLED: 'false' }, 'preview').enabled).toBe(false);
    expect(replayConfig({ FEEDBACK_REPLAY_ENABLED: 'maybe' }, 'production').enabled).toBe(false);
  });

  test('the window defaults to 90 s, clamps to 30…300, and checkouts come every third', () => {
    expect(replayConfig({}, 'preview').seconds).toBe(90);
    expect(replayConfig({ FEEDBACK_REPLAY_SECONDS: '5' }, 'preview').seconds).toBe(30);
    expect(replayConfig({ FEEDBACK_REPLAY_SECONDS: '9999' }, 'preview').seconds).toBe(300);
    expect(checkoutEveryMs(90)).toBe(30_000);
  });

  test('the buffer keeps the window, always starting on a full snapshot', () => {
    const buf = new ReplayBuffer(90_000);
    // A full snapshot every 30 s, one event per second in between, for 4 minutes.
    for (let t = 0; t <= 240_000; t += 1000) {
      const checkout = t > 0 && t % 30_000 === 0;
      buf.push(ev(checkout || t === 0 ? RR_FULL_SNAPSHOT : 3, t), checkout);
    }
    const out = buf.export(240_000);
    expect(out[0].type).toBe(RR_FULL_SNAPSHOT);
    // Covers at least the window, and at most one checkout interval more.
    expect(240_000 - out[0].timestamp).toBeGreaterThanOrEqual(90_000);
    expect(240_000 - out[0].timestamp).toBeLessThanOrEqual(120_000);
    expect(buf.size).toBe(out.length);
    buf.clear();
    expect(buf.export(240_000)).toEqual([]);
  });

  test('the server accepts rrweb events with a full snapshot, nothing else', () => {
    expect(checkReplayEvents([ev(RR_META, 1), ev(RR_FULL_SNAPSHOT, 2), ev(3, 3)])).toBeNull();
    expect(checkReplayEvents({})).toBe('not_array');
    expect(checkReplayEvents([ev(RR_META, 1)])).toBe('too_few');
    expect(checkReplayEvents([ev(RR_META, 1), ev(3, 2)])).toBe('no_snapshot');
    expect(checkReplayEvents([ev(RR_META, 1), { type: 'x', timestamp: 2 }])).toBe('bad_event');
    expect(checkReplayEvents([ev(RR_META, 1), ev(99, 2)])).toBe('bad_event');
    expect(isGzip(new Uint8Array([0x1f, 0x8b, 8]))).toBe(true);
    expect(isGzip(new Uint8Array([0x7b, 0x22, 0x61]))).toBe(false);
  });

  test('timeline marks land inside the recording, in order', () => {
    const events = [ev(RR_META, 100), ev(RR_FULL_SNAPSHOT, 100), ev(3, 500)];
    const out = withTimelineMarks(events, [
      { tag: 'console', at: 300, label: 'boom' },
      { tag: 'network', at: 50, label: 'too early' },
      { tag: 'network', at: Number.NaN, label: 'no time' },
    ]);
    expect(out.map((e) => e.timestamp)).toEqual([100, 100, 300, 500]);
    expect(out[2]).toMatchObject({ type: RR_CUSTOM, data: { tag: 'console', payload: { label: 'boom' } } });
  });
});
