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
 * `marketing.ersah.in`, which is why forging `x-forwarded-host` routes the
 * marketing vertical here without an env change (same trick as
 * `host-vertical-landing.spec.ts`).
 *
 * Every assertion is about RENDERED CONTENT — the lesson `pricing.spec.ts`
 * records from #2296: a URL that changed proves nothing about the page.
 */

const MARKETING_HOST = 'marketing.ersah.in';

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
