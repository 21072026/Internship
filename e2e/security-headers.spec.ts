import { test, expect } from '@playwright/test';

test('responses carry the security headers', async ({ request }) => {
  const res = await request.get('/');
  const h = res.headers();
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['content-security-policy']).toContain("default-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  // camera/microphone/display-capture are delegated to the app itself and to the
  // embedded Jitsi room only (the meeting panel needs them); a blanket
  // `camera=()` would leave that iframe with a picture of nobody. What matters
  // here is that the allow-lists stay pinned to meet.jit.si — never `*` — and
  // that geolocation is still denied outright.
  const permissions = h['permissions-policy'];
  expect(permissions).toContain('camera=(self "https://meet.jit.si")');
  expect(permissions).toContain('microphone=(self "https://meet.jit.si")');
  expect(permissions).toContain('display-capture=(self "https://meet.jit.si")');
  expect(permissions).toContain('geolocation=()');
  expect(permissions).not.toContain('*');
});

test('home page still renders without console errors under CSP', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Companies that want experience/i })).toBeVisible();
  expect(errors).toEqual([]);
});
