#!/usr/bin/env node
// Landing-page product screenshots and clips (#1399) — a PRODUCER, not a test.
//
// The landing used to describe the product in words only: a visitor read
// "pipeline tracking" and had to sign up for the demo to see what that meant.
// This script drives real screens against the LOCAL demo seed — three for the
// internship landing, three `mkt-*` ones for the MARKETING landing (the neutral coreCRM default),
// captured on marketing.localhost — and writes
// them into public/screenshots/, where src/components/landing/ProductTour.tsx
// shows them:
//   • a still per screen × light/dark × desktop/phone (WebP), and
//   • a short silent loop per screen × light/dark for desktop (WebM + MP4) —
//     the screen *doing* its one thing (a card moving stage, a candidate being
//     shortlisted). A video, not a GIF: a GIF of a 1600 px screen is several MB
//     and dithered; the same clip as VP9/H.264 is a few hundred KB and sharp.
//
// Every still of one device has the SAME frame — the whole viewport, 16:10 on
// desktop and the phone's own 390×844 — so the tour reads as one set instead of
// three ad-hoc crops of different heights (the first version cropped each screen
// to its content and got three different aspect ratios).
//
// Synthetic data only (docs/DATA_ACCESS_POLICY.md): the accounts below are the
// `@demo.example.com` set from `npm run seed:demo`, and the script refuses a
// BASE_URL that is not localhost — a screenshot of a shared environment is a
// screenshot of whatever real people that environment holds.
//
//     npx prisma db push --force-reset && npx prisma db seed && npm run seed:demo
//     npm run build && npm run start            # a production build: no dev badge
//     npm run capture:landing -- --theme=light  # all three screens, one theme
//     (reset + re-seed: the clips move a card and shortlist a candidate)
//     npm run capture:landing -- --theme=dark
//     npm run capture:landing -- mentor --theme=dark --no-video
//
// It never runs in CI. Needs ffmpeg on PATH for the clips. See
// public/screenshots/README.md.

import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
// The MARKETING product is the same server on another host name:
// the URL a person signs in on picks the product (docs/worlds.md). Locally that
// is marketing.localhost, which must be listed in the server's MARKETING_HOSTS.
const MARKETING_BASE_URL = process.env.MARKETING_BASE_URL || BASE_URL.replace(/\/\/(localhost|127\.0\.0\.1)/, '//marketing.localhost');
for (const url of [BASE_URL, MARKETING_BASE_URL]) {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|marketing\.localhost)(:\d+)?\/?$/.test(url)) {
    console.error(`capture-landing-screenshots: ${url} is not local. Refusing — capture against the local demo seed only.`);
    process.exit(1);
  }
}

// The UI language of the captures (#2808). English keeps the historical
// unsuffixed file names; Turkish and German get a `-tr` / `-de` suffix, so a
// visitor who reads the landing in their language also sees the product in it.
const LOCALE = process.argv.find((a) => a.startsWith('--locale='))?.split('=')[1] ?? 'en';
if (!['en', 'tr', 'de'].includes(LOCALE)) {
  console.error(`capture-landing-screenshots: --locale=${LOCALE} — one of en, tr, de.`);
  process.exit(1);
}
const SUFFIX = LOCALE === 'en' ? '' : `-${LOCALE}`;
/** The few visible strings a clip types or clicks, per language. */
const TEXT = {
  en: { shortlisted: 'Shortlisted', note: 'Strong .NET basics, good fit for our backend team.' },
  tr: { shortlisted: 'Kısa listeye aldım', note: 'Sağlam .NET temeli, backend ekibimize uygun.' },
  de: { shortlisted: 'Auf die Shortlist', note: 'Solide .NET-Grundlagen, passt gut ins Backend-Team.' },
}[LOCALE];

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'screenshots');
const PASSWORD = 'DemoPass123!';
/** Per-file budgets; a larger output fails the run. */
const MAX_STILL_KB = 200;
const MAX_CLIP_KB = 900;

// Output sizes are fixed — ProductTour.tsx's frames are built for exactly these
// ratios (16:10 and 390:844), and productTourShots.ts carries the numbers.
const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, out: { width: 1600, height: 1000 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, out: { width: 780, height: 1688 } },
};

// ---------------------------------------------------------------------------
// Staging helpers for the clips. A headless browser draws no mouse pointer and
// no native drag image, so the clip shows a drawn cursor (and, for the board, a
// lifted copy of the card) on top of the real page. What happens underneath is
// the real app: the stage change and the shortlist are real requests.

async function installCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__tour_cursor')) return;
    const c = document.createElement('div');
    c.id = '__tour_cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#111827" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: `translate(${innerWidth * 0.62}px, ${innerHeight * 0.78}px)`, transition: 'none' });
    document.body.appendChild(c);
  });
}

