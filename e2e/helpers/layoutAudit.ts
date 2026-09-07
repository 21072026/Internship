import { expect, type Page } from '@playwright/test';

/**
 * The phone-layout audit's measuring instruments (#1305, #828, #2047, #1615).
 *
 * Extracted from `e2e/mobile-layout-audit.spec.ts` when the audit was widened to
 * the routes that spec never reached (#1615): the rules have to be the SAME
 * rules in both files, and a copy-paste of a hundred lines of geometry drifts the
 * first time someone tightens one of them.
 *
 * Everything here is a GEOMETRIC assertion — bounding boxes and scroll metrics —
 * and deliberately not a screenshot diff. A screenshot tells you a page changed;
 * a bounding box tells you a name got squeezed to 18px and by how much, in a
 * sentence a bug report can be written from. Keep it that way.
 */

export const PHONE = { width: 360, height: 800 };
// The tier nothing measured (#828): between `sm:` and `lg:`, where the sidebar is
// still hidden but two-column grids have already switched on. 768 is exactly
// Tailwind's `md:` breakpoint, so it is the first width at which `md:` rules
// apply — the worst case for a layout that assumes `md:` implies "roomy".
export const TABLET = { width: 768, height: 1024 };
// The WCAG 1.4.10 (Reflow) floor: 320 CSS pixels wide. Everything must be
// reachable without scrolling in two directions at this width.
export const REFLOW = { width: 320, height: 568 };
// 400% zoom, emulated the way the success criterion defines it: content at 400%
// on a 1280x1024 desktop lays out in a quarter of that in each direction, so a
// 320x256 viewport is the equivalent. The width matches REFLOW on purpose —
// what this case adds is the *vertical* squeeze, where sticky headers and fixed
// bottom bars start eating the page.
export const ZOOM_400 = { width: 320, height: 256 };
// Narrower than this and a truncated label stops carrying information.
export const MIN_TEXT_WIDTH = 110;
// WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA. The app's own accessibility
// statement claims 44x44 on touch viewports; 24 is the level the success
// criterion actually requires, so it is what a gate may fail a run on.
export const MIN_TAP_TARGET = 24;

/**
 * Rule 1 of the audit on its own, for the reflow cases.
 *
 * The full `auditLayout()` sweep is the right tool for a list or a form, but the
 * board and the calendar deliberately contain scrollers (13 kanban columns, a
 * month grid), and at 320px the interesting question is the one 1.4.10 actually
 * asks: does the PAGE make you scroll in two directions? Returns the offending
 * measurement, or null.
 */
export async function sidewaysScroll(page: Page) {
  return page.evaluate(() => {
    const content = document.documentElement.scrollWidth;
    // 1px of slack, same as auditLayout: sub-pixel rounding is not an overflow.
    return content > window.innerWidth + 1
      ? `${content}px of content in a ${window.innerWidth}px viewport`
      : null;
  });
}

export async function setLocale(page: Page, locale: 'tr' | 'de') {
  // Same trick as i18n-coverage.spec: the cookie wins over the user preference,
  // and it needs an origin to be set on, hence the navigation first.
  await page.goto('/auth/signin');
  await page.evaluate((l) => { document.cookie = `locale=${l};path=/`; }, locale);
}

/**
 * Let the client-side lists land before measuring a half-empty page.
 *
 * For the pages inside a role shell (`ResponsiveShell`): the account-menu button
 * is in that shell on every authenticated role page, so it is the deterministic
 * "the page has actually mounted" signal — see `helpers/auth.ts` for why
 * `networkidle` is not.
 */
export async function settle(page: Page, opts: { timeout?: number } = {}) {
  const timeout = opts.timeout ?? 20_000;
  await page.getByTestId('account-menu-button').waitFor({ state: 'visible', timeout });
  // Every list on these pages renders SkeletonRows while it fetches; waiting for
  // the last one to go is more reliable than `networkidle`, which these shells
  // never reach (see helpers/auth.ts).
  await expect.poll(async () => page.locator('.animate-pulse').count(), { timeout }).toBe(0);
}

/**
 * `settle()` for the screens that live OUTSIDE the role shells — `/account`,
 * `/notifications`, `/todos`, `/messages`, `/interviews`, `/projects` (#1113).
 *
 * Those layouts are a back-link and a container; there is no
 * `account-menu-button` to wait for, so the page's own `<h1>` is the signal that
 * the DOM the audit measures is really there. The skeleton wait is the same:
 * a page still rendering `animate-pulse` rows has no layout worth measuring, and
 * measuring it anyway is how an audit reports a clean empty box as coverage.
 */
export async function settleStandalone(page: Page, opts: { timeout?: number } = {}) {
  const timeout = opts.timeout ?? 20_000;
  await page.getByRole('heading', { level: 1 }).first().waitFor({ state: 'visible', timeout });
  await expect.poll(async () => page.locator('.animate-pulse').count(), { timeout }).toBe(0);
}

