import { test, expect, type Page } from '@playwright/test';
import {
  prisma,
  seedUser,
  cleanupByEmail,
  uniqueEmail,
  seedMenteeWithRelation,
  cleanupMenteeWithRelation,
  type SeededRelation,
} from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import {
  PHONE,
  auditLayout,
  fixedOverlaps,
  setLocale,
  settle,
  settleStandalone,
  tapTargets,
} from './helpers/layoutAudit';

/**
 * The phone-layout audit, applied to the routes it never reached (#1615).
 *
 * `e2e/mobile-layout-audit.spec.ts` proved the method on about a dozen screens.
 * Coverage IS the value of a mechanical gate, though: an unaudited route is
 * exactly where the next German or Turkish label squeeze appears, and #1465,
 * #1485, #1486 and #1497 were all found this way. `AdminNav` declares 41
 * destinations; ten of them were measured. This file measures the other
 * thirty-one, plus the six person-scoped shells that live outside the role
 * layouts, plus the company and source shells — which nothing had ever measured
 * at any width.
 *
 * Same instruments, same file: everything comes from `helpers/layoutAudit.ts`
 * (`auditLayout` for the four overflow rules, `fixedOverlaps` for a bar parked
 * over the end of the page, `tapTargets` for WCAG 2.5.8 with its spacing
 * exception). Geometric assertions — bounding boxes and scroll metrics — never
 * screenshot diffs: a bounding box says which box is how many pixels too wide,
 * which is what a bug report needs.
 *
 * German throughout. The original spec records why (`:180-182`): /admin/analytics
 * and /admin/support fit in English and only overflowed once translated, and
 * German carries the longest labels of the three dictionaries.
 *
 * Three things to know before editing:
 *
 * 1. NOTHING IS TAGGED @smoke. The PR gate runs the smoke subset and has to stay
 *    at ~15-20 tests; a 40-route layout sweep belongs in the scheduled full
 *    suite, which is where this file runs (`.github/workflows/e2e-full.yml`).
 * 2. Findings are COLLECTED per group and asserted ONCE at the end of the group,
 *    rather than at each route. `expect` throws, so a per-route assertion turns a
 *    run into "learn one broken route per CI cycle" — the same trap
 *    `a11y-scan.spec.ts:185-187` documents having fallen into three times. One
 *    run should name every offending route.
 * 3. A route that never becomes ready is reported as a finding, not thrown as an
 *    error, for the same reason: a single 500 or a skeleton that never resolves
 *    would otherwise hide the layout of every route after it in the group.
 *
 * When a finding lands: it gets its OWN 🐛 issue with the route, viewport, locale
 * and pixel count, and if the fix is not small and local the route comes back out
 * of the list in that issue's PR rather than leaving the scheduled suite red
 * (#1615, step 5). Widening a rule so a route passes is never the answer — that
 * converts a real defect into a green tick.
 */

const PW = 'MobileCoverage123!';
// Per-route readiness budget. The default 20s x 8 routes would blow even a
// `test.slow()` timeout if a whole group stalled; 10s is comfortably above what
// a healthy route needs (2-4s) and keeps a bad group inside its budget.
const READY = 10_000;

/**
 * One route to measure. `standalone` marks the screens outside the role shells
 * (`/todos`, `/messages`, `/account`, …): they have no `account-menu-button`, so
 * their own `<h1>` is the readiness signal instead.
 */
type Route = { path: string; standalone?: true };
const shell = (...paths: string[]): Route[] => paths.map((path) => ({ path }));
const standalone = (...paths: string[]): Route[] =>
  paths.map((path) => ({ path, standalone: true as const }));

// ---------------------------------------------------------------------------
// The route inventory. Split into groups small enough that no single test
// approaches the 60s `timeout` in playwright.config.ts even before test.slow()
// triples it (#1615, step 4).
// ---------------------------------------------------------------------------

