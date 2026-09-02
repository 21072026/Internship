import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2078 — the sidebar/header control is three-state: system → light → dark →
// system. "system" is a stored value, not the absence of one, so a user who
// once tapped the toggle can always hand the theme back to the OS.
test('theme toggle cycles system → light → dark and follows a live OS switch', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  const html = page.locator('html');
  const toggle = page.getByTestId('theme-toggle').first();

  // A fresh context has no stored preference: that is "system", and the OS is light.
  await expect(toggle).toBeVisible();
  await expect(html).not.toHaveClass(/\bdark\b/);
  // The control keeps the codebase's 44px touch-target floor.
  const box = await toggle.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);

  // Plant an explicit preference and reload. The button ships in the SSR markup
  // with its initial `data-theme="system"` and only adopts the stored value once
  // mounted, so this assertion doubles as a hydration barrier — every click
  // below can then be treated as deterministic.
  await page.evaluate(() => { document.cookie = `theme=dark; path=/; max-age=${60 * 60 * 24}`; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(toggle).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveClass(/\bdark\b/);

  // dark → system, and `system` is written out so the pre-paint script can resolve it.
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-theme', 'system');
  await expect(html).not.toHaveClass(/\bdark\b/);
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'theme')?.value).toBe('system');

  // On `system`, a live OS switch is followed without a reload.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveClass(/\bdark\b/);

  // …and survives a reload: the no-flash script resolves `system` before paint,
  // so the class is already there when the document is parsed.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(toggle).toHaveAttribute('data-theme', 'system');

  // system → light. An explicit choice outranks the OS, which is still dark.
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-theme', 'light');
  await expect(html).not.toHaveClass(/\bdark\b/);

  // light → dark → back to system: the full cycle.
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveClass(/\bdark\b/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-theme', 'system');
});

// Compact density tightens containers only — a tap target may never get smaller.
test('compact density tightens spacing without shrinking a tap target', async ({ page }) => {
  test.slow();
  const email = uniqueEmail('density');
  const pw = 'DensityPass123';
  const user = await seedUser(email, pw, 'MENTEE', 'Density Mentee');

  // Every visible button, in DOM order, so before/after can be compared pairwise.
  const buttonBoxes = () =>
    page.locator('button:visible').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { h: r.height, w: r.width };
      }),
    );

  try {
    // Below Tailwind's `lg`, where the 44px touch-target floor applies.
    await page.setViewportSize({ width: 800, height: 1000 });
    await signInAndSettle(page, email, pw, '/portal');
    await page.goto('/account');
    const select = page.getByTestId('density-select');
    await expect(select).toBeVisible({ timeout: 20_000 });
    await expect(select).toHaveValue('comfortable');

    const html = page.locator('html');
    await expect(html).not.toHaveClass(/\bdensity-compact\b/);

    // Measure a known card and every visible button before the switch.
    const card = page.getByTestId('two-factor-card');
    const paddingBefore = await card.evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
    const before = await buttonBoxes();

    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/profile') && r.request().method() === 'PUT',
      { timeout: 20_000 },
    );
    await select.selectOption('compact');
    expect((await saved).ok()).toBeTruthy();

    // Applies instantly and visibly tightens the card.
    await expect(html).toHaveClass(/\bdensity-compact\b/);
    const paddingAfter = await card.evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
    expect(paddingAfter).toBeLessThan(paddingBefore);

    // No interactive target that met the 44px floor lost it. (The app also has
    // deliberately small icon buttons; the guarantee compact mode makes is that
    // it never *takes away* a target that already cleared the floor.)
    const after = await buttonBoxes();
    expect(after.length).toBe(before.length);
    before.forEach((b, i) => {
      if (b.h >= 44) expect(after[i].h, `button #${i} height`).toBeGreaterThanOrEqual(44);
      if (b.w >= 44) expect(after[i].w, `button #${i} width`).toBeGreaterThanOrEqual(44);
    });

    // Persisted to the account…
    await expect
      .poll(async () => (await prisma.user.findUnique({ where: { id: user.id } }))?.density, { timeout: 10_000 })
      .toBe('compact');

    // …and survives a reload (cookie + SSR class, no flash of comfortable).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(html).toHaveClass(/\bdensity-compact\b/);

    // The sidebar controls keep their 44px floor in compact mode.
    await page.goto('/portal');
    await expect(html).toHaveClass(/\bdensity-compact\b/);
    await page.getByTestId('account-menu-button').click();
    for (const id of ['theme-toggle', 'density-control']) {
      const control = page.getByTestId(id).first();
      await expect(control).toBeVisible({ timeout: 10_000 });
      const rect = await control.boundingBox();
      expect(rect!.height, `${id} height`).toBeGreaterThanOrEqual(44);
      expect(rect!.width, `${id} width`).toBeGreaterThanOrEqual(44);
    }

    // The sidebar toggle and the account select agree on what is stored.
    await expect(page.getByTestId('density-control').first()).toHaveAttribute('data-density', 'compact');
  } finally {
    await cleanupByEmail(email);
  }
});
