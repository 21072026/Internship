import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * The public sub-pages a marketing visitor can still click through to
 * (#2475 for /features and /pricing, #2457 for /projects).
 *
 * #2474 dressed the marketing landing itself, but /features listed the whole
 * internship catalogue, /pricing stated the internship price model ("free for
 * mentees and mentors", the active matched pair) and /projects mixed every
 * tenant's public projects into one grid. All three are sessionless, so the
 * only signal is the request host — `MARKETING_HOSTS` defaults to
 * `marketing.bcsit-gmbh.de`, which is why forging `x-forwarded-host` routes the
 * marketing vertical here without an env change (same trick as
 * `host-vertical-landing.spec.ts`).
 *
 * Every assertion is about RENDERED CONTENT — the lesson `pricing.spec.ts`
 * records from #2296: a URL that changed proves nothing about the page.
 */

const MARKETING_HOST = 'marketing.bcsit-gmbh.de';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// ── /features ────────────────────────────────────────────────────────────────

test('the internship host still gets the whole feature catalogue', async ({ page }) => {
  await page.goto('/features');
  await expect(page.getByRole('heading', { name: 'Everything InternshipCRM can do' })).toBeVisible();
  // One card from each capability the marketing vertical does not carry, so a
  // tag accidentally applied to the WRONG vertical fails here rather than
  // silently emptying the live product's catalogue.
  await expect(page.getByText('Self-serve mentee intake', { exact: true })).toBeVisible();
  await expect(page.getByText('Weekly internship reports', { exact: true })).toBeVisible();
  await expect(page.getByText('Offer management', { exact: true })).toBeVisible();
  await expect(page.getByText('Project teams & goals', { exact: true })).toBeVisible();
  // The public demo card is tagged `mentorship` (the demo instance runs the
  // internship product) — it must still be here, or the tag emptied the live
  // catalogue instead of the marketing one.
  await expect(page.getByText('Public live demo', { exact: true })).toBeVisible();
  // …and the shared inbox still describes the mentorship thread here: the
  // marketing wording is an OVERLAY, not an edit to the base dictionary.
  await expect(page.getByTestId('feature-cat-collaboration')).toContainText('per-mentorship threads');
});

test('the marketing host gets a catalogue with no mentoring, evaluation, placement or project cards', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST });
  await page.goto('/features');

  await expect(page.getByRole('heading', { name: 'Everything SaleVali can do' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Everything InternshipCRM can do' })).toHaveCount(0);

  // The core CRM cards survive — this is the half of the change that is easy to
  // get wrong in the other direction (a filter that empties the page).
  await expect(page.getByText('Built-in messaging', { exact: true })).toBeVisible();
  await expect(page.getByText('Pipeline tracking', { exact: true })).toBeVisible();
  await expect(page.getByTestId('feature-cat-collaboration')).toContainText('Working together');

  // A surviving card must also READ like this product. `messaging` is core CRM,
  // so the capability filter cannot reach it and its description was the last
  // sentence on this page stating the internship relation model.
  await expect(page.getByTestId('feature-cat-collaboration')).toContainText('a thread per deal');
  await expect(page.locator('main')).not.toContainText('per-mentorship');
  // No mentor/mentee/internship noun anywhere on the marketing catalogue — the
  // assertion that catches the next untagged card with internship copy.
  await expect(page.locator('main')).not.toContainText(/mentor|mentee|internship/i);

  for (const card of [
    'Self-serve mentee intake',
    'Weekly internship reports',
    'Offer management',
    'Project teams & goals',
    'Self-serve mentor applications',
    'Talent pool & alerts (Premium)',
    'Published pricing',
    // One demo instance exists and it is the internship one (#2501 already
    // hides its footer link here) — so the catalogue does not advertise it.
    'Public live demo',
  ]) {
    await expect(page.getByText(card, { exact: true })).toHaveCount(0);
  }
});

// ── /pricing ─────────────────────────────────────────────────────────────────

test('the internship host keeps the published price list and its nav entry', async ({ page }) => {
  await page.goto('/pricing');
  await expect(page.getByTestId('pricing-free-core')).toContainText('Free for mentees and mentors, always');
  await expect(page.getByTestId('pricing-program-plans')).toBeVisible();
  await expect(page.getByTestId('pricing-metering')).toBeVisible();
  await expect(page.getByTestId('pricing-cta')).toBeVisible();
  await expect(page.getByTestId('public-header').getByRole('link', { name: 'Pricing' })).toHaveCount(1);
});

test('the marketing host is told there is no price list yet, and is shown no invented one', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST });
  await page.goto('/pricing');

  await expect(page.getByRole('heading', { name: 'What we can tell you about the price today' })).toBeVisible();

  // Not a single section that would have to state a price.
  for (const section of [
    'pricing-free-core',
    'pricing-program-plans',
    'pricing-metering',
    'pricing-overage',
    'pricing-employer',
    'pricing-placement-fee',
    'pricing-addons',
    'pricing-cta',
  ]) {
    await expect(page.getByTestId(section)).toHaveCount(0);
  }
  // …and no currency on the page at all, which is the assertion that survives
  // someone adding a new priced section without reading this file.
  await expect(page.locator('main')).not.toContainText('€');

  // What is left is true whatever the packaging turns out to be.
  await expect(page.getByTestId('pricing-discounts')).toContainText('Self-hosting is free forever');
  await expect(page.getByTestId('pricing-faq').locator('dt')).toHaveCount(2);
  await expect(page.getByTestId('pricing-faq')).toContainText('Can we host it ourselves?');
  await expect(page.getByTestId('pricing-faq')).not.toContainText('active pair');

  // The nav entry is gone with the price list it promised.
  await expect(page.getByTestId('public-header').getByRole('link', { name: 'Pricing' })).toHaveCount(0);
});