/** The hiring funnel: requisition → offer → interview → decision. */
const FUNNEL: Route[] = [
  ...shell(
    '/admin/requisitions',
    '/admin/offers',
    '/admin/interview-requests',
    '/admin/duplicates',
    '/admin/mentor-applications',
    '/admin/company-inquiries',
    '/admin/invitations'
  ),
  // An AdminNav destination that is NOT an admin page: interview panels live
  // outside the role shells because an admin convenes them and mentors score
  // them (src/app/interviews/layout.tsx).
  ...standalone('/interviews'),
];

/** Programme setup: the reusable rows every other screen reads. */
const SETUP: Route[] = [
  ...shell(
    '/admin/projects',
    '/admin/goal-templates',
    '/admin/message-templates',
    '/admin/cohorts',
    '/admin/tags',
    '/admin/sources',
    '/admin/invite'
  ),
  ...standalone('/todos'),
];

/** Scheduling and everything that goes out by e-mail. */
const OUTBOUND: Route[] = shell(
  '/admin/meetings',
  // Measured at 320px by the reflow case, but never with the full four rules at
  // phone width — a month grid is the densest thing in the product.
  '/admin/calendar',
  '/admin/announcements',
  '/admin/newsletters',
  '/admin/testimonials',
  '/admin/email',
  '/admin/documents'
);

/** Operations, integrations and the settings tail of the sidebar. */
const OPERATIONS: Route[] = shell(
  '/admin/mentee-activity',
  '/admin/integrations',
  '/admin/api-explorer',
  '/admin/retention',
  '/admin/re-engagement',
  '/admin/contributor-terms',
  '/admin/organizations',
  '/admin/settings'
);

/**
 * The screens that belong to the PERSON rather than to a role (#1113) — they
 * live outside admin/mentor/portal and had never been measured at any width.
 * Audited as a mentee, the role with the least chrome: whatever squeezes for a
 * mentee squeezes for everyone.
 */
const PERSONAL: Route[] = standalone(
  '/account',
  '/notifications',
  '/todos',
  '/messages',
  // The public project showcase, not the mentee's own /portal/projects (#1114).
  '/projects'
);

/** The company shell — four screens, none of them ever measured on a phone. */
const COMPANY: Route[] = shell(
  '/company',
  '/company/requisitions',
  '/company/talent-pool',
  '/company/analytics'
);

/** The source shell is a single screen. */
const SOURCE: Route[] = shell('/source');

/**
 * Admin sidebar destinations measured by `mobile-layout-audit.spec.ts` at phone
 * width, listed here so the coverage gate below can tell "audited elsewhere"
 * from "not audited at all". Kept as a literal on purpose: if that file drops a
 * route, this gate fails and says so, which is the outcome we want.
 */
const AUDITED_ELSEWHERE = [
  '/admin',
  '/admin/activity',
  '/admin/analytics',
  '/admin/board',
  '/admin/candidates',
  '/admin/companies',
  '/admin/mentors',
  '/admin/mentorship',
  '/admin/support',
  '/admin/users',
];

const AUDITED = new Set<string>([
  ...AUDITED_ELSEWHERE,
  ...[...FUNNEL, ...SETUP, ...OUTBOUND, ...OPERATIONS, ...PERSONAL, ...COMPANY, ...SOURCE].map(
    (r) => r.path
  ),
]);

// ---------------------------------------------------------------------------
// Fixtures. One admin, one real mentorship (so the list screens have rows on
// them rather than empty states), and the two org-nullable catalogue rows that
// are a single `create` each.
// ---------------------------------------------------------------------------

let adminEmail: string;
let related: SeededRelation;
let cohortId: string;
let sourceId: string;