/** Glide the drawn cursor to (x, y) over `ms`. */
async function cursorTo(page, x, y, ms = 700) {
  await page.evaluate(([x, y, ms]) => new Promise((done) => {
    const c = document.getElementById('__tour_cursor');
    c.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
    c.style.transform = `translate(${x}px, ${y}px)`;
    setTimeout(done, ms + 30);
  }), [x, y, ms]);
}

async function center(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('target not on screen');
  return [b.x + b.width / 2, b.y + b.height / 2];
}

async function clickLike(page, locator) {
  const [x, y] = await center(locator);
  await cursorTo(page, x - 4, y - 4);
  await page.waitForTimeout(150);
  await locator.click();
}

/** Lift a copy of `card` and glide it (with the cursor) to `target`'s top. */
async function dragGhost(page, card, target, ms = 1300) {
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  await cursorTo(page, from.x + from.width / 2, from.y + 20);
  await page.waitForTimeout(250);
  await card.evaluate((el, [to, ms]) => new Promise((done) => {
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    Object.assign(ghost.style, {
      position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, margin: '0',
      zIndex: '2147483646', pointerEvents: 'none', boxShadow: '0 18px 40px rgba(0,0,0,.18)',
    });
    el.style.opacity = '0.35';
    document.body.appendChild(ghost);
    const dx = to.x + 12 - r.left;
    const dy = to.y + 52 - r.top;
    const easing = 'cubic-bezier(.4,0,.2,1)';
    ghost.animate([{ transform: 'translate(0,0) rotate(0deg)' }, { transform: 'translate(0,-6px) rotate(2deg)', offset: 0.15 }, { transform: `translate(${dx}px, ${dy}px) rotate(1deg)` }], { duration: ms, easing, fill: 'forwards' });
    const c = document.getElementById('__tour_cursor');
    c.style.transition = `transform ${ms}ms ${easing}`;
    c.style.transform = `translate(${to.x + r.width / 2}px, ${to.y + 72}px)`;
    setTimeout(() => { ghost.remove(); el.style.opacity = ''; done(); }, ms + 60);
  }), [{ x: to.x, y: to.y }, ms]);
}

// ---------------------------------------------------------------------------

/**
 * One entry per landing screen. `open` navigates and `ready` is the element
 * whose arrival means it has rendered. `play` is the clip's one action. `base`
 * is the host it is captured on — the internship host unless it says otherwise.
 * The `mkt-*` screens are the MARKETING landing's tour (neutral default brand), captured on
 * the marketing host against the seeded `demo-marketing` tenant.
 */
const SCREENS = {
  mentee: {
    email: 'mentee.gizem@demo.example.com',
    landing: '/portal',
    open: (page, base) => page.goto(`${base}/portal/journey`),
    ready: (page) => page.getByTestId('journey-tracker'),
    // The journey is a page you read top to bottom: the clip reads it, then
    // returns to the top so the loop has no seam. Scrolling is captured as
    // stepped screenshots, not the screencast — a screencast taken mid-scroll
    // catches half-repainted frames (the page torn across two positions).
    scroll: { distance: 520, seconds: 2.4, hold: 1.2 },
  },
  mentor: {
    email: 'mentor.aylin@demo.example.com',
    landing: '/mentor',
    open: (page, base) => page.goto(`${base}/mentor/board`),
    ready: (page) => page.getByTestId('board-card').first(),
    play: async (page) => {
      const card = page.getByTestId('board-card').filter({ hasText: 'Deniz Demo' });
      const target = page.getByTestId('board-card').filter({ hasText: 'Gizem Demo' });
      await installCursor(page);
      await dragGhost(page, card, target);
      // The real move — the same request the drop makes.
      // By stage key, not label: the label is in the capture's language.
      await card.getByRole('combobox').selectOption({ value: 'INTERNSHIP_IN_PROGRESS_450' });
      await page.getByTestId('board-card').filter({ hasText: 'Deniz Demo' }).first().waitFor();
      await cursorTo(page, 640, 620, 900);
    },
  },
  company: {
    email: 'company.1@demo.example.com',
    landing: '/company',
    open: async (page, base) => {
      await page.goto(`${base}/company`);
      await page.getByText('Hakan Demo', { exact: true }).click();
      await page.waitForURL(/\/company\/candidates\/[^/]+$/);
    },
    ready: (page) => page.getByRole('button', { name: TEXT.shortlisted }),
    play: async (page) => {
      await installCursor(page);
      await clickLike(page, page.getByRole('button', { name: TEXT.shortlisted }));
      await page.waitForTimeout(500);
      const note = page.getByRole('textbox');
      await clickLike(page, note);
      await note.pressSequentially(TEXT.note, { delay: 45 });
    },
  },
  // ── MARKETING (neutral default brand) ──────────────────────────────────────────────────
  'mkt-pipeline': {
    base: MARKETING_BASE_URL,
    email: 'admin.marketing@demo.example.com',
    landing: '/admin',
    open: (page, base) => page.goto(`${base}/admin/board`),
    ready: (page) => page.getByTestId('board-card').first(),
    play: async (page) => {
      const card = page.getByTestId('board-card').filter({ hasText: 'Jonas Weber' });
      const target = page.getByTestId('board-card').filter({ hasText: 'Tim Petersen' });
      await installCursor(page);
      await dragGhost(page, card, target);
      await card.getByRole('combobox').selectOption({ value: 'LEAD_CONTACTED' });
      await page.getByTestId('board-card').filter({ hasText: 'Jonas Weber' }).first().waitFor();
      await cursorTo(page, 760, 640, 900);
    },
  },
  'mkt-rep': {
    base: MARKETING_BASE_URL,
    email: 'owner.lena@demo.example.com',
    landing: '/sales',
    open: (page, base) => page.goto(`${base}/sales`),
    ready: (page) => page.getByTestId('sales-dashboard'),
    scroll: { distance: 480, seconds: 2.2, hold: 1.2 },
  },
  'mkt-insights': {
    base: MARKETING_BASE_URL,
    email: 'admin.marketing@demo.example.com',
    landing: '/admin',
    open: (page, base) => page.goto(`${base}/admin/analytics`),
    ready: (page) => page.getByTestId('funnel-kpi-card'),
    scroll: { distance: 560, seconds: 2.4, hold: 1.4 },
  },
};

