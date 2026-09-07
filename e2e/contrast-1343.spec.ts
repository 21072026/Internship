import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

/**
 * #1343 — the ModeSwitcher's active pill in dark mode.
 *
 * The issue was filed against two frozen entries in e2e/a11y-baseline.json
 * (`/admin#dark` and `/admin/candidates#dark`, `color-contrast ×1`, reported by
 * axe under the pill's own `.dark\:bg-gray-700` class). Re-measured when it was
 * picked up: both entries are already `{}` — #1482 raised the switcher's
 * *unselected* segments from `text-gray-500 dark:text-gray-400` to
 * `text-gray-700 dark:text-gray-300`, which is what that node actually was. In
 * dark mode globals.css remaps the group's `bg-gray-100` to #374151 and
 * `text-gray-500` to #9ca3af, i.e. 4.06:1 — under AA; the pair now resolves to
 * #d1d5db on #374151, 7.00:1.
 *
 * So this spec is the part that was missing rather than a fix: nothing pinned
 * the switcher's colours, and every one of them is produced by a *cascade*
 * (flat `html.dark .*` remaps and the always-present `html[data-accent]` layer)
 * rather than by the classes on the element — see the comment above `STYLES` in
 * src/components/ModeSwitcher.tsx. Deleting a `dark:!` there, or retinting one
 * more base utility in globals.css, changes these numbers with nothing in the
 * diff to show it.
 *
 * Why the a11y scan does not cover it on its own:
 *   - it reports one violation per RULE per page, so the pill and the segments
 *     next to it share a single `color-contrast` count and either can hide
 *     behind the other;
 *   - it scans the pill in `admin` and `mentor` state only (a bare seeded admin
 *     gets those two shells), so the mentee pill's purple pair — the third
 *     entry in `STYLES` — is never rendered under it.
 * This spec measures each state on its own, in both themes, and asserts the
 * ratio rather than trusting a rule that can skip a node it cannot resolve.
 *
 * Fixture: an ADMIN who is also being mentored. `availableModes` grants `admin`
 * and `mentor` from the role and adds `mentee` for anyone who is the mentee of
 * a relation (src/lib/dualRole.ts), so this one account renders all three
 * segments and can visit all three shells.
 */

const password = 'Contrast1343Pass!';

/** WCAG 1.4.3 for the 12px (`text-xs`) label the pill carries. */
const AA_NORMAL_TEXT = 4.5;

type Measurement = { color: string; background: string; ratio: number };

async function forceTheme(page: Page, dark: boolean) {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.evaluate((theme) => {
    document.cookie = `theme=${theme}; path=/; max-age=31536000`;
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, dark ? 'dark' : 'light');
  // Reload rather than toggling the class: a document rendered light and then
  // given `.dark` is half-dark — light surfaces under dark-mode text — and
  // measuring that would report failures no real user can see (the same note as
  // e2e/a11y-scan.spec.ts's forceDark).
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(dark ? /\bdark\b/ : /^(?!.*\bdark\b)/);
}

/**
 * The rendered contrast ratio of one element's text against the background it
 * actually sits on.
 *
 * `getComputedStyle` gives the element's own background, which for a segment of
 * this switcher is `rgba(0, 0, 0, 0)` — the colour comes from an ancestor. So
 * walk up collecting layers until an opaque one is found and composite them
 * back down, which is also how axe resolves a background. Done in the page
 * because only the browser knows which of the competing CSS rules won.
 */
async function measureContrast(page: Page, selector: string): Promise<Measurement> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no element matched ${sel}`);

    const parse = (value: string): [number, number, number, number] => {
      const inner = value.match(/rgba?\(([^)]+)\)/);
      if (!inner) return [0, 0, 0, 0];
      const parts = inner[1].split(/[,/\s]+/).filter(Boolean).map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const hex = (rgb: [number, number, number]) =>
      `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

    // Layers from the element outwards, up to and including the first opaque one.
    const layers: [number, number, number, number][] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
      if (a > 0) layers.push([r, g, b, a]);
      if (a >= 1) break;
    }
    // The canvas under everything: the document body's own colour is already in
    // `layers` when it is painted, so this is only the fallback for a fully
    // transparent chain.
    const root = document.documentElement.classList.contains('dark') ? 0 : 255;
    let bg: [number, number, number] = [root, root, root];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    }

    const [tr, tg, tb, ta] = parse(getComputedStyle(el).color);
    const fg: [number, number, number] = [
      tr * ta + bg[0] * (1 - ta),
      tg * ta + bg[1] * (1 - ta),
      tb * ta + bg[2] * (1 - ta),
    ];

    const luminance = ([r, g, b]: [number, number, number]) => {
      const channel = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const lf = luminance(fg);
    const lb = luminance(bg);
    const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);

    return { color: hex(fg), background: hex(bg), ratio: Math.round(ratio * 100) / 100 };
  }, selector);
}

