#!/usr/bin/env node
// Guard: white text may not sit on an accent surface that is too light for it.
//
// Why this exists. #1299 was filed as "six pages fail WCAG AA text contrast",
// and by the time it was picked up all six of the *nodes* it named had been
// fixed (#1336/#1482) and the muted-text token had been raised once for
// everybody (#2131). The rule kept coming back anyway, because the thing nobody
// wrote down is the pair, not the page: a solid `bg-<hue>-500`/`-600` with
// `text-white` on it. Tailwind's mid shades are chosen to look good, not to
// clear 4.5:1 under white — amber-500 is 2.15:1, green-500 2.28:1, amber-600
// 3.19:1, green-600 3.30:1, red-500 3.76:1 — so every new "success" button and
// unread badge re-introduced the same serious violation on whichever screen it
// landed on. Fourteen call sites had drifted onto it.
//
// Why the existing e2e gate was green on all fourteen: the "Accessibility
// regression gate" step in `e2e.yml` is unconditional, but it runs AFTER the
// smoke step — so on a job whose smoke step fails it never runs at all. This
// check is deliberately outside Playwright for that reason: no browser, no
// database, nothing upstream of it that can fail first.
//
// The threshold is the app's own primary button: `bg-blue-600 text-white` is
// 5.17:1 and has always been fine. The rule here is simply "be at least as
// readable as the primary button already is" — in practice red-600 (4.83:1),
// amber-700 (5.02:1) and green-700 (5.02:1).
//
// Deliberately narrow. It checks ONE pair — white foreground, solid accent
// background, both reaching the same element — because that pair can be judged
// from the source alone: white is white in both themes, and a solid `bg-*-N`
// composites against nothing. Everything that needs the rendered document
// (inherited backgrounds, translucent surfaces, the dark-mode remaps in
// globals.css) stays the job of e2e/a11y-scan.spec.ts, which measures the
// composited colour in a real browser. This is the cheap half, and it is the
// half that runs on every push in under a second.
//
// "Same element" spans two shapes, because the first version only handled one
// and therefore could not protect one of the very call sites it had just fixed:
//   (1) one string literal — a plain className, or a class map / lookup table,
//       which is not a className attribute at all;
//   (2) a whole className attribute whose `text-white` is UNCONDITIONAL, in
//       which case every background anywhere in that attribute (any ternary
//       arm) has to clear AA under it.
// A conditional white label is NOT paired with another arm's background: that
// reports the ordinary toggle at a fictional 1.02:1, and a gate that cries wolf
// gets bypassed. Both directions are pinned by
// scripts/test/contrast-guard.test.mjs (`npm run test:contrast-guard`).
//
// Not covered, on purpose: mid-tone accent text on a light `bg-*-100` chip
// (icon containers on / and /features measure 2.86-4.24:1, which meets the 3:1
// of WCAG 1.4.11 for a glyph but not 4.5:1 for text) and `text-gray-500` on
// `bg-gray-100` (4.39:1, seven call sites in the projects/messages/todos
// surfaces). Both are real, both are a different pair, and folding them in here
// would have this guard fail on code #1299 does not touch.
//
// Run: node scripts/check-contrast.mjs   (npm run check:contrast)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import colors from 'tailwindcss/colors.js';

// WCAG 2.2 AA, normal text. Large text (1.4.3) and non-text (1.4.11) ask 3:1,
// but a solid surface carrying white text is nearly always a label or a badge
// count, so the stricter number is the right default; a genuine exception goes
// in EXEMPT below with its measured ratio.
const AA_NORMAL = 4.5;

// Overridable so the guard itself can be exercised against a fixture.
const ROOTS = process.argv.length > 2 ? process.argv.slice(2) : ['src'];

// A pair that is deliberately accepted: `file:line` → reason. Empty today, and
// an entry must carry the measured ratio and why it is allowed — never a bare
// "known issue", which is how a baseline becomes a graveyard.
const EXEMPT = new Map();

// --- contrast -------------------------------------------------------------
const toRgb = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a, b) {
  const [l1, l2] = [luminance(toRgb(a)), luminance(toRgb(b))];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function shadeHex(hue, shade) {
  const palette = colors[hue];
  if (!palette || typeof palette !== 'object') return null;
  const hex = palette[shade];
  return typeof hex === 'string' && hex.startsWith('#') ? hex : null;
}

/** The lightest shade of this hue that white text may sit on. */
function firstPassingShade(hue) {
  for (const shade of [500, 600, 700, 800, 900, 950]) {
    const hex = shadeHex(hue, shade);
    if (hex && contrast('#ffffff', hex) >= AA_NORMAL) return `${hue}-${shade} (${contrast('#ffffff', hex).toFixed(2)}:1)`;
  }
  return `a darker shade of ${hue}`;
}

// --- source scan ----------------------------------------------------------
function sourceFiles(paths) {
  const out = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry));
    } else if (/\.[cm]?[jt]sx?$/.test(p)) {
      out.push(p);
    }
  };
  for (const p of paths) walk(p);
  return out;
}

