import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// A freshly invited sales rep's FIRST sign-in (#3647, go-live). The mentor
// dashboard stamps `mentorOnboardingSeenAt` and redirects to the first-run
// wizard at /onboarding — which a MARKETING tenant does not have, so the rep's
// very first screen was a 404. Every other spec seeds MENTORs with the stamp
// already set (e2e/helpers/db.ts), which is why nothing caught it: this one
// clears it, like a real invitation leaves it.
//
// Pinned: the rep lands on /sales straight from the sign-in form, a direct
// visit to /mentor ends on /sales too (never /onboarding), and the stamp is not
// spent on a wizard that never showed. The internship mentor's first run is
// unchanged: still /onboarding (the wizard exists there).

const PW = 'RepFirstLogin123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const emails: string[] = [];
let orgId = '';

test.afterAll(async () => {
  for (const e of emails) await cleanupByEmail(e);
  if (orgId) {
    await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

test('a fresh MARKETING rep lands on /sales on the first sign-in, never on the internship wizard', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const org = await prisma.organization.create({
    data: { name: `Acme Sales First ${STAMP}`, slug: `rep-first-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  const email = uniqueEmail(`rep-first-${STAMP}`).toLowerCase();
  emails.push(email);
  const rep = await seedUser(email, PW, 'MENTOR', `First Rep ${STAMP}`, orgId);
  // As an invitation leaves it: the first-run stamp unset.
  await prisma.user.update({ where: { id: rep.id }, data: { mentorOnboardingSeenAt: null } });

  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, email, PW, '/sales');
  expect(new URL(page.url()).pathname).toBe('/sales');
  await expect(page.getByTestId('sales-dashboard')).toBeVisible();

  // A bookmark or an old link to /mentor ends on /sales too — not the wizard's 404.
  const res = await page.goto('/mentor');
  expect(res?.status()).not.toBe(404);
  await page.waitForURL((u) => u.pathname === '/sales');
  await expect(page.getByTestId('sales-dashboard')).toBeVisible();
  // The stamp is not spent on a wizard that never showed.
  expect((await prisma.user.findUniqueOrThrow({ where: { id: rep.id } })).mentorOnboardingSeenAt).toBeNull();
});

// The internship mentor's first run (/onboarding, the stamp spent) is pinned by
// e2e/mentor-onboarding-wizard.spec.ts, which this change leaves untouched.
