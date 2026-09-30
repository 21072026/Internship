import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Share cards (#1378): a public page shared on LinkedIn, WhatsApp, Slack or X
// shows a title, a description and an image — not a bare link. The image URL
// must be ABSOLUTE (a scraper resolves nothing), and a private project's card
// must not leak its name.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function social(page: Page, path: string) {
  await page.goto(path);
  const meta = async (sel: string) =>
    (await page.locator(sel).count()) ? await page.locator(sel).first().getAttribute('content') : null;
  return {
    title: await meta('meta[property="og:title"]'),
    description: await meta('meta[property="og:description"]'),
    image: await meta('meta[property="og:image"]'),
    card: await meta('meta[name="twitter:card"]'),
    twitterImage: await meta('meta[name="twitter:image"]'),
  };
}

/** Fetch a card through the test server (the absolute URL names the configured host). */
async function png(request: APIRequestContext, absoluteOrPath: string) {
  const path = absoluteOrPath.startsWith('http') ? new URL(absoluteOrPath).pathname : absoluteOrPath;
  const res = await request.get(path);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/png');
  const body = await res.body();
  // PNG IHDR: width and height are the big-endian words at bytes 16..24.
  expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([1200, 630]);
  return body;
}

test('every shared public page carries a title, a description and an absolute 1200×630 card', async ({ page, request }) => {
  // /stories and /demo render only with published stories / in demo mode, so
  // the test environment 404s them; their cards are the same pageCard() call.
  const pages: [string, string][] = [
    ['/', '/opengraph-image'],
    ['/features', '/features/opengraph-image'],
    ['/for-companies', '/for-companies/opengraph-image'],
    ['/apply-as-mentor', '/apply-as-mentor/opengraph-image'],
    ['/release-notes', '/release-notes/opengraph-image'],
    // No card of its own: the root card, not a bare link.
    ['/privacy', '/opengraph-image'],
  ];
  const cards = new Map<string, Buffer>();
  for (const [path, cardPath] of pages) {
    const s = await social(page, path);
    expect(s.title, path).toBeTruthy();
    expect(s.description, path).toBeTruthy();
    expect(s.card, path).toBe('summary_large_image');
    expect(s.image, path).toMatch(/^https?:\/\//);
    expect(new URL(s.image!).pathname, path).toBe(cardPath);
    expect(s.twitterImage, path).toMatch(/^https?:\/\//);
    cards.set(cardPath, await png(request, s.image!));
  }
  // A page's own card is its own, not the landing's.
  expect(cards.get('/features/opengraph-image')!.equals(cards.get('/opengraph-image')!)).toBe(false);
});

test('a private project gets the generic card — its name never reaches the image', async ({ request }) => {
  const email = uniqueEmail('og-owner');
  const owner = await seedUser(email, 'OgCards123!', 'MENTOR', 'OG Owner');
  const stamp = Date.now().toString(36);
  const [priv, pub] = await Promise.all([
    prisma.project.create({ data: { name: `OG Secret ${stamp}`, ownerType: 'MENTOR', ownerUserId: owner.id, isPublic: false, technologies: ['Rust'] } }),
    prisma.project.create({ data: { name: `OG Public ${stamp}`, ownerType: 'MENTOR', ownerUserId: owner.id, isPublic: true, technologies: ['Rust'] } }),
  ]);
  try {
    const generic = await png(request, '/projects/does-not-exist/opengraph-image');
    // Private and nonexistent answer byte for byte the same: the image says
    // neither that the id exists nor what it is called.
    expect((await png(request, `/projects/${priv.id}/opengraph-image`)).equals(generic)).toBe(true);
    // A public project's card is its own.
    expect((await png(request, `/projects/${pub.id}/opengraph-image`)).equals(generic)).toBe(false);
  } finally {
    await prisma.project.deleteMany({ where: { id: { in: [priv.id, pub.id] } } });
    await cleanupByEmail(email);
  }
});