test.beforeAll(async () => {
  adminEmail = uniqueEmail('mobcov-admin');
  await seedUser(adminEmail, PW, 'ADMIN', 'Mobile Coverage Admin');
  // A relation with a goal, a past interaction and an upcoming meeting: the
  // shared fixture every other widening uses (#2043). Without it the candidate,
  // mentorship, meeting and activity screens all render their empty states, and
  // measuring an empty box and calling it coverage is the failure mode this
  // whole audit exists to avoid.
  related = await seedMenteeWithRelation('Mob Cov', PW);
  // /notifications renders one paragraph with no rows at all. One unread and one
  // read: the unread row carries the badge and the bolder text, which is exactly
  // where a squeezed row hides.
  await prisma.notification.createMany({
    data: [
      {
        userId: related.menteeId,
        type: 'message.new',
        text: 'Seeded unread notification for the mobile layout audit.',
        link: '/messages',
        read: false,
      },
      {
        userId: related.menteeId,
        type: 'meeting.scheduled',
        text: 'Seeded read notification for the mobile layout audit.',
        link: '/portal/calendar',
        read: true,
      },
    ],
  });
  // Two catalogue screens whose row is a single create with no org required
  // (Cohort.orgId and Source.orgId are both nullable, and the seeded admin has
  // no orgId either, so the global layer is the one it reads).
  const cohort = await prisma.cohort.create({
    data: { name: `Mob Cov Kohorte ${Date.now()}`, term: 'Wintersemester 2026/27' },
  });
  cohortId = cohort.id;
  // Source.name is globally unique — timestamped, not fixed.
  const source = await prisma.source.create({
    data: { name: `Mob Cov Karrieremesse ${Date.now()}`, contactName: 'Ansprechpartnerin' },
  });
  sourceId = source.id;
});

// Guarded field by field: a beforeAll that failed half-way still has to clean up
// the half it got through, and an unguarded `related.menteeEmail` here would
// throw over the top of the real failure.
test.afterAll(async () => {
  if (cohortId) await prisma.cohort.delete({ where: { id: cohortId } }).catch(() => {});
  if (sourceId) await prisma.source.delete({ where: { id: sourceId } }).catch(() => {});
  const actors = [adminEmail, related?.mentorEmail, related?.menteeEmail].filter(
    (email): email is string => Boolean(email)
  );
  if (actors.length > 0) await prisma.activityLog.deleteMany({ where: { actorEmail: { in: actors } } });
  if (adminEmail) await cleanupByEmail(adminEmail);
  if (related) await cleanupMenteeWithRelation(related);
  await prisma.$disconnect();
});

/**
 * Bring a route to the point where it is worth measuring, or say why it could
 * not be brought there. Returns null on success and a one-line reason otherwise
 * — never throws, so one dead route does not hide the group behind it.
 */
async function readyOrReason(page: Page, route: Route): Promise<string | null> {
  try {
    if (route.standalone) await settleStandalone(page, { timeout: READY });
    else await settle(page, { timeout: READY });
    return null;
  } catch (error) {
    return `never became ready — ${String(error).split('\n')[0]}`;
  }
}

/** Measure every route in a group and assert the collected findings, once. */
async function sweep(page: Page, routes: Route[], label: string) {
  const findings: string[] = [];
  for (const route of routes) {
    await gotoSettled(page, route.path);
    const notReady = await readyOrReason(page, route);
    if (notReady) {
      findings.push(`${route.path}: ${notReady}`);
      continue;
    }
    for (const problem of await auditLayout(page)) findings.push(`${route.path}: ${problem}`);
    for (const problem of await tapTargets(page)) findings.push(`${route.path}: ${problem}`);
    // Last, because it scrolls the document to the bottom to measure.
    for (const problem of await fixedOverlaps(page)) findings.push(`${route.path}: ${problem}`);
  }
  expect(findings, `${label} at ${PHONE.width}px (de)`).toEqual([]);
}

async function asAdmin(page: Page) {
  await page.setViewportSize(PHONE);
  await setLocale(page, 'de');
  await signInAndSettle(page, adminEmail, PW, '/admin');
}

// ---------------------------------------------------------------------------
// The coverage gate. Reads the destinations the sidebar ACTUALLY renders rather
// than importing the route table, so it measures what a user can reach: a link
// added to `ADMIN_NAV_LINKS` without a matching entry above fails this test,
// which is the whole point of an enumeration guard (acceptance criterion 1).
// ---------------------------------------------------------------------------

