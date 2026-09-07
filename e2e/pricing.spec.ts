import { test, expect } from '@playwright/test';

/**
 * The /pricing page (#1730, story #1726).
 *
 * The specific failure this file exists to prevent is a repeat of #2296. #2284
 * shipped the header, footer and landing links to `/pricing` before the page,
 * and its own gate stayed green because `pricing-nav.spec.ts` asserted only
 * `toHaveURL(/\/pricing$/)` after a click — and the URL changes whether or not
 * anything is there. The App Router prefetch of the missing route then put a
 * 404 in the browser console, which is what `smoke.spec.ts` fails on, so
 * main's whole merge gate went red for 13 commits.
 *
 * So every assertion here is about RENDERED CONTENT, never about the URL: a
 * link is only proven by something on the destination page.
 *
 * The `@smoke` tag is deliberately NOT used. Smoke already catches a broken
 * pricing link for free — `smoke.spec.ts` treats any console error on the
 * landing page as a failure, and a nav <Link> to a dead route produces exactly
 * that — so adding these would grow the PR gate without covering anything it
 * does not already cover.
 */

test('the pricing page renders the free-core promise and what is never metered', async ({ page }) => {
  await page.goto('/pricing');

  // If this heading is here, the route resolved — the assertion #2284 was
  // missing.
  await expect(page.getByRole('heading', { name: /What this costs/i })).toBeVisible();

  const freeCore = page.getByTestId('pricing-free-core');
  await expect(freeCore).toContainText('Free for mentees and mentors, always');
  // The promise has to read as a structure, not a promotion: the reason it
  // cannot be withdrawn is that mentors and mentees are not the metering unit.
  await expect(freeCore).toContainText('matched pair');

  // The never-metered list is rendered from NEVER_METERED in src/lib/plans.ts,
  // so its length is the rule's length. A capability silently dropped from the
  // free core would shorten this list.
  await expect(page.getByTestId('never-metered').locator('li')).toHaveCount(9);
  await expect(freeCore).toContainText('The full pipeline, every stage');
  await expect(freeCore).toContainText('The mentee portal');
});

test('every published plan column renders with its price', async ({ page }) => {
  await page.goto('/pricing');

  // One published annual total, pinned as the string the page actually prints
  // (formatted by src/lib/money.ts, which is hand-rolled precisely so this is
  // byte-stable across ICU builds). Program is €149/month billed annually.
  const program = page.getByTestId('plan-program');
  await expect(program).toContainText('€149');
  await expect(program).toContainText('billed annually');
  // The monthly alternative and the derived saving.
  await expect(program).toContainText('€189');
  await expect(program).toContainText('Save €480 a year');
  // 2.5, not 3 — the saving in months is fractional and must not be rounded up
  // into a discount we do not give.
  await expect(program).toContainText('2.5 months free');

  await expect(page.getByTestId('plan-community')).toContainText('Free');
  await expect(page.getByTestId('plan-program_plus')).toContainText('€399');
  // Enterprise is annual-only by design; the column must say so rather than
  // implying a monthly option that is not sold.
  const enterprise = page.getByTestId('plan-enterprise');
  await expect(enterprise).toContainText('€749');
  await expect(enterprise).toContainText('annual billing only');
  await expect(enterprise).toContainText('Unlimited');

  // Both wallets are on the page, and visibly apart.
  await expect(page.getByTestId('plan-employer')).toContainText('€99');
  await expect(page.getByTestId('pricing-employer')).toContainText('separate wallet');
});

test('the metering rule and the overage rate are both stated', async ({ page }) => {
  await page.goto('/pricing');

  const metering = page.getByTestId('pricing-metering');
  await expect(metering).toContainText('ACTIVE');
  await expect(metering).toContainText('Never counted: mentors and mentees');

  // €1.20 is a published figure and the derived rule has to reproduce it. The
  // decimals matter: "€1" for €1.20 is a 20 % error on the only sub-euro
  // number on the page.
  const overage = page.getByTestId('pricing-overage');
  await expect(overage).toContainText('€1.20');
  await expect(overage).toContainText('€0.80');
  // The rule, so a reader can check the number rather than trust it.
  await expect(overage).toContainText('80%');
});

test('the placement fee is published but carries its legal footnote', async ({ page }) => {
  await page.goto('/pricing');
  const placement = page.getByTestId('pricing-placement-fee');
  await expect(placement).toContainText('€890');
  // PLACEMENT_FEE_BOOKABLE is false, so the footnote must be present and the
  // figure must not be sold. If someone flips the flag without the legal
  // sign-off, this test is what notices.
  await expect(placement).toContainText('not yet bookable');
});

