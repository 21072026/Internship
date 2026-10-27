import { test, expect, type Browser, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { prisma } from '../helpers/db';
import { seedTwoTenants, signInAsTenantActor, type SeededTenant, type TwoTenants } from '../helpers/tenants';
import { seedLeakRows, cleanupLeakRows, type LeakRows, type LeakTenants } from '../helpers/leakSeed';

/**
 * The leak matrix (#1568): "no surface leaks", asserted mechanically against
 * the running app with MT_ENFORCE_ISOLATION on.
 *
 * Every row of MATRIX below is one authenticated read surface. Each one is
 * called twice, by two actors of the same role:
 *
 *   tenant B's actor   the body must contain NONE of tenant A's markers (ids,
 *                      addresses, names stamped per run) — the leak probe;
 *   tenant A's actor   the body must contain EVERY one of tenant A's markers —
 *                      the NEGATIVE CONTROL. Without it a surface that returns
 *                      nothing at all (a broken query, a wrong query string, a
 *                      seed the route never reads) passes the probe for the
 *                      wrong reason. Each call is also checked against the
 *                      OTHER tenant's markers, so the matrix runs both ways.
 *
 * A failure names the endpoint, the actor and the leaked marker. Removing
 * `withTenantScope` from a route whose only tenant filter is the middleware
 * (`GET /api/companies` is one) turns its row red — that is the gate.
 *
 * `denied` rows are surfaces a tenant admin must not reach at all (the
 * installation-wide mail log is super-admin only, #2635): both tenants get a
 * refusal and neither body may carry the other's markers.
 *
 * The cross-tenant WRITE attempts at the bottom must answer 404 — never 403,
 * which would confirm the row exists — and the row is re-read afterwards to
 * prove nothing changed.
 *
 * Runs only in the `isolation` Playwright project; CI runs it on every PR in
 * the `isolation-gate` job of `.github/workflows/e2e.yml`.
 */

type ActorKey = 'admin' | 'mentor' | 'companyUser';

type Case = {
  name: string;
  actor: ActorKey;
  /** `caller` is the signed-in tenant, `target` the tenant whose rows we look for. */
  path: (caller: SeededTenant, target: SeededTenant) => string;
  markers: (t: SeededTenant, rows: LeakRows) => string[];
  /** 'found' (default): the owner's call must return its rows. 'denied': nobody in a tenant may read it. */
  control?: 'found' | 'denied';
};

const MATRIX: Case[] = [
  // ── ADMIN reads (the 15 surfaces named in the issue, by their current paths) ──
  { name: 'GET /api/candidates', actor: 'admin', path: () => '/api/candidates?all=1', markers: (t) => [t.mentee.id] },
  { name: 'GET /api/mentorship', actor: 'admin', path: () => '/api/mentorship?pageSize=100', markers: (t) => [t.relation.id] },
  { name: 'GET /api/companies', actor: 'admin', path: () => '/api/companies?all=1', markers: (t) => [t.company.id] },
  { name: 'GET /api/cohorts', actor: 'admin', path: () => '/api/cohorts', markers: (_t, r) => [r.cohort.id, r.cohort.name] },
  { name: 'GET /api/admin/analytics', actor: 'admin', path: () => '/api/admin/analytics', markers: (t) => [t.mentor.id] },
  {
    name: 'GET /api/admin/activity',
    actor: 'admin',
    path: () => '/api/admin/activity?action=iso.leak_probe',
    markers: (_t, r) => [r.activity.id, r.activity.detail],
  },
  { name: 'GET /api/admin/email-log', actor: 'admin', path: () => '/api/admin/email-log', markers: (t) => [t.admin.email], control: 'denied' },
  { name: 'GET /api/admin/webhooks', actor: 'admin', path: () => '/api/admin/webhooks', markers: (_t, r) => [r.webhook.id, r.webhook.url] },
  { name: 'GET /api/admin/api-keys', actor: 'admin', path: () => '/api/admin/api-keys', markers: (_t, r) => [r.apiKey.id, r.apiKey.name] },
  { name: 'GET /api/admin/settings', actor: 'admin', path: () => '/api/admin/settings', markers: (_t, r) => [r.supportEmail] },
  {
    name: 'GET /api/admin/evaluation-templates',
    actor: 'admin',
    path: () => '/api/admin/evaluation-templates',
    markers: (_t, r) => [r.evaluationTemplate.id, r.evaluationTemplate.name],
  },
  {
    // Takes the org as a parameter, so the probe asks for the OTHER tenant's
    // org id outright — the IDOR shape, not just an unfiltered list.
    name: 'GET /api/admin/document-requirements?orgId=<target>',
    actor: 'admin',
    path: (_caller, target) => `/api/admin/document-requirements?orgId=${target.org.id}`,
    markers: (_t, r) => [r.documentRequirement.id, r.documentRequirement.key],
  },
  { name: 'GET /api/invite', actor: 'admin', path: () => '/api/invite', markers: (t) => [t.invitation.id, t.invitation.email] },
  { name: 'GET /api/interview-panels', actor: 'admin', path: () => '/api/interview-panels', markers: (_t, r) => [r.panel.id, r.panel.title] },
  { name: 'GET /api/requisitions', actor: 'admin', path: () => '/api/requisitions?pageSize=50', markers: (_t, r) => [r.requisition.id, r.requisition.title] },
  { name: 'GET /api/users', actor: 'admin', path: () => '/api/users', markers: (t) => [t.mentor.email, t.companyUser.email] },
  { name: 'GET /api/tags', actor: 'admin', path: () => '/api/tags', markers: (t) => [t.tag.id, t.tag.name] },

  // ── MENTOR reads ──
  { name: 'GET /api/mentorship', actor: 'mentor', path: () => '/api/mentorship?pageSize=100', markers: (t) => [t.relation.id] },
  { name: 'GET /api/interview-panels', actor: 'mentor', path: () => '/api/interview-panels', markers: (_t, r) => [r.panel.id] },

  // ── COMPANY reads ──
  { name: 'GET /api/mentorship', actor: 'companyUser', path: () => '/api/mentorship?pageSize=100', markers: (t) => [t.relation.id] },
  { name: 'GET /api/requisitions', actor: 'companyUser', path: () => '/api/requisitions?pageSize=50', markers: (_t, r) => [r.requisition.id] },
];

let tenants: TwoTenants;
let rows: LeakTenants;
const contexts = new Map<string, BrowserContext>();

/** One signed-in context per tenant × actor, shared by every case that needs it. */
async function requestAs(browser: Browser, tenant: 'A' | 'B', actor: ActorKey): Promise<APIRequestContext> {
  const key = `${tenant}:${actor}`;
  let ctx = contexts.get(key);
  if (!ctx) {
    ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInAsTenantActor(page, (tenant === 'A' ? tenants.orgA : tenants.orgB)[actor]);
    await page.close();
    contexts.set(key, ctx);
  }
  return ctx.request;
}


test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  rows = await seedLeakRows(tenants);
});

