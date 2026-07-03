import { test, expect } from '@playwright/test';
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

// A payload that would pop a dialog if the string were ever evaluated as HTML/JS.
const XSS_PAYLOAD = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>hello-xss';

test('stored note with an XSS payload is rendered as inert text, not executed', async ({ page }) => {
  const email = uniqueEmail('xss-mentee');
  await seedUser(email, 'XssPass123', 'MENTEE', 'XSS Mentee');
  let noteId = '';

  // If any injected script actually runs, this flips the page flag / opens a dialog.
  let dialogFired = false;
  page.on('dialog', async (d) => {
    dialogFired = true;
    await d.dismiss().catch(() => {});
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'XssPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const created = await page.request.post('/api/notes', { data: { body: XSS_PAYLOAD } });
    expect(created.status()).toBe(201);
    noteId = (await created.json()).note.id;

    // Render the notes page and let any (mis)injected script attempt to run.
    await page.goto('/portal/notes');
    await page.waitForTimeout(500);

    // 1. The payload must appear verbatim as text content.
    await expect(page.getByText('hello-xss')).toBeVisible();

    // 2. No <script> or <img> element was actually parsed from the note body —
    //    it must live as a text node only.
    const injectedNodes = await page.evaluate(() => {
      const marker = 'window.__xss';
      const scripts = Array.from(document.querySelectorAll('script')).filter((s) =>
        s.textContent?.includes(marker)
      ).length;
      const imgs = Array.from(document.querySelectorAll('img')).filter((i) =>
        (i.getAttribute('onerror') || '').includes(marker)
      ).length;
      // @ts-expect-error - runtime flag set only if the payload executed
      const executed = window.__xss === 1;
      return { scripts, imgs, executed };
    });

    expect(injectedNodes.scripts, 'no injected <script> node should be parsed').toBe(0);
    expect(injectedNodes.imgs, 'no injected <img onerror> node should be parsed').toBe(0);
    expect(injectedNodes.executed, 'injected script must not execute').toBe(false);
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

  let dialogFired = false;
  page.on('dialog', async (d) => {
    dialogFired = true;
    await d.dismiss().catch(() => {});
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', adminPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    await page.waitForTimeout(500);

    const executed = await page.evaluate(() => {
      // @ts-expect-error - runtime flag
      return window.__xss === 1;
    });
    expect(executed, 'name payload must not execute').toBe(false);
    expect(dialogFired, 'no dialog should be triggered by the name payload').toBe(false);
  } finally {
    await cleanupByEmail(victimEmail);
  }
});