/**
 * The public-page equivalent of `settle()`. /release-notes has no account
 * shell (there is no `account-menu-button` to wait for — that testid only
 * exists on the authenticated role shells) and it is server-rendered with no
 * client fetch, so there are no skeleton rows either; waiting for the main
 * heading to paint is enough signal that the DOM the audit measures is there.
 */
export async function settlePublic(page: Page) {
  await page.getByRole('heading', { level: 1 }).first().waitFor({ state: 'visible', timeout: 20_000 });
}

/**
 * The four mechanical rules, in the order they catch things:
 *   1. the page must not scroll sideways;
 *   2. nothing visible may reach past the right edge of the screen (unless it
 *      lives in a container that scrolls horizontally — a wide table inside
 *      `overflow-x-auto` is reachable, not broken);
 *   3. no box may spill its own content sideways — that is how a squeezed row
 *      announces itself even when the page still fits;
 *   4. a truncating text box narrower than 110px is not readable; the buttons
 *      next to it are what pushed it there.
 */
export async function auditLayout(page: Page) {
  return page.evaluate((minTextWidth) => {
    const problems: string[] = [];
    const viewport = window.innerWidth;
    // 1px of slack: sub-pixel rounding on scaled layouts is not an overflow.
    if (document.documentElement.scrollWidth > viewport + 1) {
      problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px > ${viewport}px`);
    }

    const describe = (el: Element) => {
      const testId = el.getAttribute('data-testid');
      const cls = (el.getAttribute('class') || '').split(' ').slice(0, 4).join('.');
      return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ''}${cls ? `.${cls}` : ''}`;
    };

    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      // Screen-reader-only helpers are a 1px box by design.
      if (/(^|\s)sr-only(\s|$)/.test(el.getAttribute('class') || '')) continue;

      let inScroller = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(a).overflowX)) { inScroller = true; break; }
      }

      if (rect.right > viewport + 1 && style.position !== 'fixed' && !inScroller) {
        problems.push(`${describe(el)} reaches ${Math.round(rect.right)}px, past the ${viewport}px screen`);
      }

      // A child pulled out with a negative margin (row hover backgrounds bleeding
      // into the card padding) widens scrollWidth on purpose.
      const negativeMargin = Array.from(el.children).some((c) => {
        const cs = getComputedStyle(c);
        return parseFloat(cs.marginLeft) < 0 || parseFloat(cs.marginRight) < 0;
      });
      const spills =
        el.scrollWidth > el.clientWidth + 4 &&
        el.clientWidth > 0 &&
        !negativeMargin &&
        !/auto|scroll/.test(style.overflowX) &&
        style.overflow !== 'hidden' &&
        // Text scrolling inside a form control is normal.
        !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
      if (spills) {
        problems.push(`${describe(el)} spills its content: ${el.clientWidth}px box, ${el.scrollWidth}px content`);
      }

      const text = (el.textContent || '').trim();
      const isLeaf = !Array.from(el.children).some((c) => (c.textContent || '').trim().length > 0);
      if (
        isLeaf &&
        text.length > 3 &&
        el.clientWidth > 0 &&
        el.clientWidth < minTextWidth &&
        el.scrollWidth > el.clientWidth + 6 &&
        !/auto|scroll/.test(style.overflowX)
      ) {
        problems.push(`${describe(el)} is ${el.clientWidth}px wide for "${text.slice(0, 30)}"`);
      }
    }
    return [...new Set(problems)];
  }, MIN_TEXT_WIDTH);
}

/**
 * A fixed bar may not sit on top of the end of the page (#935, generalised).
 *
 * `mobile-fixed-bars.spec.ts` measures exactly this for the cookie banner on the
 * two public forms: scroll to the bottom of the document and nothing may still be
 * underneath the banner. This is the same measurement, applied to whatever is
 * `position: fixed` on the page at the time — so it is a *tripwire* for the next
 * fixed bar somebody adds to a role shell, not a re-test of the banner.
 *
 * On an authenticated shell today the only fixed things are the off-canvas drawer
 * (translated to x ≤ 0, so it overlaps nothing) and the toast stack (which is
 * `pointer-events: none` and therefore cannot swallow a tap). Both are excluded
 * on their own merits below rather than by name, so the rule keeps working when
 * the inventory changes.
 *
 * `sticky` is deliberately NOT included: content scrolling under a sticky header
 * is what sticky means. Only `fixed` — an element parked over the viewport that
 * the page cannot scroll out from under.
 */
