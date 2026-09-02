import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * The /release-notes RSS feed (#1383).
 *
 * The contract that matters is the HTTP one — a feed reader fetches the URL with
 * no cookies and either parses the document or shows the subscription as broken
 * — so everything here goes through `page.request`, and well-formedness is
 * checked with a real XML parser (the browser's DOMParser) instead of by string
 * matching.
 */

const repoRoot = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
// The newest release the PAGE shows: one entry per change that carries
// user-facing notes (#1275/#1457). Derived with the same code next.config.js
// uses, exactly like e2e/version-release-notes.spec.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const release = require(path.join(repoRoot, 'scripts', 'release-derive.cjs'));
const { timeline } = release.resolveRelease(repoRoot, pkg.version);
const newestNoted = [...timeline].reverse().find((entry: { notes?: unknown }) => entry.notes);
const newestCanonical = readFileSync(path.join(repoRoot, 'src', 'lib', 'releaseNotes.ts'), 'utf8')
  .match(/^\s+version: '(.+?)',$/m)?.[1];
const topEntryVersion: string = newestNoted ? newestNoted.version : newestCanonical ?? pkg.version;

/** Fetch a feed URL and report what a reader's parser would see. */
async function fetchFeed(page: Page, url: string) {
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/rss+xml');
  const xml = await res.text();

  return page.evaluate((body) => {
    const doc = new DOMParser().parseFromString(body, 'application/xml');
    const error = doc.querySelector('parsererror');
    const texts = (selector: string) =>
      Array.from(doc.querySelectorAll(selector)).map((n) => n.textContent ?? '');
    return {
      error: error ? error.textContent : null,
      root: doc.documentElement.nodeName,
      language: doc.querySelector('channel > language')?.textContent ?? null,
      self: doc.querySelector('channel > link')?.textContent ?? null,
      titles: texts('channel > item > title'),
      links: texts('channel > item > link'),
      guids: texts('channel > item > guid'),
      dates: texts('channel > item > pubDate'),
      descriptions: texts('channel > item > description'),
    };
  }, xml);
}

test('the release-notes feed is a well-formed RSS document', async ({ page }) => {
  // The page is both the subject of the next assertion and the host DOMParser
  // runs in, so it is loaded once up front.
  await page.goto('/release-notes');
  const feed = await fetchFeed(page, '/release-notes/feed.xml');

  expect(feed.error).toBeNull();
  expect(feed.root).toBe('rss');
  expect(feed.titles.length).toBeGreaterThan(0);
  expect(feed.self).toMatch(/^https?:\/\/.+\/release-notes$/);

  // The newest item is the newest release the page itself shows.
  expect(feed.titles[0]).toContain(`v${topEntryVersion}`);
  await expect(page.getByRole('heading', { name: `v${topEntryVersion}` })).toBeVisible();

  // Absolute permalinks and unique, stable GUIDs.
  expect(feed.links[0]).toMatch(/^https?:\/\/.+\/release-notes#v/);
  expect(feed.guids[0]).toMatch(/^urn:internship-crm:release:/);
  expect(new Set(feed.guids).size).toBe(feed.guids.length);

  // Publication dates come from the release data, never from the clock — and a
  // pending fragment that git cannot date (this job checks out shallow, so the
  // add-commit is the boundary) legitimately ships without one rather than with
  // an invented date. Every date that IS present must be a real RFC 822 date.
  for (const date of feed.dates) {
    expect(Number.isNaN(new Date(date).getTime())).toBe(false);
  }

  // The highlights ride along as escaped HTML: the parser hands the markup back
  // as text, which is what proves nothing leaked into the document as raw
  // `<` or `&` — the failure mode a markdown-bearing note would cause.
  expect(feed.descriptions[0]).toContain('<ul>');
  expect(feed.descriptions[0]).toContain('<li>');
});

test('the feed is localized by ?lang and linked from the page', async ({ page }) => {
  await page.goto('/release-notes');

  const en = await fetchFeed(page, '/release-notes/feed.xml');
  const tr = await fetchFeed(page, '/release-notes/feed.xml?lang=tr');
  const bogus = await fetchFeed(page, '/release-notes/feed.xml?lang=klingon');

  expect(en.language).toBe('en');
  expect(tr.language).toBe('tr');
  // Same releases, different prose.
  expect(tr.guids).toEqual(en.guids);
  expect(tr.descriptions[0]).not.toBe(en.descriptions[0]);
  // An unknown language falls back to the default rather than erroring.
  expect(bogus.language).toBe('en');

  const alternate = page.locator('link[rel="alternate"][type="application/rss+xml"]');
  await expect(alternate).toHaveCount(1);
  expect(await alternate.getAttribute('href')).toContain('/release-notes/feed.xml');
  await expect(page.getByTestId('release-notes-feed-link')).toBeVisible();
});