async function expectNoContrastViolation(page: Page, selector: string, label: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2aa', 'wcag22aa'])
    .analyze();
  const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');
  expect(
    contrast.map((v) => v.nodes.map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1] ?? ''}`)),
    `axe color-contrast under ${selector} (${label})`
  ).toEqual([]);
}

// Every shell the fixture can enter, with the pill that is active there. The
// three `STYLES` entries in ModeSwitcher.tsx are exactly these three colours.
const SHELLS: { path: string; mode: 'admin' | 'mentor' | 'mentee' }[] = [
  { path: '/admin', mode: 'admin' },
  { path: '/mentor', mode: 'mentor' },
  { path: '/portal', mode: 'mentee' },
];

test('issue #1343 the mode switcher meets AA contrast in every mode and both themes', async ({ page }) => {
  test.slow();
  const adminEmail = uniqueEmail('contrast-1343-admin');
  const mentorEmail = uniqueEmail('contrast-1343-mentor');
  const admin = await seedUser(adminEmail, password, 'ADMIN', 'Contrast 1343 Admin');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Contrast 1343 Mentor');
  // The admin is the MENTEE of this relation — that is what adds the third
  // segment. Cleanup goes through cleanupByEmail, which drops the relation.
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: admin.id, status: 'ACTIVE' },
  });

  try {
    await signInAsFreshUser(page, adminEmail, password, '/admin');

    for (const { path, mode } of SHELLS) {
      for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';
        const where = `${mode} pill on ${path} in ${theme}`;
        await page.goto(path);
        await forceTheme(page, dark);

        // The switcher lives in the sidebar, which ResponsiveShell renders ONCE
        // (a drawer on mobile, a sticky column at this viewport) — so unlike the
        // notification bell of e2e/contrast-1299.spec.ts these locators are not
        // duplicated and need no `:visible` filter.
        const switcher = page.getByTestId('mode-switcher');
        await expect(switcher, `the switcher should render for ${where}`).toBeVisible({ timeout: 20_000 });
        await expect(switcher.getByTestId('mode-switch-option')).toHaveCount(SHELLS.length);

        const activeSelector = `[data-testid="mode-switch-option"][data-active="true"]`;
        await expect(switcher.locator(activeSelector)).toHaveAttribute('data-mode', mode);

        const active = await measureContrast(page, activeSelector);
        expect(
          active.ratio,
          `${where}: ${active.color} on ${active.background}`
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

        // The unselected segments are the node the baseline entry of #1343
        // actually named, and they are a different pair (neutral grays, and
        // remapped in dark by `html.dark .text-gray-700`). Measure them too, or
        // the fix that cleared the entry has no cover.
        const idle = SHELLS.filter((s) => s.mode !== mode);
        for (const { mode: idleMode } of idle) {
          const idleSelector = `[data-testid="mode-switch-option"][data-mode="${idleMode}"][data-active="false"]`;
          const measured = await measureContrast(page, idleSelector);
          expect(
            measured.ratio,
            `${idleMode} segment on ${path} in ${theme}: ${measured.color} on ${measured.background}`
          ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        }

        // Cross-check with the rule that gates the a11y scan, over the whole
        // switcher — this also covers the group label and the mentor/mentee
        // hint line under it, which are text of the same component.
        await expectNoContrastViolation(page, '[data-testid="mode-switcher"]', where);
      }
    }
  } finally {
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(mentorEmail);
    await prisma.$disconnect();
  }
});
