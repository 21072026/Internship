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
  if (!UPDATE_BASELINE) {
    expect(regressions, `New critical/serious accessibility violations on ${key}`).toEqual([]);
  }
  return counts;
}

const freshCounts: Baseline = {};
async function scanAll(page: Page, keys: string[]) {
  for (const key of keys) {
    await page.goto(key);
    freshCounts[key] = await scan(page, key);
  }
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
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(freshCounts, null, 2)}\n`);
    fs.writeFileSync(REPORT_PATH, renderReport(collected));
  }
  for (const email of emails) await cleanupByEmail(email);
  await prisma.$disconnect();
});

test('public pages: landing and sign-in', async ({ page }) => {
  await scanAll(page, ['/', '/auth/signin']);
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

// The severity-classified report, one line per violation so each can become
// its own good-first-issue.
function renderReport(findings: Finding[]): string {
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

Automated axe-core scan of nine pages across five contexts (public, mentee,
mentor, admin, company). The scan **measures**; it fixes nothing. Every row
below is a candidate for its own good-first-issue.

**Totals** — ${totals}

**The gate** (\`e2e/a11y-baseline.json\`): the counts of *critical* and *serious*
violations that exist today are frozen per page. A new one fails the scan;
moderate/minor findings are listed here but never gate.

| Page | Selector | Rule | Severity | Suggested fix (axe help) |
| --- | --- | --- | --- | --- |
${rows}
`;
}
