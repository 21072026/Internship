import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Vertical write-path gate (#2352, epic #2348). Hiding a module from the nav
// (#2351) is not access control — the route is still reachable by a direct POST.
// A mutating handler for a mentorship-specific module now calls
// requireCapability() first, so a MARKETING org (no mentorship/evaluations
// module) is refused with 403 code:capability_unavailable, whatever the role.
// INTERNSHIP carries every capability, so every handler behaves as before —
// asserted by the INTERNSHIP case landing on a normal validation path, not a 403.

test.afterAll(async () => {
  await prisma.$disconnect();
});

// (path, capability the module needs) — one representative per gated module.
const GATED = [
  { path: '/api/goals', cap: 'mentorship' },
  { path: '/api/weekly-reports', cap: 'mentorship' },
  { path: '/api/questions', cap: 'mentorship' },
  { path: '/api/meeting-requests', cap: 'mentorship' },
  { path: '/api/evaluations', cap: 'evaluations' },
  // A second Evaluation writer: panel scoring. Gated on 'evaluations' too, so
  // /api/evaluations is not closed while this stays open (review of #2363). The
  // gate runs before the panel lookup, so a dummy id still reaches it.
  { path: '/api/interview-panels/00000000-0000-0000-0000-000000000000/score', cap: 'evaluations' },
];

async function adminIn(vertical: 'INTERNSHIP' | 'MARKETING') {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `WGate ${vertical} ${stamp}`, slug: `wgate-${stamp}`, vertical },
  });
  const email = uniqueEmail(`wgate-${vertical.toLowerCase()}`);
  const admin = await seedUser(email, 'WGatePass123', 'ADMIN', `${vertical} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  return { org, email };
}

test('a MARKETING org is refused at every mentorship write path with capability_unavailable', async ({ page }) => {
  const { org, email } = await adminIn('MARKETING');
  try {
    await signInAndSettle(page, email, 'WGatePass123', '/admin');
    for (const { path } of GATED) {
      // A deliberately empty body: the gate runs before validation, so a gated
      // vertical never even reaches the 400. Proves the gate is FIRST.
      const res = await page.request.post(path, { data: {} });
      expect(res.status(), `${path} should be gated`).toBe(403);
      const body = await res.json();
      expect(body.code, `${path} body.code`).toBe('capability_unavailable');
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('an INTERNSHIP org is NOT gated — the same posts pass the capability check', async ({ page }) => {
  const { org, email } = await adminIn('INTERNSHIP');
  try {
    await signInAndSettle(page, email, 'WGatePass123', '/admin');
    for (const { path } of GATED) {
      const res = await page.request.post(path, { data: {} });
      // INTERNSHIP carries every capability, so the gate is a no-op: the empty
      // body falls through to the handler's own validation/authorization, which
      // is anything BUT capability_unavailable (400 validation, 403 role, etc.).
      const body = await res.json().catch(() => ({}));
      expect(body.code, `${path} must not be capability-gated for INTERNSHIP`).not.toBe('capability_unavailable');
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