/**
 * Blank out comments, preserving newlines so line numbers (and every offset)
 * stay true.
 *
 * Needed because the fixes for this very rule are explained in comments that
 * quote the class they replaced ("green-500 was 2.28:1"), and a guard that
 * fails on its own documentation teaches people to delete the documentation.
 *
 * The scanner tracks string and template state, because a `//` inside a string
 * literal is not a comment. Without that, an ordinary
 * `href="https://meet.google.com/x" className="bg-red-500 text-white"` had the
 * rest of its line blanked from the `//` in the URL onwards, hiding the
 * className that followed it — and the meeting-join surfaces this rule cares
 * about are exactly the ones carrying external links. `/*` in a string had the
 * same effect, only unbounded: it swallowed everything up to the next `*` `/`.
 */
function stripComments(src) {
  const out = [];
  let i = 0;
  // `quote` is the delimiter we are inside, or null at top level. Template
  // literals are treated as plain strings on purpose: an interpolation cannot
  // open a comment that matters here, and nesting a full expression parser
  // would buy nothing.
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out.push(c);
      if (c === '\\') {
        // Escape: copy the escaped character too, so `'\\''` does not read as a
        // closing quote.
        if (i + 1 < src.length) out.push(src[i + 1]);
        i += src[i + 1] === undefined ? 1 : 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out.push(c);
      i += 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') { out.push(' '); i += 1; }
    } else if (two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') { out.push(src[i] === '\n' ? '\n' : ' '); i += 1; }
      out.push('  ');
      i += 2;
    } else {
      out.push(c);
      i += 1;
    }
  }
  return out.join('');
}

