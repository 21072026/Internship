import { test, expect, Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * XSS / stored-injection tests.
 *
 * User-supplied text (personal notes, profile fields) must be rendered as inert
 * text, never as live HTML/JS. React escapes by default, but a regression that
 * introduces `dangerouslySetInnerHTML` or an unescaped sink would be silent —
 * these tests fail loudly if an injected <script>/onerror payload ever executes.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A payload that would pop a dialog / set a global flag if the string were ever
// evaluated as HTML/JS. 'hello-xss' is a plain-text marker used to locate it.
const XSS_PAYLOAD = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>hello-xss';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
}

// Returns a getter for whether any injected script actually executed (flipped the
// page flag or triggered a dialog).
function trackExecution(page: Page) {
  let dialogFired = false;
  page.on('dialog', async (d) => {
    dialogFired = true;
    await d.dismiss().catch(() => {});
  });
  return async () => {
    const flag = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss === 1);
    return { executed: flag, dialogFired };
  };
}

test('stored note with an XSS payload is rendered as inert text, not executed', async ({ page }) => {
  const email = uniqueEmail('xss-mentee');
  await seedUser(email, 'XssPass123', 'MENTEE', 'XSS Mentee');
  const executionState = trackExecution(page);
  let noteId = '';

  try {
    await signIn(page, email, 'XssPass123');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const created = await page.request.post('/api/notes', { data: { body: XSS_PAYLOAD } });
    expect(created.status()).toBe(201);
    noteId = (await created.json()).note.id;

    await page.goto('/portal/notes');

    // The note body must render as visible *text* — this also proves the row
    // exists before we assert nothing executed (guards against a vacuous pass).
    await expect(page.getByText('hello-xss')).toBeVisible();

    // No <script>/<img onerror> node carrying the payload should have been parsed.
    const injectedNodes = await page.evaluate(() => {
      const marker = 'window.__xss';
      const scripts = Array.from(document.querySelectorAll('script')).filter((s) =>
        s.textContent?.includes(marker)
      ).length;
      const imgs = Array.from(document.querySelectorAll('img')).filter((i) =>
        (i.getAttribute('onerror') || '').includes(marker)
      ).length;
      return { scripts, imgs };
    });
    expect(injectedNodes.scripts, 'no injected <script> node should be parsed').toBe(0);
    expect(injectedNodes.imgs, 'no injected <img onerror> node should be parsed').toBe(0);

    const { executed, dialogFired } = await executionState();
    expect(executed, 'injected script must not execute').toBe(false);
    expect(dialogFired, 'no dialog should be triggered by the payload').toBe(false);
  } finally {
    if (noteId) await prisma.personalNote.deleteMany({ where: { id: noteId } }).catch(() => {});
    await cleanupByEmail(email);
  }
});

test('XSS payload in a profile display name is escaped in the admin users list', async ({ page }) => {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const victimEmail = uniqueEmail('xss-name');
  await seedUser(victimEmail, 'x', 'MENTEE', XSS_PAYLOAD);
  const executionState = trackExecution(page);

  try {
    await signIn(page, adminEmail, adminPassword);

    await page.goto('/admin/users');
    // Filter to the victim by its plain-text marker so it renders regardless of
    // how many other users exist / pagination — otherwise the assertion is vacuous.
    await page.locator('input[type="search"]').fill('hello-xss');

    // The payload-bearing name must actually appear as text before we can claim
    // it wasn't executed.
    await expect(page.getByText('hello-xss')).toBeVisible();

    const { executed, dialogFired } = await executionState();
    expect(executed, 'name payload must not execute').toBe(false);
    expect(dialogFired, 'no dialog should be triggered by the name payload').toBe(false);
  } finally {
    await cleanupByEmail(victimEmail);
  }
});
