import { test, expect } from '@playwright/test';

/**
 * /release-notes is paged: the first slice renders on the server, "Load more"
 * appends the next one, and a feed permalink past the first slice still lands
 * on its card (lib/releaseNotesPaging.ts).
 */

test('release notes load one page at a time', async ({ page }) => {
  await page.goto('/release-notes');
  const cards = page.getByTestId('release-card');
  await expect(cards).toHaveCount(20);

  await page.getByTestId('release-notes-load-more').click();
  await expect(cards).toHaveCount(40);
  await expect(page.getByTestId('release-notes-count')).toContainText('40');
});

// The scroll used to be queued with requestAnimationFrame when the fetch
// resolved, which on a busy machine ran before React committed the appended
// cards: the card loaded but the page never moved (#2750, red on CI only). The
// CPU throttle makes that ordering the normal case here — 8/8 red before the
// fix — so this guards the race rather than hoping to hit it.
test('a permalink past the first page loads down to its card', async ({ page, request }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 });

  const res = await request.get('/release-notes/entries?offset=60&limit=1');
  expect(res.status()).toBe(200);
  const { entries } = (await res.json()) as { entries: { version: string }[] };
  const version = entries[0].version;

  await page.goto(`/release-notes#v${version}`);
  const card = page.locator(`[id="v${version}"]`);
  await expect(card).toBeVisible();
  await expect(card).toBeInViewport();
});