test('coverage: every admin sidebar destination is measured by the layout audit', async ({ page }) => {
  await asAdmin(page);

  // The drawer is off-canvas at phone width (`-translate-x-full`) but always in
  // the DOM, so its links are readable without opening it. Scoped to the
  // drawer's own `nav`: AccountMenu sits outside it, and `main` has links of its
  // own that are not nav destinations.
  const destinations = await page
    .locator('[data-testid="app-drawer"] nav a[href^="/"]')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));

  // A guard on the guard: an empty or truncated read would make the comparison
  // below pass for the wrong reason. AdminNav declares 41 destinations today.
  expect(destinations.length, 'the admin sidebar rendered its destinations').toBeGreaterThan(35);

  const missing = [...new Set(destinations)].filter((href) => !AUDITED.has(href)).sort();
  expect(missing, 'admin sidebar destinations absent from the mobile layout audit').toEqual([]);
});

// ---------------------------------------------------------------------------
// The sweeps.
// ---------------------------------------------------------------------------

test('phone width: the hiring-funnel admin screens stay inside the viewport in German', async ({ page }) => {
  test.slow();
  await asAdmin(page);
  await sweep(page, FUNNEL, 'the hiring-funnel admin screens');
});

test('phone width: the programme-setup admin screens stay inside the viewport in German', async ({ page }) => {
  test.slow();
  await asAdmin(page);
  await sweep(page, SETUP, 'the programme-setup admin screens');
});

test('phone width: the scheduling and outbound admin screens stay inside the viewport in German', async ({ page }) => {
  test.slow();
  await asAdmin(page);
  await sweep(page, OUTBOUND, 'the scheduling and outbound admin screens');
});

test('phone width: the operations and settings admin screens stay inside the viewport in German', async ({ page }) => {
  test.slow();
  await asAdmin(page);
  await sweep(page, OPERATIONS, 'the operations and settings admin screens');
});

test('phone width: the person-scoped shells stay inside the viewport in German', async ({ page }) => {
  test.slow();
  await page.setViewportSize(PHONE);
  await setLocale(page, 'de');
  // The mentee of the seeded relation, not a bare account: /messages needs a
  // conversation to list and /notifications needs the two rows seeded above.
  await signInAndSettle(page, related.menteeEmail, PW, '/portal');
  await sweep(page, PERSONAL, 'the person-scoped shells');
});

test('phone width: the company shell stays inside the viewport in German', async ({ page }) => {
  test.slow();
  const companyEmail = uniqueEmail('mobcov-company');
  const user = await seedUser(companyEmail, PW, 'COMPANY', 'Mobile Coverage Firma');
  await prisma.user.update({ where: { id: user.id }, data: { companyId: related.companyId } });
  // The talent pool renders a "feature locked" card without the entitlement, and
  // measuring that card is measuring the wrong screen — grant it so the real
  // search UI (filters, pagination, candidate rows) is what gets audited.
  const entitlement = await prisma.companyEntitlement.create({
    data: { companyId: related.companyId, feature: 'TALENT_POOL_SEARCH' },
  });

  try {
    await page.setViewportSize(PHONE);
    await setLocale(page, 'de');
    await signInAndSettle(page, companyEmail, PW, '/company');
    await sweep(page, COMPANY, 'the company shell');
  } finally {
    await prisma.companyEntitlement.delete({ where: { id: entitlement.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { actorEmail: companyEmail } });
    await cleanupByEmail(companyEmail);
  }
});

test('phone width: the source shell stays inside the viewport in German', async ({ page }) => {
  const sourceEmail = uniqueEmail('mobcov-source');
  const user = await seedUser(sourceEmail, PW, 'SOURCE', 'Mobile Coverage Quelle');
  await prisma.user.update({ where: { id: user.id }, data: { sourceId } });

  try {
    await page.setViewportSize(PHONE);
    await setLocale(page, 'de');
    await signInAndSettle(page, sourceEmail, PW, '/source');
    await sweep(page, SOURCE, 'the source shell');
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: sourceEmail } });
    // Drop the FK before the Source row is deleted in afterAll.
    await prisma.user.update({ where: { id: user.id }, data: { sourceId: null } }).catch(() => {});
    await cleanupByEmail(sourceEmail);
  }
});