const CONSENT = JSON.stringify({ version: 3, necessary: true, analytics: false, marketing: false, ts: '2026-01-01T00:00:00.000Z' });

async function signedInPage(browser, screen, device, theme) {
  const { out, ...contextOptions } = VIEWPORTS[device];
  const context = await browser.newContext({ ...contextOptions, locale: { en: 'en-US', tr: 'tr-TR', de: 'de-DE' }[LOCALE], colorScheme: theme, reducedMotion: 'reduce' });
  // A returning visitor: no consent banner over the screen. The theme cookie is
  // what the no-flash script in src/app/layout.tsx reads first.
  await context.addInitScript((consent) => localStorage.setItem('cookie_consent', consent), CONSENT);
  const base = screen.base ?? BASE_URL;
  await context.addCookies([
    { name: 'theme', value: theme, url: base },
    { name: 'locale', value: LOCALE, url: base },
  ]);
  const page = await context.newPage();
  await page.goto(`${base}/auth/signin`);
  await page.fill('input[type="email"]', screen.email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(screen.landing), { timeout: 30_000 });
  // Let the post-sign-in redirect finish: when the screen IS the landing page
  // (/sales), navigating there mid-redirect aborts with "interrupted by another
  // navigation".
  await page.waitForLoadState('load');
  await screen.open(page, base);
  await screen.ready(page).waitFor({ state: 'visible', timeout: 30_000 });
  // Fonts and the post-mount fetches (badges, counts) settle.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  return { context, page, out };
}

function checkSize(file, maxKb) {
  const kb = statSync(file).size / 1024;
  if (kb > maxKb) throw new Error(`${path.basename(file)} is ${kb.toFixed(0)} KB — over the ${maxKb} KB budget`);
  return kb;
}

async function still(browser, name, device, theme) {
  const { context, page, out } = await signedInPage(browser, SCREENS[name], device, theme);
  try {
    const png = await page.screenshot({ animations: 'disabled' });
    const file = path.join(OUT_DIR, `${name}-${device}-${theme}${SUFFIX}.webp`);
    await sharp(png).resize(out.width, out.height).webp({ quality: 78, effort: 6 }).toFile(file);
    console.log(`still  ${path.basename(file)}  ${out.width}×${out.height}  ${checkSize(file, MAX_STILL_KB).toFixed(0)} KB`);
  } finally {
    await context.close();
  }
}

/** A concat list of PNG frames → the WebM + MP4 pair for one clip. */
function encode(list, out, name, theme) {
  const vf = `scale=${out.width}:${out.height}:flags=lanczos,fps=30,format=yuv420p`;
  const base = path.join(OUT_DIR, `${name}-desktop-${theme}${SUFFIX}`);
  const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-an', ...args], { stdio: 'inherit' });
  ff(['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', `${base}.webm`]);
  ff(['-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-profile:v', 'high', '-movflags', '+faststart', `${base}.mp4`]);
  for (const ext of ['webm', 'mp4']) {
    console.log(`clip   ${path.basename(base)}.${ext}  ${out.width}×${out.height}  ${checkSize(`${base}.${ext}`, MAX_CLIP_KB).toFixed(0)} KB`);
  }
}

