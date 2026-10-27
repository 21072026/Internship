import { test, expect } from '@playwright/test';
import {
  FEEDBACK_MANUAL_MAX_MS,
  ManualRecording,
  ReplayBuffer,
  checkReplayEvents,
  formatReplayDuration,
  formatReplaySize,
  replayDurationMs,
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

  test('a manual recording keeps everything until its 20-minute limit, then refuses', () => {
    const rec = new ManualRecording(1_000);
    expect(rec.push(ev(RR_FULL_SNAPSHOT, 1_000))).toBe(true);
    expect(rec.push(ev(3, 1_000 + FEEDBACK_MANUAL_MAX_MS))).toBe(true);
    expect(rec.full).toBe(false);
    expect(rec.push(ev(3, 1_001 + FEEDBACK_MANUAL_MAX_MS))).toBe(false);
    expect(rec.full).toBe(true);
    expect(rec.push(ev(3, 1_002 + FEEDBACK_MANUAL_MAX_MS))).toBe(false);
    const frozen = rec.freeze();
    expect(frozen).toHaveLength(2);
    // Frozen means frozen: the returned array is a copy.
    frozen.push(ev(3, 9));
    expect(rec.freeze()).toHaveLength(2);
    expect(rec.elapsed(1_000 + 5 * 60_000)).toBe(5 * 60_000);
    expect(rec.elapsed(1_000 + 99 * 60_000)).toBe(FEEDBACK_MANUAL_MAX_MS);
  });

  test('duration and size read the way the panel shows them', () => {
    expect(formatReplayDuration(0)).toBe('0:00');
    expect(formatReplayDuration(95_400)).toBe('1:35');
    expect(formatReplayDuration(20 * 60_000)).toBe('20:00');
    expect(formatReplaySize(300 * 1024, 'en')).toBe('300 KB');
    expect(formatReplaySize(2.5 * 1024 * 1024, 'de')).toBe('2,5 MB');
    expect(replayDurationMs([ev(4, 10), ev(2, 10), ev(3, 4010)])).toBe(4000);
    expect(replayDurationMs([ev(4, 10)])).toBe(0);
  });
});