export async function fixedOverlaps(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    // A fixed bar only ever covers the END of a document, so measure there.
    window.scrollTo(0, document.documentElement.scrollHeight);

    const describe = (el: Element) => {
      const testId = el.getAttribute('data-testid');
      const cls = (el.getAttribute('class') || '').split(' ').slice(0, 3).join('.');
      return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ''}${cls ? `.${cls}` : ''}`;
    };
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const region = document.querySelector('#main-content') ?? document.body;
    const bars = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const style = getComputedStyle(el);
      if (style.position !== 'fixed') return false;
      // Cannot intercept a tap, so it cannot be in the way.
      if (style.pointerEvents === 'none') return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (!visible(el)) return false;
      // A full-height fixed layer is a modal or a backdrop, not a bar; and a
      // wrapper that CONTAINS the content region is the shell, not an overlay.
      if (el.getBoundingClientRect().height > window.innerHeight * 0.9) return false;
      return !el.contains(region);
    });
    if (bars.length === 0) return problems;

    // The last control on the page: the one a fixed bottom bar takes away.
    const controls = Array.from(
      region.querySelectorAll('button, a[href], input, select, textarea')
    ).filter((el) => visible(el) && !bars.some((bar) => bar.contains(el)));
    const last = controls.reduce<Element | null>((best, el) => {
      if (!best) return el;
      return el.getBoundingClientRect().bottom > best.getBoundingClientRect().bottom ? el : best;
    }, null);
    if (!last) return problems;

    const target = last.getBoundingClientRect();
    for (const bar of bars) {
      const box = bar.getBoundingClientRect();
      const overlapsVertically = target.bottom > box.top + 1 && target.top < box.bottom - 1;
      const overlapsHorizontally = target.right > box.left + 1 && target.left < box.right - 1;
      if (overlapsVertically && overlapsHorizontally) {
        problems.push(
          `${describe(bar)} covers ${describe(last)}: the control ends at ${Math.round(target.bottom)}px, ` +
            `the bar starts at ${Math.round(box.top)}px`
        );
      }
    }
    return [...new Set(problems)];
  });
}

/**
 * WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA — with the spacing exception,
 * which is the half that makes the rule mean anything.
 *
 * A bare "every control must be 24x24" rule fails on every 16px checkbox in the
 * product, which is not what the success criterion says: an undersized target
 * passes when a 24px-diameter circle centred on it does not intersect another
 * target (or another undersized target's circle). A 16px checkbox with a label
 * and 12px of air around it is conformant; four 16px icon buttons jammed together
 * in a table row are not. That distinction is the whole finding, so it is
 * implemented here rather than approximated away.
 *
 * The other two exceptions the criterion grants are honoured too: a control laid
 * out INLINE in a sentence of text is exempt (Inline), and so is one whose size
 * is not author-determined (User agent control — nothing here styles the native
 * date picker's internals).
 *
 * Not a substitute for axe's `target-size` (see `e2e/a11y-scan.spec.ts`); it is
 * the same criterion measured on the routes this audit reaches, so a cramped row
 * is caught at phone width, where cramped rows happen.
 */
export async function tapTargets(page: Page) {
  return page.evaluate((min) => {
    const problems: string[] = [];
    const radius = min / 2;
    const selector =
      'button, [role="button"], a[href], [role="link"], [role="tab"], [role="checkbox"], ' +
      'input:not([type="hidden"]), select, textarea, summary';

    const describe = (el: Element) => {
      const testId = el.getAttribute('data-testid');
      const label = (el.getAttribute('aria-label') || (el.textContent || '').trim()).slice(0, 24);
      const cls = (el.getAttribute('class') || '').split(' ').slice(0, 3).join('.');
      return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ''}${cls ? `.${cls}` : ''}${label ? ` "${label}"` : ''}`;
    };

    const targets: { el: Element; rect: DOMRect }[] = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      // The off-canvas drawer is parked at x ≤ 0 and is measured when it is
      // open (mobile-layout-audit's dialog case), not while it is off screen.
      if (el.closest('[data-testid="app-drawer"]')) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      if (/(^|\s)sr-only(\s|$)/.test(el.getAttribute('class') || '')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      // SC 2.5.8 exception "Inline": a target in a sentence of text is exempt,
      // because its size is set by the line it sits in.
      if (style.display === 'inline') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      targets.push({ el, rect });
    }

    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    /** Distance from a point to the nearest edge of a rect (0 when inside). */
    const gap = (p: { x: number; y: number }, r: DOMRect) => {
      const dx = Math.max(r.left - p.x, 0, p.x - r.right);
      const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
      return Math.hypot(dx, dy);
    };

    for (const { el, rect } of targets) {
      if (rect.width >= min && rect.height >= min) continue;
      const c = centre(rect);
      const crowder = targets.find((other) => {
        if (other.el === el || other.el.contains(el) || el.contains(other.el)) return false;
        const undersized = other.rect.width < min || other.rect.height < min;
        // The circle may not reach another target's box, nor — for a second
        // undersized target — the circle around it.
        return undersized
          ? Math.hypot(c.x - centre(other.rect).x, c.y - centre(other.rect).y) < min
          : gap(c, other.rect) < radius;
      });
      if (crowder) {
        problems.push(
          `${describe(el)} is ${Math.round(rect.width)}x${Math.round(rect.height)}px and ` +
            `${Math.round(
              Math.hypot(c.x - centre(crowder.rect).x, c.y - centre(crowder.rect).y)
            )}px from ${describe(crowder.el)} — under the ${min}px target size (WCAG 2.5.8)`
        );
      }
    }
    return [...new Set(problems)];
  }, MIN_TAP_TARGET);
}