test('the page says how you actually pay, because there is no checkout', async ({ page }) => {
  await page.goto('/pricing');
  // SELF_SERVE_CHECKOUT is false. A price list whose buttons look like they
  // take a card, when nothing does, is the more expensive kind of wrong.
  await expect(page.getByTestId('pricing-no-checkout')).toContainText('no card flow yet');
});

// The chrome tests start from /features, not from /. PublicHeader and
// PublicFooter are on every public page, so the landing page adds nothing to
// what they prove — and it is the one public page that reads from Prisma (its
// public stats), so anchoring them there would make them fail in any
// environment without a database and tell a developer nothing about the nav.
test('the pricing page is reachable from the public header', async ({ page }) => {
  await page.goto('/features');
  await page.getByTestId('public-header').getByRole('link', { name: 'Pricing' }).click();
  // Content, not URL — see the file comment.
  await expect(page.getByRole('heading', { name: /What this costs/i })).toBeVisible();
});

test('the pricing page is reachable from the public footer', async ({ page }) => {
  await page.goto('/features');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Pricing' }).click();
  await expect(page.getByRole('heading', { name: /What this costs/i })).toBeVisible();
});

test('the landing free-core band leads to the page it promises', async ({ page }) => {
  // This one does need the landing page — the band only exists there. It is
  // also the click that #2284 shipped into a 404, so proving the destination
  // renders is the whole point of the test.
  await page.goto('/');
  await page.getByTestId('free-core-cta').click();
  await expect(page.getByTestId('pricing-free-core')).toBeVisible();
});

test.describe('Turkish', () => {
  test('the pricing page renders in Turkish, with Turkish number formatting', async ({ page }) => {
    // The locale is set through the context rather than by visiting a page and
    // writing document.cookie: this test has no business loading the landing
    // page (the only public page that reads from Prisma) just to get a cookie
    // handle, and going straight to /pricing is also one navigation fewer.
    await page.context().addCookies([{ name: 'locale', value: 'tr', url: 'http://localhost' }]);
    await page.goto('/pricing');

    await expect(page.getByRole('heading', { name: /Bu size kaça mal olur/i })).toBeVisible();
    await expect(page.getByTestId('pricing-free-core')).toContainText('Mentee ve mentor için her zaman ücretsiz');
    // tr groups thousands with a dot and puts the symbol after the amount —
    // "1.788 €", never "€1,788". Getting this backwards is a hundredfold error
    // that reads as a typo.
    await expect(page.getByTestId('plan-program')).toContainText('149 €');
    await expect(page.getByTestId('pricing-overage')).toContainText('1,20 €');
    // tr writes the percent sign first.
    await expect(page.getByTestId('pricing-discounts')).toContainText('%50');
  });
});

test.describe('German', () => {
  test('the pricing page renders in German, with German number formatting', async ({ page }) => {
    await page.context().addCookies([{ name: 'locale', value: 'de', url: 'http://localhost' }]);
    await page.goto('/pricing');

    await expect(page.getByRole('heading', { name: /Was das kostet/i })).toBeVisible();
    await expect(page.getByTestId('pricing-free-core')).toContainText('dauerhaft kostenlos');
    await expect(page.getByTestId('plan-program')).toContainText('149 €');
    await expect(page.getByTestId('plan-enterprise')).toContainText('749 €');
    await expect(page.getByTestId('pricing-overage')).toContainText('1,20 €');
    // VAT has to be stated somewhere a German buyer looks for it.
    await expect(page.getByTestId('pricing-program-plans')).toContainText('zzgl. MwSt.');
  });
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the pricing page does not overflow a 375px screen', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByTestId('pricing-free-core')).toBeVisible();
    const overflow = await page.evaluate(
      // 1px of slack for sub-pixel rounding, as in public-chrome.spec.ts.
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('Pricing is reachable from the phone menu', async ({ page }) => {
    await page.goto('/features');
    // One `links` array drives the desktop bar and this disclosure panel, so a
    // desktop-only entry is not really possible — but #1732's whole point was
    // that the price must be reachable on a phone, so it is asserted.
    await page.getByTestId('public-header').getByRole('button', { name: /menu/i }).click();
    await page.getByTestId('public-header').getByRole('link', { name: 'Pricing' }).click();
    await expect(page.getByRole('heading', { name: /What this costs/i })).toBeVisible();
  });
});