// One className literal, on one line. `[^'"`\n]` keeps this to a single line on
// purpose: a class list that wraps is matched per line, and a pair split across
// two lines of the same attribute is still caught because `text-white` and the
// background are then two findings' worth of the same string only if both are
// present — which is exactly the case worth reporting.
const LITERAL = /(['"`])([^'"`\n]*?(?:text-white|bg-)[^'"`\n]*?)\1/g;
// `bg-red-500` and `dark:bg-red-500` / `dark:!bg-red-500` — but NOT
// `bg-red-500/40` (a translucent surface composites against whatever is behind
// it, which this static check cannot know), not `bg-gradient-*`, and no other
// variant: `hover:`/`focus:` are transient states, which 1.4.3 does not gate.
const SOLID_BG = /(?:^|\s)(dark:)?!?bg-([a-z]+)-(\d{2,3})(?![\d/])/g;
const HAS_WHITE_TEXT = /(?:^|\s)(?:dark:)?!?text-white(?![\w-])/;
// A literal that also flips the text colour in dark mode is a full inversion —
// `bg-gray-900 text-white … dark:bg-gray-100 dark:text-gray-900` — so its dark
// background never carries the white label and must not be measured against it.
const INVERTS_TEXT_IN_DARK = /(?:^|\s)dark:!?text-(?!white(?![\w-]))/;

/**
 * The whole value of a `className=` attribute, however many lines and
 * interpolations it spans: `className="…"`, `className={\`…\`}`,
 * `className={cond ? '…' : '…'}`. Returns `{ value, start }` per attribute,
 * with `start` an offset into `src` so findings keep true line numbers.
 *
 * Needed because the single-line LITERAL scan below cannot see the commonest
 * conditional shape in this codebase — `text-white` sitting in the static text
 * of a template literal with the accent background in a ternary arm on the next
 * line, as in src/components/UpcomingMeetingBanner.tsx. Fifteen call sites were
 * fixed for #1299 and the guard could not protect that one.
 */
function classNameRegions(src) {
  const out = [];
  const attr = /className\s*=\s*/g;
  for (const m of src.matchAll(attr)) {
    let i = m.index + m[0].length;
    const start = i;
    const open = src[i];
    if (open === '"' || open === "'") {
      i += 1;
      while (i < src.length && src[i] !== open) i += 1;
      out.push({ value: src.slice(start + 1, i), start: start + 1 });
    } else if (open === '{') {
      // Walk to the matching brace, skipping over string and template runs so a
      // `}` inside a class list does not end the attribute early.
      let depth = 0;
      let quote = null;
      while (i < src.length) {
        const c = src[i];
        if (quote) {
          if (c === '\\') { i += 2; continue; }
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === '`') {
          quote = c;
        } else if (c === '{') {
          depth += 1;
        } else if (c === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        i += 1;
      }
      out.push({ value: src.slice(start + 1, i), start: start + 1 });
    }
  }
  return out;
}

/**
 * The class tokens that are present UNCONDITIONALLY in a className region: the
 * static text of a template literal, i.e. everything outside `${…}`, with the
 * backticks and quotes of the region itself dropped.
 *
 * Why only the unconditional part carries the `text-white` test: if the white
 * label is applied no matter what, then EVERY background that can appear in the
 * region — any ternary arm, any lookup value — has to clear AA under it, and
 * that is decidable from the source. If `text-white` instead lives inside one
 * arm, the background in the *other* arm never sits under it, and pairing them
 * would fail the extremely common toggle
 * (`active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'`) at a
 * fictional 1.02:1. A false alarm in a push gate is worse than a miss, and that
 * shape is already covered per-arm by the LITERAL scan below.
 */
function unconditionalClasses(region) {
  let out = '';
  let i = 0;
  let depth = 0;
  while (i < region.length) {
    if (depth === 0 && region.slice(i, i + 2) === '${') {
      depth = 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (depth > 0) {
      if (region[i] === '{') depth += 1;
      else if (region[i] === '}') depth -= 1;
      i += 1;
      continue;
    }
    out += region[i];
    i += 1;
  }
  // Quotes and backticks are separators, not class characters.
  return out.replace(/[`'"]/g, ' ');
}

const findings = [];
const seen = new Set();
function record(file, src, offset, cls, isDark, hue, shade) {
  const hex = shadeHex(hue, shade);
  if (!hex) return;
  const ratio = contrast('#ffffff', hex);
  if (ratio >= AA_NORMAL) return;
  const line = src.slice(0, offset).split('\n').length;
  const where = `${file}:${line}`;
  if (EXEMPT.has(where)) return;
  const pair = `text-white on ${isDark ? 'dark:' : ''}bg-${hue}-${shade}`;
  // The two scans overlap by design (a single-line `text-white bg-red-500` is
  // both a literal and a className region), so the same pair on the same line
  // is reported once.
  const key = `${where} ${pair}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ where, cls: cls.trim().replace(/\s+/g, ' '), pair, hex, ratio, hue });
}

for (const file of sourceFiles(ROOTS)) {
  const src = stripComments(readFileSync(file, 'utf8'));

  // (1) Whole className attributes, for the conditional/multi-line shape.
  for (const region of classNameRegions(src)) {
    const staticCls = ` ${unconditionalClasses(region.value)} `;
    if (!HAS_WHITE_TEXT.test(staticCls)) continue;
    const invertsInDark = INVERTS_TEXT_IN_DARK.test(staticCls);
    // The whole region, so an interpolated arm's background is measured too.
    for (const bg of ` ${region.value.replace(/[`'"]/g, ' ')} `.matchAll(SOLID_BG)) {
      const [isDark, hue, shade] = [Boolean(bg[1]), bg[2], bg[3]];
      if (isDark && invertsInDark) continue;
      record(file, src, region.start + Math.max(0, bg.index - 1), region.value, isDark, hue, shade);
    }
  }

  // (2) Single literals, which also covers class maps and lookup tables —
  //     `const TONE = { danger: 'bg-red-500 text-white' }` is not a className
  //     attribute and would be invisible to (1).
  for (const literal of src.matchAll(LITERAL)) {
    const cls = ` ${literal[2]} `;
    if (!HAS_WHITE_TEXT.test(cls)) continue;
    const invertsInDark = INVERTS_TEXT_IN_DARK.test(cls);
    for (const bg of cls.matchAll(SOLID_BG)) {
      const [isDark, hue, shade] = [Boolean(bg[1]), bg[2], bg[3]];
      if (isDark && invertsInDark) continue;
      record(file, src, literal.index, literal[2], isDark, hue, shade);
    }
  }
}

if (findings.length > 0) {
  console.error(`\n✖ White text on a surface below WCAG AA (${AA_NORMAL}:1) — ${findings.length} occurrence(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.where}`);
    console.error(`    ${f.pair} (${f.hex}) measures ${f.ratio.toFixed(2)}:1`);
    console.error(`    use ${firstPassingShade(f.hue)}, and step the hover shade down with it`);
    console.error(`    class: ${f.cls.length > 140 ? `${f.cls.slice(0, 137)}…` : f.cls}\n`);
  }
  console.error(
    'Darken the surface rather than the text: the label is white in both themes, so this\n' +
      'is one shade, not a dark-mode override. If a case is genuinely exempt (a decorative\n' +
      'glyph at 3:1), add it to EXEMPT in scripts/check-contrast.mjs with its measured ratio.\n'
  );
  process.exit(1);
}

console.log('✓ contrast: every text-white surface clears WCAG AA (4.5:1)');
