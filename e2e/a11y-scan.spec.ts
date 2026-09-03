import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

// Role-based WCAG scan (#862, story #826).
//
// This spec MEASURES; it fixes nothing. Every violation that exists today is
// frozen into e2e/a11y-baseline.json, so the suite stays green on the current
// state of the app while any NEW critical/serious violation fails the run —
// that is the regression gate the epic is built on. The severity-classified
// report for humans lives in docs/a11y-audit.md; both files are regenerated
// together with:
//
//   A11Y_UPDATE_BASELINE=1 npx playwright test e2e/a11y-scan.spec.ts
//
// moderate/minor findings are reported but never gate: they are the backlog,
// not the alarm.

const GATED_SEVERITIES = new Set(['critical', 'serious']);
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BASELINE_PATH = path.join(process.cwd(), 'e2e/a11y-baseline.json');
const REPORT_PATH = path.join(process.cwd(), 'docs/a11y-audit.md');
const UPDATE_BASELINE = process.env.A11Y_UPDATE_BASELINE === '1';

type Baseline = Record<string, Record<string, number>>;
type Finding = { page: string; rule: string; severity: string; help: string; selectors: string[] };

const baseline: Baseline = fs.existsSync(BASELINE_PATH)
  ? (JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline)
  : {};
const collected: Finding[] = [];
// Every context appends here; a single test at the end asserts the whole list.
// `describe.configure({ mode: 'serial' })` skips the remaining tests once one
// fails, so asserting inside a context would hide every context after it — the
// run would only ever reveal the first bad page.
const allRegressions: string[] = [];

async function scan(page: Page, key: string) {
  // The app never goes network-idle (TimezoneSync + <Link> prefetch, #1081),
  // so settle on the DOM instead of waiting for silence.
  await page.waitForLoadState('domcontentloaded');
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const findings: Finding[] = results.violations.map((v) => ({
    page: key,
    rule: v.id,
    severity: v.impact ?? 'minor',
    help: v.help,
    selectors: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
  }));
  collected.push(...findings);

  // Gate: counts per rule, compared against the frozen baseline for this page.
  const gated = findings.filter((f) => GATED_SEVERITIES.has(f.severity));
  const counts: Record<string, number> = {};
  for (const f of gated) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  const allowed = baseline[key] ?? {};
  const regressions = Object.entries(counts)
    .filter(([rule, n]) => n > (allowed[rule] ?? 0))
    .map(([rule, n]) => {
      const f = gated.find((x) => x.rule === rule)!;
      return `${key}: ${rule} (${f.severity}) ×${n} > baseline ${allowed[rule] ?? 0} — ${f.selectors[0] ?? ''}`;
    });
  return { counts, regressions };
}

const freshCounts: Baseline = {};

/**
 * Force dark mode on the page currently loaded.
 *
 * Same technique as e2e/dark-mode.spec.ts, in the other direction: the class is
 * what globals.css keys its overrides off, and the cookie/localStorage keep the
 * choice across the client-side theme script re-running.
 */
async function forceDark(page: Page) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => {
    document.cookie = 'theme=dark; path=/; max-age=31536000';
    try { localStorage.setItem('theme', 'dark'); } catch { /* ignore */ }
  });
  // RELOAD, don't just add the class. Adding `.dark` to a page already rendered
  // light gives a HALF-dark document — light surfaces with dark-mode text
  // colours on them — and axe faithfully reports contrast failures that no real
  // user would ever see. Scanning that would freeze fiction into the baseline,
  // which is exactly what the widening warning above exists to prevent. The
  // reload lets the server and the theme script both commit to dark first.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 10_000 });
}

