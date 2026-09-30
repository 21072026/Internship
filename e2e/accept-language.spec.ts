import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1384: a first visit read no Accept-Language, so a visitor from a Turkish ad
// or post was greeted in English. The order is now: explicit locale cookie >
// the signed-in user's saved preference > Accept-Language > English.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const langOf = (html: string) => /<html[^>]*\blang="([a-z]+)"/.exec(html)?.[1];

test('a cookieless first visit answers in the browser language, falling back to English', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  // A fresh request context: no locale cookie, no session.
  const ctx = await playwright.request.newContext({ baseURL });
  try {
    const tr = await ctx.get('/', { headers: { 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.5' } });
    const trHtml = await tr.text();
    expect(langOf(trHtml)).toBe('tr');
    expect(trHtml).toContain('İhtiyacın olan her şey');
    // One URL, several languages: safe only because no shared cache may store it.
    expect(tr.headers()['cache-control']).toMatch(/private/);
    expect(tr.headers()['cache-control']).toMatch(/no-store/);

    expect(langOf(await (await ctx.get('/', { headers: { 'Accept-Language': 'de-AT,de;q=0.9' } })).text())).toBe('de');
    expect(langOf(await (await ctx.get('/', { headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' } })).text())).toBe('en');
    expect(langOf(await (await ctx.get('/', { headers: { 'Accept-Language': 'en;q=0.3, tr;q=0.8' } })).text())).toBe('tr');

    // An explicit choice (the switcher's cookie) beats the header.
    const chosen = await ctx.get('/', { headers: { 'Accept-Language': 'tr', Cookie: 'locale=en' } });
    expect(langOf(await chosen.text())).toBe('en');
  } finally {
    await ctx.dispose();
  }
});

test('a Turkish browser gets Turkish copy, and the switcher marks TR', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'tr-TR' });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByText('İhtiyacın olan her şey')).toBeVisible({ timeout: 20_000 });
    // No cookie was written: the language is re-read from the browser each time.
    expect((await context.cookies()).some((c) => c.name === 'locale')).toBe(false);
    const active = page.locator('[aria-label="Language"] button.font-semibold').first();
    await expect(active).toHaveText(/tr/i);
  } finally {
    await context.close();
  }
});

test("a signed-in user's saved language beats the browser header", async ({ page }) => {
  const email = uniqueEmail('accept-lang');
  const user = await seedUser(email, 'AcceptLang123!', 'MENTOR', 'Accept Lang Mentor');
  await prisma.user.update({ where: { id: user.id }, data: { preferredLanguage: 'de' } });
  try {
    await signInAndSettle(page, email, 'AcceptLang123!', '/mentor');
    // Drop any locale cookie the sign-in may have set, so the saved preference
    // itself is what is being tested.
    const cookies = (await page.context().cookies()).filter((c) => c.name !== 'locale');
    await page.context().clearCookies();
    await page.context().addCookies(cookies);
    const res = await page.request.get('/mentor', { headers: { 'Accept-Language': 'tr' } });
    expect(langOf(await res.text())).toBe('de');
  } finally {
    await cleanupByEmail(email);
  }
});
