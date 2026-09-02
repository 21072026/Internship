import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import {
  prisma,
  seedUser,
  cleanupByEmail,
  uniqueEmail,
  seedMenteeWithRelation,
  cleanupMenteeWithRelation,
  type SeededRelation,
} from './helpers/db';
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
//
// Coverage (#2043): the first nine pages were the ones a bare seeded user can
// reach, which is a thin slice of the product to publish a conformance statement
// off. The list now also carries the six screens outside the mentee portal —
// /messages, /notifications, the mentor and admin boards, /admin/settings and
// the public /apply entry — scanned against a mentee who is really in a
// mentorship, so the boards have cards on them rather than an empty state.
//
// What that widening found, and where each finding went. Twelve serious/critical
// violations were already sitting on those screens; none of them were introduced
// by the widening. Three classes had a single obviously-correct fix and were
// fixed with it, so their baseline entries stay at zero:
//   - select-name (CRITICAL) — the two /admin/settings dropdowns had <label>s
//     that were never associated with them (htmlFor/id).
//   - scrollable-region-focusable — the admin board's stage rows could not be
//     panned without a mouse (tabIndex on HorizontalScrollArea's scroller).
//   - aria-command-name — the inbox's person-card trigger is an aria-hidden icon
//     in a role="button" and announced nothing (it now takes the person's name).
// The remaining nine ARE frozen into e2e/a11y-baseline.json, and that is the one
// thing this file's own warning tells you to justify rather than do quietly:
// eight of them are the single `text-gray-400` muted-text token at 2.38–2.53:1
// (plus its dark-mode mirror on the board header) and two are the 14x14px inbox
// trigger. Both are token/spacing changes that would move baseline keys on
// pages this task does not own, so they are #2131 — with the measurements — and
// docs/a11y-audit.md carries the row-by-row list. A frozen entry is a debt with
// an issue number, never a pass mark.

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
/**
 * One page to scan.
 *
 * A plain string means "the URL is also the baseline key", which is every static
 * route. The object form separates the two, and that is what the widened list
 * needs (#2043):
 *
 * - `url` — for a route whose address is not stable across runs. `/apply/<id>`
 *   carries a freshly seeded mentor's cuid, so keying on the URL would write a
 *   brand-new, never-matching baseline entry on every run; the key stays
 *   `/apply/:mentorId`.
 * - `ready` — awaited after the initial load AND again after `forceDark`'s
 *   reload. A client-fetched screen (the boards, /notifications) is still a
 *   skeleton at `domcontentloaded`, and a skeleton scans clean: it would freeze
 *   an empty page into the baseline and call it coverage. This is also where the
 *   "a board must have a card on it" assertion lives — an empty board proves
 *   nothing, so it fails loudly instead of passing quietly.
 */
type ScanTarget = string | { key: string; url?: string; ready?: (page: Page) => Promise<void> };

async function scanAll(page: Page, targets: ScanTarget[]) {
  // Collect across every key and assert ONCE at the end, rather than failing at
  // the first bad page. `expect` throws, so a per-page assertion aborts the test
  // — and with `mode: 'serial'` it also skips the remaining contexts. That turns
  // a run into "learn one violation per CI cycle", which is how fixing this
  // spec's own findings took three round trips. One list, one run.
  const regressions: string[] = [];
  for (const target of targets) {
    const key = typeof target === 'string' ? target : target.key;
    const url = typeof target === 'string' ? target : target.url ?? target.key;
    const ready = typeof target === 'string' ? undefined : target.ready;

    await page.goto(url);
    if (ready) await ready(page);
    const light = await scan(page, key);
    freshCounts[key] = light.counts;
    regressions.push(...light.regressions);

    await forceDark(page);
    if (ready) await ready(page);
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

// One mentee who is really in a mentorship, shared by every context that needs
// a relation on screen (#2043): the mentor board, the admin board, the inbox and
// the public application link that points at the mentor. Seeded once — the
// alternative is each context seeding its own pair, which triples the rows on
// the admin board (it lists every relation in the database) and makes the scans
// stop comparing like with like.
const RELATION_PREFIX = 'A11y Rel';
let related: SeededRelation;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  related = await seedMenteeWithRelation(RELATION_PREFIX, PASSWORD);
  // /notifications renders an empty-state paragraph with no rows at all, so
  // without these the scan would look at a page that has none of the markup it
  // is supposed to be measuring. One unread and one read: the unread row carries
  // the badge and the bolder text, which is where a contrast pair would hide.
  await prisma.notification.createMany({
    data: [
      {
        userId: related.menteeId,
        type: 'message.new',
        text: 'Seeded unread notification for the accessibility scan.',
        link: '/messages',
        read: false,
      },
      {
        userId: related.menteeId,
        type: 'meeting.scheduled',
        text: 'Seeded read notification for the accessibility scan.',
        link: '/portal/calendar',
        read: true,
      },
    ],
  });
});

