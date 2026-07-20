import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.goto('http://localhost:3000/auth/signin', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

await page.locator('input[type="email"]').fill('admin@test.com');
await page.locator('input[type="password"]').fill('Admin1234!');

// Click and wait for URL to leave signin
await Promise.all([
  page.waitForURL(/^(?!.*signin).*$/, { timeout: 15000 }),
  page.locator('button[type="submit"]').click()
]);

console.log('URL after login:', page.url());
await page.waitForTimeout(1000);

// Check admin page
await page.goto('http://localhost:3000/admin', { waitUntil: 'networkidle', timeout: 20000 });
console.log('Admin URL:', page.url());

const bodyText = await page.locator('body').innerText();
console.log('Admin body snippet:', bodyText.slice(0, 300));

await browser.close();