/** Down, hold, back up — one screenshot per 1/30 s of eased scroll position. */
async function steppedScroll(page, tmp, { distance, seconds, hold }, out, name, theme) {
  const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  const dist = Math.min(max, distance);
  const n = Math.round(seconds * 30);
  const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
  const ys = [0, ...Array.from({ length: n }, (_, i) => dist * ease((i + 1) / n))];
  const path_ = (i) => path.join(tmp, `f${String(i).padStart(5, '0')}.png`);
  const lines = [];
  for (let i = 0; i < ys.length; i++) {
    // `instant`: globals.css sets `scroll-behavior: smooth`, and a smooth
    // scrollTo is still travelling when the screenshot is taken.
    await page.evaluate((y) => new Promise((done) => {
      scrollTo({ top: y, behavior: 'instant' });
      requestAnimationFrame(() => requestAnimationFrame(done));
    }), Math.round(ys[i]));
    writeFileSync(path_(i), await page.screenshot({ animations: 'disabled' }));
    const dur = i === 0 ? 0.9 : i === ys.length - 1 ? hold : 1 / 30;
    lines.push(`file '${path_(i)}'`, `duration ${dur.toFixed(4)}`);
  }
  // The way back reuses the frames in reverse: same pixels, no second capture.
  for (let i = ys.length - 2; i >= 1; i--) lines.push(`file '${path_(i)}'`, `duration ${(1 / 30).toFixed(4)}`);
  lines.push(`file '${path_(0)}'`, 'duration 0.3', `file '${path_(0)}'`);
  const list = path.join(tmp, 'list.txt');
  writeFileSync(list, lines.join('\n'));
  encode(list, out, name, theme);
}

async function clip(browser, name, theme) {
  const { context, page, out } = await signedInPage(browser, SCREENS[name], 'desktop', theme);
  const tmp = mkdtempSync(path.join(os.tmpdir(), `tour-${name}-`));
  try {
    // CDP screencast: a frame per paint, with its timestamp — sharper than the
    // recordVideo encoder and with the real timing preserved.
    if (SCREENS[name].scroll) {
      await steppedScroll(page, tmp, SCREENS[name].scroll, out, name, theme);
      return;
    }
    const cdp = await context.newCDPSession(page);
    const frames = [];
    cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      frames.push({ data, t: metadata.timestamp });
      await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await page.waitForTimeout(900);
    const startT = Date.now() / 1000;
    await SCREENS[name].play(page);
    await page.waitForTimeout(1800);
    const endT = Date.now() / 1000;
    await cdp.send('Page.stopScreencast');
    if (frames.length < 2) throw new Error(`${name}: screencast produced ${frames.length} frame(s)`);

    // Hold the first frame a beat, then the real timing, then hold the end.
    const lines = [];
    frames.forEach((f, i) => {
      const file = path.join(tmp, `f${String(i).padStart(5, '0')}.png`);
      writeFileSync(file, Buffer.from(f.data, 'base64'));
      const next = i + 1 < frames.length ? frames[i + 1].t : f.t + Math.max(0.6, endT - startT - (f.t - frames[0].t));
      const dur = Math.max(1 / 30, next - f.t) + (i === 0 ? 0.6 : 0);
      lines.push(`file '${file}'`, `duration ${dur.toFixed(4)}`);
    });
    lines.push(`file '${path.join(tmp, `f${String(frames.length - 1).padStart(5, '0')}.png`)}'`);
    const list = path.join(tmp, 'list.txt');
    writeFileSync(list, lines.join('\n'));

    encode(list, out, name, theme);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await context.close();
  }
}

const args = process.argv.slice(2);
const themeArg = args.find((a) => a.startsWith('--theme='))?.split('=')[1];
const themes = themeArg ? [themeArg] : ['light', 'dark'];
const withVideo = !args.includes('--no-video');
const only = args.filter((a) => !a.startsWith('--'));
const names = only.length ? only : Object.keys(SCREENS);
for (const n of names) if (!SCREENS[n]) { console.error(`unknown screen "${n}" — one of ${Object.keys(SCREENS).join(', ')}`); process.exit(1); }
if (withVideo && themes.length > 1) {
  console.error('the clips change demo data (a card moves, a candidate is shortlisted): capture one --theme at a time and re-seed in between, or pass --no-video.');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
try {
  for (const name of names) {
    for (const theme of themes) {
      // Stills first: they show each screen before its clip changes the data.
      for (const device of Object.keys(VIEWPORTS)) await still(browser, name, device, theme);
      if (withVideo) await clip(browser, name, theme);
    }
  }
} finally {
  await browser.close();
}
