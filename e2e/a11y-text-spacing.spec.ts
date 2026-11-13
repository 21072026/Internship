import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';
import { setLocale } from './helpers/layoutAudit';

// WCAG 1.4.12 Text Spacing (#2864). The criterion: with line height 1.5×,
// paragraph spacing 2× the font size, letter spacing 0.12× and word spacing
// 0.16×, no content or functionality is lost. This applies exactly that
// override (the W3C bookmarklet's values, all `!important`, so no author style
// wins) and compares the page with itself:
//
//   a finding is an element that CLIPS its own text with the override on
//   (overflow hidden/clip and its content taller or wider than its box) but
//   did NOT clip without it — i.e. a loss the spacing caused — or a page that
//   starts scrolling sideways because of it.
//
// Two kinds of truncation are excluded on purpose, because they cut the text
// before the override too and are a design choice with the full text one
// click away, not a spacing failure: `line-clamp` (-webkit-line-clamp) and
// single-line `truncate` (text-overflow: ellipsis). Everything else that
// starts clipping is reported with its selector and text, so a red run names
// the element to make flexible.
//
// German, because its strings are the longest of the three dictionaries.

const SPACING_CSS = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

type Clip = { key: string; text: string };

async function clippedText(page: Page): Promise<{ clips: Clip[]; sideways: boolean }> {
  return page.evaluate(() => {
    const clips: Array<{ key: string; text: string }> = [];
    const keyOf = (el: Element) => {
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node !== document.body && parts.length < 6) {
        const parent: Element | null = node.parentElement;
        const index = parent ? Array.from(parent.children).indexOf(node) : 0;
        const tid = node.getAttribute('data-testid');
        parts.unshift(tid ? `[data-testid="${tid}"]` : `${node.tagName.toLowerCase()}:nth-child(${index + 1})`);
        if (tid) break;
        node = parent;
      }
      return parts.join(' > ');
    };
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue; // not rendered
      const cs = getComputedStyle(el);
      const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      if (!clipsX && !clipsY) continue;
      // Deliberate truncation (see the header): clamped or ellipsised text.
      const clamp = cs.getPropertyValue('-webkit-line-clamp');
      if ((clamp && clamp !== 'none') || cs.textOverflow === 'ellipsis') continue;
      // Only boxes that hold text of their own: an image wrapper or a scroll
      // shadow clipping its decoration is not content.
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      const text = (ownText || el.innerText || '').trim();
      if (!text) continue;
      const over = (clipsY && el.scrollHeight > el.clientHeight + 1) || (clipsX && el.scrollWidth > el.clientWidth + 1);
      if (over) clips.push({ key: keyOf(el), text: text.slice(0, 60) });
    }
    const sideways = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    return { clips, sideways };
  });
}

async function spacingLosses(page: Page, path: string): Promise<string[]> {
  await gotoSettled(page, path);
  await page.waitForLoadState('domcontentloaded');
  return lossesHere(page, path);
}

async function lossesHere(page: Page, path: string): Promise<string[]> {
  const before = await clippedText(page);
  const style = await page.addStyleTag({ content: SPACING_CSS });
  // Two frames: one for the style to apply, one for layout to settle.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await clippedText(page);
  await style.evaluate((el) => (el as unknown as HTMLElement).remove());
  const known = new Set(before.clips.map((c) => c.key));
  const losses = after.clips.filter((c) => !known.has(c.key)).map((c) => `${path}: ${c.key} clips "${c.text}"`);
  if (after.sideways && !before.sideways) losses.push(`${path}: the page scrolls sideways with text spacing applied`);
  return losses;
}

// The check must be able to fail: a fixed-height box whose text fits until
// the spacing is applied is exactly what it exists to catch, while a clamped
// line (deliberate truncation, see the header) is not reported.
test('text spacing (WCAG 1.4.12): the check reports a box that starts clipping', async ({ page }) => {
  await page.setContent(`<main>
    <div data-testid="fixed" style="width:300px;height:22px;overflow:hidden;font:16px/1.2 sans-serif">Short line of text that fits</div>
    <div data-testid="clamped" style="width:300px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;font:16px/1.2 sans-serif">Short line of text that fits</div>
  </main>`);
  const losses = await lossesHere(page, 'fixture');
  expect(losses).toEqual([expect.stringContaining('[data-testid="fixed"]')]);
});

async function setGerman(page: Page) {
  await setLocale(page, 'de');
}

test('text spacing (WCAG 1.4.12): public pages lose no text under the override', async ({ page }) => {
  test.slow();
  await setGerman(page);
  const losses: string[] = [];
  for (const path of ['/', '/auth/signin', '/features', '/accessibility', '/release-notes']) {
    losses.push(...(await spacingLosses(page, path)));
  }
  expect(losses).toEqual([]);
});

const ROLES = [
  { role: 'ADMIN' as const, landing: '/admin', paths: ['/admin', '/admin/candidates', '/admin/board', '/admin/settings'] },
  { role: 'MENTOR' as const, landing: '/mentor', paths: ['/mentor', '/mentor/board', '/messages', '/notifications'] },
  { role: 'MENTEE' as const, landing: '/portal', paths: ['/portal', '/messages'] },
];

for (const { role, landing, paths } of ROLES) {
  test(`text spacing (WCAG 1.4.12): the ${role.toLowerCase()} shell loses no text under the override`, async ({ page }) => {
    test.slow();
    const email = uniqueEmail(`spacing-${role.toLowerCase()}`);
    const otherEmail = uniqueEmail(`spacing-other-${role.toLowerCase()}`);
    const pw = 'TextSpacing123!';
    const me = await seedUser(email, pw, role, `Spacing ${role}`);
    // A relation so the boards and lists show cards, not their empty states.
    const other = role === 'MENTEE'
      ? await seedUser(otherEmail, pw, 'MENTOR', 'Spacing Mentor')
      : await seedUser(otherEmail, pw, 'MENTEE', 'Spacing Mentee');
    const relation = await prisma.mentorshipRelation.create({
      data: role === 'MENTEE' ? { mentorId: other.id, menteeId: me.id } : { mentorId: role === 'MENTOR' ? me.id : other.id, menteeId: role === 'MENTOR' ? other.id : me.id },
    }).catch(() => null);
    try {
      await setGerman(page);
      await signInAndSettle(page, email, pw, landing);
      const losses: string[] = [];
      for (const path of paths) losses.push(...(await spacingLosses(page, path)));
      expect(losses).toEqual([]);
    } finally {
      if (relation) await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      await cleanupByEmail(email);
      await cleanupByEmail(otherEmail);
    }
  });
}
