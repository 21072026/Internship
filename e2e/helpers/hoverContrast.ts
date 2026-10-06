import type { Page } from '@playwright/test';

// Hover-state contrast (#2765 follow-up).
//
// axe measures the page as it is at the moment of the scan, so a colour that
// only exists under `:hover` is seen only if the mouse happens to rest on that
// element. That is how #2703 shipped a chip that hovered to dark blue on a dark
// card through a green PR gate: in CI the pointer was elsewhere, locally it was
// not. The scan now parks the pointer (see `parkPointer`) so its result does not
// depend on where the pointer was left, and this check covers the hover states
// on purpose instead: every visible element that carries a `hover:text-*` (or,
// inside a `.group`, a `group-hover:text-*`) utility is hovered in turn and its
// text colour is measured against the background it actually sits on.
//
// The ratio is WCAG's (1.4.3): 4.5:1, or 3:1 for large text (24px, or 18.66px
// bold). Only solid backgrounds are judged: an element over a gradient or image
// cannot be measured from computed styles and is skipped rather than guessed.

export type HoverFinding = { selector: string; ratio: number; required: number; color: string; background: string };

/** Move the pointer off the page so nothing is hovered while axe scans. */
export async function parkPointer(page: Page) {
  await page.mouse.move(-1, -1);
}

/**
 * Turn CSS transitions off until the returned function is called. Most links
 * carry `transition-colors`, so a colour read right after a hover — or right
 * after the theme class lands on a reloaded page — is still on its way, and
 * the reading is of a colour nobody sees for long. Both axe and the hover
 * check measure end states only.
 */
export async function freezeTransitions(page: Page) {
  const tag = await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  return () => tag.evaluate((el) => (el as Element).remove()).catch(() => {});
}

/** Cap per page, so one long list cannot turn the gate into a ten-minute step. */
const MAX_PER_PAGE = 60;

export async function hoverContrastFindings(page: Page): Promise<HoverFinding[]> {
  const findings: HoverFinding[] = [];
  const thaw = await freezeTransitions(page);
  // Mark the candidates once; a re-render between hovers can replace nodes, so
  // each one is looked up again by its marker before it is hovered.
  const count = await page.evaluate((max) => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[class*="hover:text-"]'));
    let n = 0;
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none') continue;
      if (!el.textContent?.trim()) continue;
      if (n >= max) break;
      el.setAttribute('data-hover-probe', String(n++));
    }
    return n;
  }, MAX_PER_PAGE);

  for (let i = 0; i < count; i++) {
    const target = page.locator(`[data-hover-probe="${i}"]`);
    if ((await target.count()) === 0) continue;
    // A `group-hover:` colour changes when its `.group` ancestor is hovered.
    const isGroup = await target.evaluate((el) => /(^|\s)group-hover:text-/.test(el.className) && !!el.closest('.group'));
    const hoverTarget = isGroup ? target.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " group ")][1]') : target;
    try {
      await hoverTarget.hover({ timeout: 2_000 });
    } catch {
      continue; // covered by an overlay or detached mid-way: not hoverable, not judged
    }
    const result = await target.evaluate((el) => {
      const parse = (c: string) => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean);
        return { r: +r, g: +g, b: +b, a: +a };
      };
      type C = { r: number; g: number; b: number; a: number };
      const over = (top: C, under: C): C => ({
        r: top.r * top.a + under.r * (1 - top.a),
        g: top.g * top.a + under.g * (1 - top.a),
        b: top.b * top.a + under.b * (1 - top.a),
        a: 1,
      });
      // Collect backgrounds from the element up; stop at the first opaque one.
      const layers: C[] = [];
      let node: Element | null = el;
      while (node) {
        const s = getComputedStyle(node);
        if (s.backgroundImage && s.backgroundImage !== 'none') return null;
        const bg = parse(s.backgroundColor);
        if (bg && bg.a > 0) {
          layers.push(bg);
          if (bg.a >= 1) break;
        }
        node = node.parentElement;
      }
      let bg: C = { r: 255, g: 255, b: 255, a: 1 };
      for (let k = layers.length - 1; k >= 0; k--) bg = over(layers[k], bg);
      const fgRaw = parse(getComputedStyle(el).color);
      if (!fgRaw) return null;
      const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
      const lum = (c: C) => {
        const ch = [c.r, c.g, c.b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
      };
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const s = getComputedStyle(el);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
      const tag = el.tagName.toLowerCase();
      const testId = el.getAttribute('data-testid');
      const href = el.getAttribute('href');
      const label = testId ? `[data-testid="${testId}"]` : href ? `[href="${href}"]` : `"${(el.textContent ?? '').trim().slice(0, 40)}"`;
      return {
        selector: `${tag}${label}`,
        ratio: Math.round(ratio * 100) / 100,
        required: large ? 3 : 4.5,
        color: getComputedStyle(el).color,
        background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      };
    });
    if (result && result.ratio < result.required) findings.push(result);
  }
  await page.evaluate(() => document.querySelectorAll('[data-hover-probe]').forEach((el) => el.removeAttribute('data-hover-probe')));
  await thaw();
  await parkPointer(page);
  return findings;
}
