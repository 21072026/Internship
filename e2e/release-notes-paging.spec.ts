import { test, expect } from '@playwright/test';

/**
 * /release-notes is paged: the first slice renders on the server, "Load more"
 * appends the next one, and a feed permalink past the first slice still lands
 * on its card (lib/releaseNotesPaging.ts).
 */

test('release notes load one page at a time', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/release-notes');
  const cards = page.getByTestId('release-card');
  await expect(cards).toHaveCount(20);

  await page.getByTestId('release-notes-load-more').click();
  await expect(cards).toHaveCount(40);
  await expect(page.getByTestId('release-notes-count')).toContainText('40');
});

test('a permalink past the first page loads down to its card', async ({ page, request }) => {
  const res = await request.get('/release-notes/entries?offset=60&limit=1');
  expect(res.status()).toBe(200);
  const { entries } = (await res.json()) as { entries: { version: string }[] };
  const version = entries[0].version;

  await page.goto(`/release-notes#v${version}`);
  const card = page.locator(`[id="v${version}"]`);
  await expect(card).toBeVisible();
  await expect(card).toBeInViewport();
});