// ── /projects ────────────────────────────────────────────────────────────────

test('the public showcase is scoped to the host vertical, and marketing has none', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const internEmail = uniqueEmail('showcase-intern-owner');
  const marketingEmail = uniqueEmail('showcase-mkt-owner');

  const internOrg = await prisma.organization.create({
    data: { name: `Showcase INTERNSHIP ${stamp}`, slug: `showcase-int-${stamp}`, vertical: 'INTERNSHIP' },
  });
  const marketingOrg = await prisma.organization.create({
    data: { name: `Showcase MARKETING ${stamp}`, slug: `showcase-mkt-${stamp}`, vertical: 'MARKETING' },
  });

  try {
    const internOwner = await seedUser(internEmail, 'ShowcasePass123', 'MENTOR', 'Showcase Internship Owner');
    await prisma.user.update({ where: { id: internOwner.id }, data: { orgId: internOrg.id } });
    const marketingOwner = await seedUser(marketingEmail, 'ShowcasePass123', 'MENTOR', 'Showcase Marketing Owner');
    await prisma.user.update({ where: { id: marketingOwner.id }, data: { orgId: marketingOrg.id } });

    await prisma.project.create({
      data: {
        orgId: internOrg.id,
        name: `Internship Showcase Project ${stamp}`,
        isPublic: true,
        ownerType: 'MENTOR',
        ownerUserId: internOwner.id,
        technologies: ['React'],
      },
    });
    await prisma.project.create({
      data: {
        orgId: marketingOrg.id,
        name: `Marketing Showcase Project ${stamp}`,
        isPublic: true,
        ownerType: 'MENTOR',
        ownerUserId: marketingOwner.id,
        technologies: ['React'],
      },
    });

    // Anonymous — no sign-in anywhere in this test, which is the acceptance
    // criterion the scoping must not break.
    await page.goto('/projects');
    await expect(page.getByText(`Internship Showcase Project ${stamp}`)).toBeVisible({ timeout: 10_000 });
    // The other vertical's public project is not in this product's showcase.
    await expect(page.getByText(`Marketing Showcase Project ${stamp}`)).toHaveCount(0);

    // A marketing host has no project showcase at all: MARKETING does not carry
    // the `projects` capability (#2473/#2499), so the route is 404 rather than
    // an empty grid promising a showcase this product does not have.
    await page.setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST });
    const res = await page.goto('/projects');
    expect(res?.status()).toBe(404);
    await expect(page.getByText(`Internship Showcase Project ${stamp}`)).toHaveCount(0);

    // …and the 404 it lands on does not sell the other product back to it: no
    // register button (this host is invitation-only), no mentor application, no
    // partner-company pitch, and no link looping straight back to /projects.
    const main = page.locator('main');
    await expect(main).toContainText('Page not found');
    await expect(main.getByRole('link', { name: 'Register' })).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Become a mentor' })).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'For companies' })).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Projects', exact: true })).toHaveCount(0);
    // What is left still works: home, and the catalogue this product does have.
    await expect(main.getByRole('link', { name: 'Back to home' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Features' })).toBeVisible();
  } finally {
    await prisma.project.deleteMany({ where: { orgId: { in: [internOrg.id, marketingOrg.id] } } });
    await cleanupByEmail(internEmail);
    await cleanupByEmail(marketingEmail);
    await prisma.user.deleteMany({ where: { orgId: { in: [internOrg.id, marketingOrg.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [internOrg.id, marketingOrg.id] } } });
  }
});

// ── 404 ──────────────────────────────────────────────────────────────────────

test('the internship 404 keeps all four of its doors', async ({ page }) => {
  // The counterpart of the marketing assertions above: the gating must not have
  // emptied the live product's 404, which is a real entry point (a stale link
  // from a search result lands here).
  const res = await page.goto('/no-such-page-host-vertical-spec');
  expect(res?.status()).toBe(404);
  const main = page.locator('main');
  await expect(main.getByRole('link', { name: 'Register' })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Become a mentor' })).toBeVisible();
  await expect(main.getByRole('link', { name: 'For companies' })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
});

// ── The pages that cannot be dressed (#2544) ────────────────────────────────
//
// /features and /pricing could be dressed per vertical, and are (above). These
// cannot: /for-companies is a pitch for placing interns, /apply-as-mentor asks
// "how many mentees can you take on?", and /release-notes is one feed for the
// whole codebase, most of it the internship changelog — 205 visible lines of it
// on the marketing host. They answer 404 for a vertical without the module
// (or, for the product-level pages, for any vertical but the default), and the
// chrome stops offering them, so nobody reaches one by clicking.
//
// Asserted as a status plus the absence of links, in BOTH directions: a gate
// that 404s both hosts would pass the marketing half and take the live
// internship pages down with it.
// /code-of-conduct is the mentor–mentee rulebook (sitemap.ts already marks it
// `needs: 'mentorship'`); /release-notes/feed.xml is the page's own feed.
const NOT_DRESSABLE = ['/for-companies', '/apply-as-mentor', '/release-notes', '/contributor-terms', '/code-of-conduct'];

test('pages that belong to the internship product 404 on the marketing host and are linked from nowhere on it', async ({ page }) => {
  test.slow();
  const headers = { 'x-forwarded-host': MARKETING_HOST };
  for (const path of NOT_DRESSABLE) {
    const res = await page.request.get(path, { headers });
    expect(res.status(), `${path} must not be served on the marketing host`).toBe(404);
  }
  // A mentor's personal apply link is the same front door.
  expect((await page.request.get('/apply/some-mentor-id', { headers })).status()).toBe(404);
  // The release feed follows its page: no internship changelog on the SaleVali host.
  expect((await page.request.get('/release-notes/feed.xml', { headers })).status()).toBe(404);

  await page.setExtraHTTPHeaders(headers);
  for (const path of ['/', '/auth/signin']) {
    await page.goto(path);
    for (const target of [...NOT_DRESSABLE, '/apply']) {
      await expect(page.locator(`a[href="${target}"]`), `${path} links to ${target} on the marketing host`).toHaveCount(0);
    }
  }
  await expect(page.getByTestId('apply-as-mentor-link')).toHaveCount(0);
});

test('the internship host still serves every one of them, and still links to them', async ({ page }) => {
  test.slow();
  for (const path of NOT_DRESSABLE) {
    expect((await page.request.get(path)).status(), `${path} must still be served on the internship host`).toBe(200);
  }
  expect((await page.request.get('/release-notes/feed.xml')).status()).toBe(200);
  await page.goto('/auth/signin');
  await expect(page.getByTestId('apply-as-mentor-link')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('a[href="/release-notes"]').first()).toBeAttached();
});

// ── Everything a page produces stays in its world (docs/worlds.md) ──────────
//
// The legal, trust and accessibility statements are linked from every footer,
// so the marketing host serves them — but they must name the product that host
// sells, not the other one. The overlay replaces only the branded sentences;
// the internship host must still read the originals.
const DRESSED_STATEMENTS = ['/privacy', '/terms', '/imprint', '/trust', '/accessibility'];

test('the legal, trust and accessibility pages name SaleVali on the marketing host', async ({ page }) => {
  test.slow();
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST });
  for (const path of DRESSED_STATEMENTS) {
    const res = await page.goto(path);
    expect(res?.status(), `${path} on the marketing host`).toBe(200);
    const main = page.locator('main');
    await expect(main, `${path} names the other product`).not.toContainText(/Internship ?CRM/);
    await expect(main, `${path} does not name this product`).toContainText('SaleVali');
  }
  // The terms are short enough to hold to the whole rule: no internship model.
  await page.goto('/terms');
  await expect(page.locator('main')).not.toContainText(/mentor|mentee|internship/i);
});

test('the internship host keeps the original legal, trust and accessibility copy', async ({ page }) => {
  test.slow();
  for (const path of DRESSED_STATEMENTS) {
    await page.goto(path);
    await expect(page.locator('main'), `${path} on the internship host`).not.toContainText('SaleVali');
  }
  await page.goto('/terms');
  await expect(page.locator('main')).toContainText('By using InternshipCRM you agree to these terms.');
});

test('the public OpenAPI spec is titled with the product of the host it was fetched from', async ({ request }) => {
  const marketing = await (await request.get('/api/v1/openapi.json', { headers: { 'x-forwarded-host': MARKETING_HOST } })).json();
  expect(marketing.info.title).toBe('SaleVali Public API');
  const internship = await (await request.get('/api/v1/openapi.json')).json();
  expect(internship.info.title).toBe('Internship CRM Public API');
});

test('a public profile is served only on its owner\'s product host, wearing that product', async ({ page, request }) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const internEmail = uniqueEmail('world-profile-intern');
  const marketingEmail = uniqueEmail('world-profile-mkt');
  const marketingOrg = await prisma.organization.create({
    data: { name: `World profile MARKETING ${stamp}`, slug: `world-profile-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  try {
    const intern = await seedUser(internEmail, 'WorldProfile123', 'MENTEE', `World Intern ${stamp}`);
    const rep = await seedUser(marketingEmail, 'WorldProfile123', 'MENTOR', `World Rep ${stamp}`, marketingOrg.id);
    await prisma.user.updateMany({ where: { id: { in: [intern.id, rep.id] } }, data: { publicProfile: true } });
    const headers = { 'x-forwarded-host': MARKETING_HOST };

    // Each profile 404s on the other product's host — a relative /p/ link
    // never shows it inside the wrong world.
    expect((await request.get(`/p/${intern.id}`, { headers })).status()).toBe(404);
    expect((await request.get(`/p/${rep.id}`)).status()).toBe(404);

    // On its own host, the marketing profile carries the SaleVali wordmark.
    await page.setExtraHTTPHeaders(headers);
    await page.goto(`/p/${rep.id}`);
    await expect(page.getByRole('heading', { name: `World Rep ${stamp}` })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: 'SaleVali' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Internship ?CRM/ })).toHaveCount(0);

    // The OG card still answers (a generic card, never a 404) on either host.
    for (const [path, h] of [[`/p/${rep.id}/opengraph-image`, headers], [`/p/${intern.id}/opengraph-image`, headers]] as const) {
      const res = await request.get(path, { headers: h });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('image/png');
    }
  } finally {
    await cleanupByEmail(internEmail);
    await cleanupByEmail(marketingEmail);
    await prisma.organization.deleteMany({ where: { id: marketingOrg.id } });
  }
});
