import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// WCAG 2.4.11 Focus Not Obscured (#2864). On a phone the shell's top bar is
// sticky, so walking a long page BACKWARDS with Shift+Tab scrolls each control
// to the top edge of the viewport — exactly under the bar, unless the document
// keeps a scroll-padding the height of the bar (globals.css). The walk starts
// at the last control of <main> and stops when focus leaves it; for each
// control it asks the browser what is actually painted on five points inside
// it, and fails when none of them is the control: entirely hidden.
test.use({ viewport: { width: 390, height: 664 } });

test('a control reached with Shift+Tab is never hidden under the mobile top bar', async ({ page }) => {
  test.slow();
  const email = uniqueEmail('focus-obscured');
  const pw = 'FocusObscured123';
  await seedUser(email, pw, 'MENTEE', 'Focus Obscured');
  try {
    await signInAndSettle(page, email, pw, '/portal');
    await gotoSettled(page, '/portal/profile');
    await expect(page.locator('main#main-content h1').first()).toBeVisible({ timeout: 20_000 });

    // Start at the last focusable control of the page body.
    await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>('main#main-content :is(a[href],button,input,select,textarea)')]
        .filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
      all[all.length - 1].focus();
    });

    let checked = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Tab');
      const verdict = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.closest('main#main-content')) return { inMain: false };
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const xs = [r.left + 2, (r.left + r.right) / 2, r.right - 2];
        const ys = [r.top + 2, (r.top + r.bottom) / 2, r.bottom - 2];
        const points = [[xs[1], ys[1]], [xs[0], ys[0]], [xs[2], ys[0]], [xs[0], ys[2]], [xs[2], ys[2]]]
          .filter(([x, y]) => x >= 0 && y >= 0 && x < vw && y < vh);
        const visible = points.some(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
        });
        return { inMain: true, visible, label: `${el.tagName} ${el.getAttribute('name') ?? el.textContent?.trim().slice(0, 30) ?? ''}`, top: Math.round(r.top) };
      });
      if (!verdict.inMain) break;
      checked += 1;
      expect(verdict.visible, `focused ${verdict.label} at y=${verdict.top} is entirely covered`).toBe(true);
    }
    expect(checked).toBeGreaterThan(5);
  } finally {
    await cleanupByEmail(email);
  }
});
