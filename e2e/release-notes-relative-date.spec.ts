import { test, expect } from '@playwright/test';

/**
 * A release says how long ago it shipped ("3 hr. ago", "8 days ago") and keeps
 * the stamp it was derived from one hover away (#1457's "2026-08-25 09:25 UTC").
 * Public page, no sign-in; the runner's locale is pinned to en-US.
 */
test('a release reads as a distance, with its UTC stamp on hover', async ({ page }) => {
  await page.goto('/release-notes');
  const newest = page.getByTestId('release-card').first().getByTestId('release-date');

  // The newest release was stamped to the minute, so its hover names the minute.
  await expect(newest).toHaveAttribute('title', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  await expect(newest).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  // A distance, not a date: no "2026-" left in the visible text.
  await expect(newest).toHaveText(/\b(ago|now|yesterday)\b|^in /);
  await expect(newest).not.toHaveText(/\d{4}-\d{2}-\d{2}/);

  // The stamp and the distance describe the same instant.
  const title = await newest.getAttribute('title');
  const datetime = await newest.getAttribute('datetime');
  expect(datetime?.slice(0, 16).replace('T', ' ')).toBe(title?.replace(' UTC', ''));
});
