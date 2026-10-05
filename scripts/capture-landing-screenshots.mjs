#!/usr/bin/env node
// Landing-page product screenshots (#1399) — a PRODUCER, not a test.
//
// The landing used to describe the product in words only: a visitor read
// "pipeline tracking" and had to sign up for the demo to see what that meant.
// This script drives three real screens against the LOCAL demo seed and writes
// them into public/screenshots/, where src/components/landing/ProductTour.tsx
// shows them. Each screen is captured four times — light/dark × desktop/phone —
// because the landing follows the visitor's theme and a phone gets the phone
// layout, not a shrunken desktop.
//
// Synthetic data only (docs/DATA_ACCESS_POLICY.md): the accounts below are the
// `@demo.example.com` set from `npm run seed:demo`, and the script refuses a
// BASE_URL that is not localhost — a screenshot of a shared environment is a
// screenshot of whatever real people that environment holds.
//
//     npx prisma db seed && npm run seed:demo
//     npm run build && npm run start            # a production build: no dev badge
//     npm run capture:landing                   # all three screens
//     npm run capture:landing -- mentor         # one screen
//
// It never runs in CI. Re-run it when one of the three screens changes enough
// that the landing would be showing an old product, and commit the WebP files.
// See public/screenshots/README.md.

import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { mkdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(BASE_URL)) {
  console.error(`capture-landing-screenshots: BASE_URL ${BASE_URL} is not local. Refusing — capture against the local demo seed only.`);
  process.exit(1);
}

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'screenshots');
const PASSWORD = 'DemoPass123!';
/** The landing caps each file here (#1399); a larger capture fails the run. */
const MAX_KB = 200;
/** Breathing room around the cropped region, in CSS px. */
const PAD = 24;

const VIEWPORTS = {
  // Desktop at 1x: the image is shown at most ~700 CSS px wide, so a 1x capture
  // of a 1180 px content area is already ~1.7x density there.
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, maxHeight: 900 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, maxHeight: 844, isMobile: true, hasTouch: true },
};

/**
 * One entry per landing screenshot. `open` navigates to the screen and `ready`
 * is the element whose arrival means it has rendered. The crop is the content
 * area (no sidebar), from just above `startAt` to just below `endAt` — the
 * app's top bar and the empty space under a short page are not the product.
 * Without them it falls back to the content area's top and one viewport height.
 */
const SCREENS = {
  mentee: {
    email: 'mentee.gizem@demo.example.com',
    landing: '/portal',
    open: (page) => page.goto(`${BASE_URL}/portal/journey`),
    ready: (page) => page.getByTestId('journey-tracker'),
    startAt: (page) => page.getByTestId('journey-tracker'),
    endAt: (page) => page.getByTestId('journey-tracker'),
  },
  mentor: {
    email: 'mentor.aylin@demo.example.com',
    landing: '/mentor',
    open: (page) => page.goto(`${BASE_URL}/mentor/board`),
    ready: (page) => page.getByTestId('board-card').first(),
    startAt: (page) => page.getByRole('heading', { level: 1 }),
    // The desktop board is columns; a phone gets one stage at a time.
    endAt: (page) => page.locator('[data-testid="board-columns"]:visible, [data-testid="board-mobile"]:visible'),
  },
  company: {
    email: 'company.1@demo.example.com',
    landing: '/company',
    open: async (page) => {
      await page.goto(`${BASE_URL}/company`);
      await page.getByText('Hakan Demo', { exact: true }).click();
      await page.waitForURL(/\/company\/candidates\/[^/]+$/);
    },
    ready: (page) => page.getByRole('button', { name: 'Shortlisted' }),
    startAt: (page) => page.getByRole('link', { name: 'Back to candidates' }),
    endAt: (page) => page.getByRole('textbox'),
    endPad: 2,
  },
};

const CONSENT = JSON.stringify({ version: 3, necessary: true, analytics: false, marketing: false, ts: '2026-01-01T00:00:00.000Z' });

async function capture(browser, name, screen, device, theme) {
  const { maxHeight, ...contextOptions } = VIEWPORTS[device];
  const context = await browser.newContext({ ...contextOptions, locale: 'en-US', colorScheme: theme, reducedMotion: 'reduce' });
  // A returning visitor: no consent banner over the screen. The theme cookie is
  // what the no-flash script in src/app/layout.tsx reads first.
  await context.addInitScript((consent) => localStorage.setItem('cookie_consent', consent), CONSENT);
  await context.addCookies([
    { name: 'theme', value: theme, url: BASE_URL },
    { name: 'locale', value: 'en', url: BASE_URL },
  ]);
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/auth/signin`);
    await page.fill('input[type="email"]', screen.email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith(screen.landing), { timeout: 30_000 });

    await screen.open(page);
    await screen.ready(page).waitFor({ state: 'visible', timeout: 30_000 });
    // The desktop top strip (search, messages, bell) is app chrome and would
    // poke into the top of a crop; hidden, not removed, so nothing reflows.
    await page.addStyleTag({ content: '#main-content > .no-print:first-child { visibility: hidden !important; }' });
    // Fonts and the post-mount fetches (badges, counts) settle.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);

    const main = await page.locator('#main-content').boundingBox();
    if (!main) throw new Error(`${name}: no #main-content`);
    const box = async (pick) => (pick ? screen[pick] && (await screen[pick](page).first().boundingBox()) : null);
    const start = await box('startAt');
    const end = await box('endAt');
    const top = start ? Math.max(main.y, start.y - PAD) : main.y;
    // The company screen ends at its note box, which sits inside a card: the
    // extra pad keeps that card's bottom edge in the picture.
    const bottom = end ? end.y + end.height + PAD * (screen.endPad ?? 1) : Math.min(main.y + main.height, top + maxHeight);
    const clip = { x: main.x, y: top, width: main.width, height: Math.round(bottom - top) };
    const png = await page.screenshot({ clip, fullPage: true, animations: 'disabled' });

    mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${name}-${device}-${theme}.webp`);
    const { width, height } = await sharp(png).webp({ quality: 80, effort: 6 }).toFile(file);
    const kb = statSync(file).size / 1024;
    console.log(`captured public/screenshots/${path.basename(file)}  ${width}×${height}  ${kb.toFixed(0)} KB`);
    if (kb > MAX_KB) throw new Error(`${path.basename(file)} is ${kb.toFixed(0)} KB — over the ${MAX_KB} KB budget`);
    return { file: path.basename(file), width, height };
  } finally {
    await context.close();
  }
}

const only = process.argv.slice(2);
const names = only.length ? only : Object.keys(SCREENS);
for (const n of names) if (!SCREENS[n]) { console.error(`unknown screen "${n}" — one of ${Object.keys(SCREENS).join(', ')}`); process.exit(1); }

const browser = await chromium.launch();
const sizes = {};
try {
  for (const name of names) {
    for (const device of Object.keys(VIEWPORTS)) {
      for (const theme of ['light', 'dark']) {
        const { width, height } = await capture(browser, name, SCREENS[name], device, theme);
        sizes[`${name}-${device}`] = { width, height };
      }
    }
  }
} finally {
  await browser.close();
}
// The light and dark crops of one screen share a size; ProductTour.tsx needs
// these numbers as each image's width/height (no layout shift).
console.log('\nsizes for src/components/landing/productTourShots.ts:');
console.log(JSON.stringify(sizes, null, 2));
