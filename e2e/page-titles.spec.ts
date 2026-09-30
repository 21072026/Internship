import { test, expect, type Page } from '@playwright/test';

// Every public page names itself, in the reader's language (#1376). The whole
// site used to carry the root layout's one English title and description, so
// /features and /privacy were indistinguishable in a search result and a
// Turkish page wore an English tab.

async function head(page: Page, path: string) {
  await page.goto(path);
  return {
    title: await page.title(),
    description: await page.locator('meta[name="description"]').getAttribute('content'),
    // Absent on an indexable page — ask first, or getAttribute waits for it.
    robots: (await page.locator('meta[name="robots"]').count())
      ? await page.locator('meta[name="robots"]').getAttribute('content')
      : null,
    lang: await page.locator('html').getAttribute('lang'),
  };
}

test('two public pages carry their own title and description, and both follow the locale', async ({ page, baseURL }) => {
  const features = await head(page, '/features');
  const privacy = await head(page, '/privacy');
  // The page's own H1 string, then the product the template appends.
  expect(features.title).toBe('Everything InternshipCRM can do · Internship CRM');
  expect(privacy.title).toMatch(/ · Internship CRM$/);
  expect(privacy.title).not.toBe(features.title);
  expect(features.description).toBeTruthy();
  expect(privacy.description).toBeTruthy();
  expect(privacy.description).not.toBe(features.description);

  // The home page is the template's default, not "X · Internship CRM".
  const home = await head(page, '/');
  expect(home.title).toBe('Internship CRM — mentoring from first contact to first job');

  await page.context().addCookies([{ name: 'locale', value: 'tr', url: baseURL! }]);
  const featuresTr = await head(page, '/features');
  const privacyTr = await head(page, '/privacy');
  expect(featuresTr.lang).toBe('tr');
  expect(featuresTr.title).not.toBe(features.title);
  expect(featuresTr.title).toMatch(/ · Internship CRM$/);
  expect(privacyTr.title).not.toBe(privacy.title);
  expect(privacyTr.description).not.toBe(privacy.description);
  // The tab says what the heading says.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(privacyTr.title.replace(/ · Internship CRM$/, ''));

  await page.context().addCookies([{ name: 'locale', value: 'de', url: baseURL! }]);
  const featuresDe = await head(page, '/features');
  expect(featuresDe.lang).toBe('de');
  expect(featuresDe.title).not.toBe(features.title);
  expect(featuresDe.title).not.toBe(featuresTr.title);
});

test('the sign-in page is titled but kept out of search results', async ({ page }) => {
  const signIn = await head(page, '/auth/signin');
  expect(signIn.title).toBe('Sign in · Internship CRM');
  expect(signIn.robots).toContain('noindex');
  // A public page is not.
  const features = await head(page, '/features');
  expect(features.robots ?? '').not.toContain('noindex');
});
