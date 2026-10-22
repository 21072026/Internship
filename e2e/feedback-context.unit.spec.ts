import { test, expect } from '@playwright/test';
import {
  FEEDBACK_RING_SIZE,
  RingBuffer,
  maskText,
  maskUrl,
  sanitizeFeedbackContext,
} from '../src/lib/feedbackContext';

// The masking rules of an in-app bug report (#3130): what the browser keeps
// and what the server stores pass through these, so a token or a password in
// a failed request or a console line must never survive them.

test.describe('feedback context', { tag: '@smoke' }, () => {
  test('maskUrl keeps origin + path and replaces every query value and the fragment', () => {
    expect(maskUrl('https://app.example.test/admin/users?q=ada%40example.test&page=2#top'))
      .toBe('https://app.example.test/admin/users?q=***&page=***');
    expect(maskUrl('/api/thing?token=abc&token=def')).toBe('/api/thing?token=***');
    expect(maskUrl('/plain/path')).toBe('/plain/path');
  });

  test('maskUrl drops credentials and opaque token segments', () => {
    expect(maskUrl('https://user:secret@app.example.test/x')).toBe('https://app.example.test/x');
    const token = 'a'.repeat(20) + 'B9_-' + 'c'.repeat(20);
    expect(maskUrl(`/auth/reset/${token}`)).toBe('/auth/reset/:token');
    // A cuid (25 chars) is an id the support team needs — it stays.
    expect(maskUrl('/admin/candidates/clx1abcdefghijklmnopqrstu')).toBe('/admin/candidates/clx1abcdefghijklmnopqrstu');
  });

  test('maskText removes bearer tokens, JWTs, secret pairs and e-mail addresses', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlX3Zh';
    const out = maskText(`Authorization: Bearer abc.def.ghi failed for ada@example.test with ${jwt} password=hunter2 {"token":"t0k3n"}`);
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('ada@example.test');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('t0k3n');
    expect(out).toContain('[email]');
  });

  test('maskText masks query values of URLs inside text and stringifies errors', () => {
    expect(maskText('GET https://app.example.test/api/x?key=SECRET 500')).toBe('GET https://app.example.test/api/x?key=*** 500');
    expect(maskText(new TypeError('boom'))).toBe('TypeError: boom');
    expect(maskText('x'.repeat(5000)).length).toBe(2000);
  });

  test('RingBuffer keeps only the newest entries', () => {
    const ring = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) ring.push(i);
    expect(ring.toArray()).toEqual([3, 4, 5]);
  });

  test('sanitizeFeedbackContext re-masks, caps and drops what it does not know', () => {
    const many = Array.from({ length: FEEDBACK_RING_SIZE + 5 }, (_, i) => ({
      method: 'post', url: `/api/item/${i}?secret=s${i}`, status: 500, durationMs: 12.6, requestId: 'req-1', at: '2026-10-22T10:00:00Z', extra: 'x',
    }));
    const ctx = sanitizeFeedbackContext({
      consoleErrors: [{ kind: 'weird', message: 'mail ada@example.test', stack: 'Bearer zzz', at: 'not a date' }, 'junk'],
      failedRequests: [...many, { method: 'GET;DROP', url: 'javascript:alert(1)', status: 9999, requestId: 'bad id!' }],
      evil: 'ignored',
    });
    expect(Object.keys(ctx)).toEqual(['consoleErrors', 'failedRequests']);
    expect(ctx.consoleErrors).toEqual([{ kind: 'console', message: 'mail [email]', stack: 'Bearer ***', at: '' }]);
    expect(ctx.failedRequests).toHaveLength(FEEDBACK_RING_SIZE);
    const first = ctx.failedRequests[0];
    expect(first.method).toBe('POST');
    expect(first.url).toMatch(/\?secret=\*\*\*$/);
    expect(first.durationMs).toBe(13);
    expect(first).not.toHaveProperty('extra');
    const last = ctx.failedRequests[FEEDBACK_RING_SIZE - 1];
    expect(last.status).toBe(599);
    expect(last).not.toHaveProperty('requestId');
    expect(sanitizeFeedbackContext(null)).toEqual({ consoleErrors: [], failedRequests: [] });
  });
});