/**
 * A board with nothing on it scans clean. Assert a card first, so a fixture that
 * silently stopped producing one fails the run instead of quietly reporting a
 * green empty page. Both boards mark their cards with the same testid.
 */
const boardHasCard = async (page: Page) => {
  await expect(page.getByTestId('board-card').first()).toBeVisible();
};

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
  if (related) await cleanupMenteeWithRelation(related);
  await prisma.$disconnect();
});

// /accessibility carries the public conformance statement (#2035). A page that
// claims WCAG 2.2 AA and then fails the scan is the one embarrassment this gate
// exists to prevent, so it is scanned alongside the two pages every visitor
// sees — not left to the honour system.
test('public pages: landing, sign-in, the statement and the application entry', async ({ page }) => {
  await scanAll(page, [
    '/',
    '/auth/signin',
    '/accessibility',
    {
      // The mentee application entry (#2043) — the one screen a candidate meets
      // before they have an account at all. Keyed without the mentor id so the
      // baseline entry survives the next run's fresh fixture.
      key: '/apply/:mentorId',
      url: `/apply/${related.mentorId}`,
      // The form only renders once the mentor link has resolved and is open;
      // before that the card holds a one-character placeholder.
      ready: async (p) => {
        await expect(p.locator('form').first()).toBeVisible();
      },
    },
  ]);
});

test('mentee portal: dashboard and profile', async ({ page }) => {
  test.slow();
  const { email } = await seed('MENTEE', 'A11y Mentee');
  await signInAsFreshUser(page, email, PASSWORD, '/portal');
  await scanAll(page, ['/portal', '/portal/profile']);
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

// The contexts below run on the shared relation fixture rather than a bare
// seeded user. Note that the four tests above are deliberately left on their
// thin fixtures: re-seeding them would change what /portal, /mentor and /admin
// render and silently widen baseline keys this task does not own (the mentee
// portal belongs to #1412).

test('mentee: inbox and notifications', async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, related.menteeEmail, PASSWORD, '/portal');
  await scanAll(page, [
    {
      key: '/messages',
      // Server-rendered, but the mentorship's conversation is created lazily on
      // this very request — wait for the thread row so the scan sees an inbox
      // with something in it.
      ready: async (p) => {
        await expect(p.getByText(`${RELATION_PREFIX} Mentor`).first()).toBeVisible();
      },
    },
    {
      key: '/notifications',
      ready: async (p) => {
        await expect(p.getByTestId('notifications-list')).toBeVisible();
      },
    },
  ]);
});

test('mentor: pipeline board', async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, related.mentorEmail, PASSWORD, '/mentor');
  await scanAll(page, [{ key: '/mentor/board', ready: boardHasCard }]);
});

test('admin: board and settings', async ({ page }) => {
  test.slow();
  const { email } = await seed('ADMIN', 'A11y Board Admin');
  await signInAsFreshUser(page, email, PASSWORD, '/admin');
  await scanAll(page, [
    { key: '/admin/board', ready: boardHasCard },
    {
      key: '/admin/settings',
      // Two waits, because this screen finishes in two stages: the form itself
      // (rendered immediately), then the email-health block, which only appears
      // once the SMTP probe answers. Scanning between the two is what would make
      // the counts differ from run to run — the ● / ○ status bullet is the one
      // mark that exists only after that response has landed.
      ready: async (p) => {
        await expect(p.locator('form').first()).toBeVisible();
        await expect(p.getByText(/[●○]/).first()).toBeVisible();
      },
    },
  ]);
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

Automated axe-core scan of sixteen pages across five contexts (public, mentee,
mentor, admin, company), each in light and dark. The scan **measures**; it fixes
nothing. Every row below is a candidate for its own good-first-issue.

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
