import { test, expect } from '@playwright/test';

// The forgot-password endpoint is limited to 5 requests / 15 min per IP.
test('repeated forgot-password requests are rate limited (429)', async ({ request }) => {
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await request.post('/api/auth/forgot', {
      data: { email: `flood-${i}@example.com` },
    });
    statuses.push(res.status());
  }
  expect(statuses).toContain(200); // early requests pass
  expect(statuses).toContain(429); // later ones are throttled
});