/**
 * Scan every page twice: light, then dark (#826).
 *
 * Dark mode is not cosmetic here. This codebase retints by REMAPPING utility
 * classes in globals.css (`html.dark .bg-white`, `.text-gray-*`, …) rather than
 * by writing `dark:` on each element, and the known trap is a mid-tone
 * `text-*-600/700` landing on a retinted `bg-*-50` box — dark on dark. Scanning
 * light only means the gate has never looked at half the product.
 *
 * Dark results are keyed `"<page>#dark"` so they gate independently: a
 * violation that exists only in dark mode gets its own baseline entry instead
 * of being averaged away against the light one.
 */
async function scanAll(page: Page, keys: string[]) {
  // Collect across every key and assert ONCE at the end, rather than failing at
  // the first bad page. `expect` throws, so a per-page assertion aborts the test
  // — and with `mode: 'serial'` it also skips the remaining contexts. That turns
  // a run into "learn one violation per CI cycle", which is how fixing this
  // spec's own findings took three round trips. One list, one run.
  const regressions: string[] = [];
  for (const key of keys) {
    await page.goto(key);
    const light = await scan(page, key);
    freshCounts[key] = light.counts;
    regressions.push(...light.regressions);

    await forceDark(page);
    const dark = await scan(page, `${key}#dark`);
    freshCounts[`${key}#dark`] = dark.counts;
    regressions.push(...dark.regressions);
    // Back to light before the next page, so one dark scan cannot leak into it.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => {
      document.cookie = 'theme=light; path=/; max-age=0';
      try { localStorage.removeItem('theme'); } catch { /* ignore */ }
    });
  }
  allRegressions.push(...regressions);
}

// Sign-in goes through the repo's own helper (e2e/helpers/auth.ts) rather than
// a hand-rolled one: it carries the guards this spec needs — a settled page
// before the form is filled, so a click never lands on an unhydrated button and
// turns into a native form POST (which is exactly how this spec failed first).
// Every authenticated test is also test.slow(), because it is often the first
// thing to touch these heavy routes in a dev run and pays their cold compile.

