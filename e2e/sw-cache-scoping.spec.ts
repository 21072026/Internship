import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * #1550 — the service-worker cache is shared by the whole browser profile, so
 * what it holds must be safe to hand to whoever signs in next, and a sign-out
 * has to empty it. Two defects were fixed together: authenticated responses
 * being cached, and the worker only ever registering behind login.
 *
 * This is the ONLY spec in the suite that runs with a live worker. The suite
 * blocks service workers globally (playwright.config.ts) because a request
 * served through a worker bypasses `page.route()` and silently disables the API
 * mocks other specs depend on — so the override is per-file, and every spec
 * that mocks anything must stay outside this file.
 *
 * The cheap half of the same rule (the fetch handler's decision, per request)
 * is pinned without a browser or a database in
 * scripts/test/service-worker-cache.test.mjs, which runs on every PR.
 */
test.use({ serviceWorkers: 'allow' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A cache the worker never writes, used as a sign-out tripwire: the purge
// deletes every cache on the origin, so an entry here surviving means the
// sign-out did not clear what the browser held.
const SENTINEL_CACHE = 'e2e-signed-in-sentinel';

type CacheEntry = { cache: string; path: string };

/** Every URL in every Cache API store for this origin, as seen from the page. */
async function cacheEntries(page: Page): Promise<CacheEntry[]> {
  return page.evaluate(async () => {
    const out: { cache: string; path: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) out.push({ cache: name, path: new URL(req.url).pathname });
    }
    return out;
  });
}

test('the worker registers while signed out, caches no /api response, and is purged on sign-out', async ({ page }) => {
  const email = uniqueEmail('swcache');
  const pw = 'SwCache123!';
  await seedUser(email, pw, 'MENTEE', 'SW Cache User');

  try {
    // ── Defect 2: registration used to live in the signed-in sidebars only ──
    await page.goto('/');
    await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return !!reg?.active;
      },
      null,
      { timeout: 30_000 }
    );

    // A second load is what a worker controls (it claims clients on activate,
    // but the very first document was already fetched without one).
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });

    // The offline fallback is precached at install — the whole point of having
    // a worker on the public pages.
    await expect
      .poll(async () => (await cacheEntries(page)).map((e) => e.path), { timeout: 15_000 })
      .toContain('/offline');

    // ── Defect 1: authenticated responses must not enter the cache ──────────
    await signInAndSettle(page, email, pw, '/portal');
    // A response that carries this user's own data, requested through the
    // worker (page.evaluate's fetch goes through it, unlike page.request).
    const session = await page.evaluate(async () => (await fetch('/api/auth/session')).text());
    expect(session, 'the API call itself still works through the worker').toContain(email);

    const signedIn = await cacheEntries(page);
    expect(signedIn.length, 'the worker is live and caching the shell').toBeGreaterThan(0);
    expect(signedIn.filter((e) => e.path === '/api' || e.path.startsWith('/api/'))).toEqual([]);

    // Something the sign-out has to remove, independent of what the shell
    // happens to hold at that moment.
    await page.evaluate(async (name) => {
      const c = await caches.open(name);
      await c.put('/sw-cache-sentinel', new Response('bytes cached while signed in'));
    }, SENTINEL_CACHE);
    expect((await cacheEntries(page)).some((e) => e.cache === SENTINEL_CACHE)).toBe(true);

    // ── Sign out: every cache entry for this browser goes ───────────────────
    await page.getByTestId('account-menu-button').click();
    await page.getByRole('menuitem', { name: /sign out|çıkış|abmelden/i }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/auth/signin'), { timeout: 30_000 });

    await expect
      .poll(async () => (await cacheEntries(page)).filter((e) => e.cache === SENTINEL_CACHE), {
        timeout: 15_000,
      })
      .toEqual([]);
    // Still nothing under /api/ — including from the signed-out page load.
    expect(
      (await cacheEntries(page)).filter((e) => e.path === '/api' || e.path.startsWith('/api/'))
    ).toEqual([]);
    // And the offline fallback is back, so a sign-out does not cost the
    // offline page until the next worker install.
    await expect
      .poll(async () => (await cacheEntries(page)).map((e) => e.path), { timeout: 15_000 })
      .toContain('/offline');
  } finally {
    await cleanupByEmail(email);
  }
});
