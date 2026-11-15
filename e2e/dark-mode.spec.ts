import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';

// Click the three-state theme control (system → light → dark → system, #2078)
// until it lands on the wanted state. It polls instead of clicking a fixed
// number of times: the button is in the SSR markup with its initial
// `data-theme="system"` before React hydrates it, so both the attribute read
// and an early click can be stale/swallowed. Polling converges either way.
async function selectTheme(page: import('@playwright/test').Page, want: 'system' | 'light' | 'dark') {
  const toggle = page.getByTestId('theme-toggle').first();
  await expect(toggle).toBeVisible();
  await expect
    .poll(async () => {
      const current = await toggle.getAttribute('data-theme');
      if (current === want) return current;
      await toggle.click();
      return toggle.getAttribute('data-theme');
    }, { timeout: 15_000 })
    .toBe(want);
}

// Dark mode (EPIC D1). The toggle on the public landing header flips the
// `dark` class on <html>, persists a `theme` cookie, and survives reload.
test('theme toggle switches dark mode and persists across reload', async ({ page }) => {
  await page.goto('/');

  const html = page.locator('html');
  // Start from a known light baseline regardless of the runner's OS preference.
  await page.emulateMedia({ colorScheme: 'light' });
  await selectTheme(page, 'light');
  await expect(html).not.toHaveClass(/\bdark\b/);

  // Toggle → dark.
  await selectTheme(page, 'dark');
  await expect(html).toHaveClass(/\bdark\b/);

  // Cookie was written so SSR + the no-flash script agree on the next load.
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'theme')?.value).toBe('dark');

  // Survives a full reload (no flash back to light).
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);

  // Toggle back → light.
  await selectTheme(page, 'light');
  await expect(html).not.toHaveClass(/\bdark\b/);
});

// The sticky landing header uses bg-white/80; in dark mode it must not stay a
// light bar (regression from the utility remap missing opacity variants).
test('dark mode retints the translucent landing header (not a light bar)', async ({ page }) => {
  await page.goto('/');
  await selectTheme(page, 'dark');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);

  const headerBg = await page.locator('header').first().evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  // Parse "rgb(a)(r, g, b[, a])" and assert it is a dark surface, not near-white.
  const [r, g, b] = headerBg.match(/\d+(\.\d+)?/g)!.map(Number);
  expect(r).toBeLessThan(60);
  expect(g).toBeLessThan(60);
  expect(b).toBeLessThan(70);
});

// ── Active toggles under the accent layer (dark mode) ───────────────────────
//
// `<html data-accent>` is ALWAYS set (blue by default, green on preview, the
// org's brand when it has one), and its remap rules (`html[data-accent]
// .bg-blue-100`, 0,2,1) used to outrank Tailwind's `dark:` variant
// (`.dark\:bg-blue-900\/40:is(.dark *)`, 0,2,0). The active "My records"
// toggle on the MARKETING lead list therefore kept its light accent-100 fill in
// dark mode while its text went light: light on light, reported from a
// screenshot. The accent rules now step aside, in dark mode, for an element
// that declares its own `dark:` value for the same property. Both active
// toggles are measured: computed text colour against computed background.

function rgbOf(value: string): [number, number, number, number] {
  const n = value.match(/[\d.]+/g)!.map(Number);
  return [n[0], n[1], n[2], n[3] ?? 1];
}
function lum([r, g, b]: [number, number, number, number]) {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
/** Composite a translucent background over the surface behind it, then the WCAG ratio. */
function ratio(fg: string, bg: string, under: string) {
  const b = rgbOf(bg);
  const u = rgbOf(under);
  const a = b[3];
  const flat: [number, number, number, number] = [0, 1, 2].map((i) => b[i] * a + u[i] * (1 - a)) as unknown as [number, number, number, number];
  flat[3] = 1;
  const [x, y] = [lum(rgbOf(fg)), lum(flat)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('dark mode: the active lead-list toggles keep AA contrast under the accent layer (MARKETING)', async ({ page }) => {
  test.slow();
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `Acme Sales Dark ${stamp}`, slug: `dark-toggle-${stamp}`, vertical: 'MARKETING' } });
  const email = uniqueEmail(`dark-toggle-${stamp}`).toLowerCase();
  try {
    await seedUser(email, 'DarkToggle123!', 'ADMIN', 'Dark Toggle Admin', org.id);
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await page.context().addCookies([{ name: 'theme', value: 'dark', url: test.info().project.use.baseURL as string }]);
    await page.emulateMedia({ colorScheme: 'dark' });
    await signInAndSettle(page, email, 'DarkToggle123!', '/admin');
    await gotoSettled(page, '/admin/candidates');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(page.locator('html')).toHaveAttribute('data-accent', /.+/);

    for (const id of ['candidates-mine-filter', 'candidates-orphan-filter']) {
      const toggle = page.getByTestId(id);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      const { color, background, under } = await toggle.evaluate((el) => {
        let p = el.parentElement;
        let behind = 'rgb(0, 0, 0)';
        while (p) {
          const c = getComputedStyle(p).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { behind = c; break; }
          p = p.parentElement;
        }
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor, under: behind };
      });
      const r = ratio(color, background, under);
      expect(r, `${id}: ${color} on ${background} (over ${under}) is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    await prisma.$disconnect();
  }
});