const PASSWORD = 'A11yScan123!';
const emails: string[] = [];
const seed = async (role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY', name: string) => {
  const email = uniqueEmail(`a11y-${role.toLowerCase()}`);
  emails.push(email);
  return { email, user: await seedUser(email, PASSWORD, role, name) };
};

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  if (UPDATE_BASELINE) {
    // Regenerating is how a FIX gets recorded — but the same write also lets a
    // NEW violation freeze itself in, silently, on a page nobody touched. That
    // is #1333: regenerating for /admin/candidates quietly widened /company
    // from {} to { color-contrast: 1 }. So say out loud what got wider, and
    // name it in the report, because a diff nobody reads is not a safeguard.
    const widened: string[] = [];
    for (const [key, counts] of Object.entries(freshCounts)) {
      const before = baseline[key] ?? {};
      for (const [rule, n] of Object.entries(counts)) {
        const was = before[rule] ?? 0;
        if (n > was) widened.push(`${key}: ${rule} ${was} → ${n}`);
      }
    }
    if (widened.length > 0) {
      console.warn(
        `\n⚠️  This regenerate WIDENS the accessibility baseline — new violations are being frozen in:\n` +
          widened.map((w) => `    ${w}`).join('\n') +
          `\n    Fix them, or say in the PR why they are being accepted.\n`
      );
    }
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(freshCounts, null, 2)}\n`);
    fs.writeFileSync(REPORT_PATH, renderReport(collected, widened));
  }
  for (const email of emails) await cleanupByEmail(email);
  await prisma.$disconnect();
});

// /accessibility carries the public conformance statement (#2035). A page that
// claims WCAG 2.2 AA and then fails the scan is the one embarrassment this gate
// exists to prevent, so it is scanned alongside the two pages every visitor
// sees — not left to the honour system.
test('public pages: landing, sign-in and the accessibility statement', async ({ page }) => {
  await scanAll(page, ['/', '/auth/signin', '/accessibility']);
});

// `/account` rides in the mentee context because it is the ONE settings page
// every authenticated role shares (src/app/account/layout.tsx guards on a
// session, not a role) — scanning it once here covers it for all of them, and
// the mentee view is the smallest: the mentor-only expertise card and the
// admin-only impersonation notice are both absent, so nothing role-specific
// can quietly widen the baseline from under a different context (#2041).
test('mentee portal: dashboard, profile and account settings', async ({ page }) => {
  test.slow();
  const { email } = await seed('MENTEE', 'A11y Mentee');
  await signInAsFreshUser(page, email, PASSWORD, '/portal');
  await scanAll(page, ['/portal', '/portal/profile', '/account']);
});

test('mentor: dashboard and mentee list', async ({ page }) => {
  test.slow();
  const { email } = await seed('MENTOR', 'A11y Mentor');
  await signInAsFreshUser(page, email, PASSWORD, '/mentor');
  await scanAll(page, ['/mentor', '/mentor/mentees']);
});

test('admin: dashboard and candidates', async ({ page }) => {
  test.slow();
  const { email } = await seed('ADMIN', 'A11y Admin');
  await signInAsFreshUser(page, email, PASSWORD, '/admin');
  await scanAll(page, ['/admin', '/admin/candidates']);
});

test('company: portal', async ({ page }) => {
  test.slow();
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  const company = await prisma.company.create({ data: { name: `A11y Co ${Date.now()}`, orgId: org.id } });
  const { email, user } = await seed('COMPANY', 'A11y Company User');
  await prisma.user.update({ where: { id: user.id }, data: { companyId: company.id, orgId: org.id } });
  try {
    await signInAsFreshUser(page, email, PASSWORD, '/company');
    await scanAll(page, ['/company']);
  } finally {
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
  }
});

// The gate itself, deliberately last: by now every context has scanned, so a
// failure here lists EVERY new violation in the product rather than the first
// one encountered.
test('no new critical or serious accessibility violations', async () => {
  test.skip(UPDATE_BASELINE, 'regenerating the baseline — nothing to gate against');
  expect(allRegressions, 'New critical/serious accessibility violations').toEqual([]);
});

// The severity-classified report, one line per violation so each can become
// its own good-first-issue.
function renderReport(findings: Finding[], widened: string[] = []): string {
  const order = ['critical', 'serious', 'moderate', 'minor'];
  const rank = (s: string) => {
    const i = order.indexOf(s);
    return i === -1 ? order.length : i;
  };
  const sorted = [...findings].sort((a, b) => rank(a.severity) - rank(b.severity) || a.page.localeCompare(b.page));
  const totals = order.map((s) => `${s}: ${findings.filter((f) => f.severity === s).length}`).join(' · ');
  const rows = sorted.length
    ? sorted
        .map((f) => `| \`${f.page}\` | \`${f.selectors[0] ?? '—'}\` | ${f.rule} | ${f.severity} | ${f.help} |`)
        .join('\n')
    : '| — | — | — | — | No violations found. |';
  return `# Accessibility audit (WCAG 2.2 AA)

<!-- GENERATED by e2e/a11y-scan.spec.ts — do not edit by hand.
     Regenerate: A11Y_UPDATE_BASELINE=1 npx playwright test e2e/a11y-scan.spec.ts -->

Automated axe-core scan of ten pages across five contexts (public, mentee,
mentor, admin, company). The scan **measures**; it fixes nothing. Every row
below is a candidate for its own good-first-issue.

**Totals** — ${totals}
${
  widened.length
    ? `\n> ⚠️ **The last regenerate widened the baseline.** These were newly frozen in rather than fixed:\n>\n${widened.map((w) => `> - \`${w}\``).join('\n')}\n`
    : ''
}

**The gate** (\`e2e/a11y-baseline.json\`): the counts of *critical* and *serious*
violations that exist today are frozen per page. A new one fails the scan;
moderate/minor findings are listed here but never gate.

| Page | Selector | Rule | Severity | Suggested fix (axe help) |
| --- | --- | --- | --- | --- |
${rows}
`;
}