test.afterAll(async () => {
  for (const ctx of contexts.values()) await ctx.close().catch(() => {});
  if (tenants) {
    await cleanupLeakRows(tenants.orgIds).catch(() => {});
    await tenants.cleanup();
  }
  await prisma.$disconnect();
});

function absent(body: string, markers: string[], where: string): void {
  for (const m of markers) {
    expect.soft(body.includes(m), `${where}: LEAK — the response carries the other tenant's "${m}"`).toBe(false);
  }
}

for (const c of MATRIX) {
  const label = `${c.name} as ${c.actor}`;

  test(`${label}: tenant B sees none of tenant A's rows`, async ({ browser }) => {
    const request = await requestAs(browser, 'B', c.actor);
    const res = await request.get(c.path(tenants.orgB, tenants.orgA));
    const body = await res.text();
    absent(body, c.markers(tenants.orgA, rows.A), `${label} (B → A)`);
    if (c.control === 'denied') expect(res.status(), `${label}: a tenant ${c.actor} must be refused`).toBeGreaterThanOrEqual(400);
  });

  test(`${label}: tenant A finds its own rows (negative control)`, async ({ browser }) => {
    const request = await requestAs(browser, 'A', c.actor);
    const res = await request.get(c.path(tenants.orgA, tenants.orgA));
    const body = await res.text();
    if (c.control === 'denied') {
      expect(res.status(), `${label}: a tenant ${c.actor} must be refused`).toBeGreaterThanOrEqual(400);
    } else {
      expect(res.status(), `${label}: ${body.slice(0, 300)}`).toBe(200);
      for (const m of c.markers(tenants.orgA, rows.A)) {
        expect.soft(body.includes(m), `${label}: the control did not find A's own "${m}" — the probe would pass for the wrong reason`).toBe(true);
      }
    }
    // The same call is the probe in the other direction: A must not see B.
    absent(body, c.markers(tenants.orgB, rows.B), `${label} (A → B)`);
  });
}

// ── Cross-tenant writes (#1562) ────────────────────────────────────────────────

test("PUT /api/mentorship/<A's relation> as B's admin: 404 and the row is untouched", async ({ browser }) => {
  const before = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: tenants.orgA.relation.id } });
  const request = await requestAs(browser, 'B', 'admin');
  const res = await request.put(`/api/mentorship/${tenants.orgA.relation.id}`, {
    data: { expectedMeetingIntervalWeeks: 7, nextActionNote: 'iso cross-tenant write' },
  });
  expect(res.status(), 'a cross-tenant write must read as not found (a 403 confirms the id exists)').toBe(404);
  const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: tenants.orgA.relation.id } });
  expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  expect(after.expectedMeetingIntervalWeeks).toBe(before.expectedMeetingIntervalWeeks);
  expect(after.nextActionNote).toBe(before.nextActionNote);
});

test("GET /api/mentorship/<A's relation> as B's admin: 404", async ({ browser }) => {
  const request = await requestAs(browser, 'B', 'admin');
  const res = await request.get(`/api/mentorship/${tenants.orgA.relation.id}`);
  expect(res.status()).toBe(404);
  absent(await res.text(), [tenants.orgA.mentee.email, tenants.orgA.mentee.fullName], "GET /api/mentorship/<A's id> (B → A)");
});

test("DELETE /api/status-changes/<A's entry> as B's admin: 404 and the row survives", async ({ browser }) => {
  const request = await requestAs(browser, 'B', 'admin');
  const res = await request.delete(`/api/status-changes/${rows.A.statusChange.id}`);
  expect(res.status(), 'a cross-tenant delete must read as not found').toBe(404);
  expect(await prisma.statusChange.findUnique({ where: { id: rows.A.statusChange.id } })).not.toBeNull();
});
