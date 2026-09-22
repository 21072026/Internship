import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '@/lib/programTemplates';

/**
 * The analytics screen, gated by the tenant's vertical (#2423, story #2393).
 *
 * `/admin/analytics` is core CRM: `navLinks.ts` registers it with no capability
 * tag, so a MARKETING admin reaches it and should — the funnel, stage
 * conversion, ageing and drop-off reasons are exactly what a sales pipeline
 * wants. Half of the page, though, is the mentorship product: mentor workload,
 * mentor capacity, meeting RSVP acceptance, the self-service sign-up funnel,
 * match quality, and `projectWorkload` counted in "interns". For an org whose
 * vertical carries none of those modules those cards are not "empty", they are
 * about something that does not exist.
 *
 * Both directions are asserted on the SAME fixture shape, because the
 * regression that matters most is the other one: INTERNSHIP carries every
 * capability, so every card must still be there.
 *
 * The API assertions are load-bearing (`capabilities` on the analytics payload,
 * an empty `capacity` from the funnel route); the testid assertions guard that
 * the screen actually reads them.
 */

const PASSWORD = 'AnalyticsGate123!';

// Cards that describe a module MARKETING does not carry. `capacity-table` comes
// from the funnel route's mentor availability, `match-quality` from the mentor
// suggestion report, `projects-card` from `projectWorkload`.
const MENTORSHIP_ONLY = [
  'mentor-workload-card',
  'capacity-table',
  'headline-rsvp',
  'signup-funnel-card',
  'match-quality',
  'projects-card',
];

// The funnel half of the page — core CRM, kept by every vertical.
const KEPT = [
  'headline-conversion',
  'pipeline-funnel-card',
  'funnel-kpi-card',
  'stage-aging-card',
  'drop-reasons-card',
];

type Vertical = 'INTERNSHIP' | 'MARKETING';

/**
 * An org of the given vertical with the shape every card on the page needs:
 * an admin, a mentor/owner, a mentee/lead, one relation parked on the vertical's
 * own FINISHED stage, and a project. Every one of those rows exists in both
 * orgs, so a hidden card is hidden by the gate and never by missing data.
 */
async function seedVerticalOrg(vertical: Vertical) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${vertical.toLowerCase()}`;
  const org = await prisma.organization.create({
    data: { name: `Analytics ${vertical} ${stamp}`, slug: `ana-gate-${stamp}`, vertical },
  });

  // The stage set a real org of this vertical is provisioned with
  // (`provisionStagePreset`): MARKETING starts on the marketing funnel, and
  // INTERNSHIP on the canonical catalogue — which is the resolver's fallback,
  // i.e. no rows at all.
  const template = defaultTemplateForVertical(vertical);
  if (template) {
    await prisma.pipelineStage.createMany({
      data: templateStagePayload(template).stages.map((s) => ({ ...s, orgId: org.id })),
    });
  }
  // The last on-path stage of that set — what `outcomeStageKeys()` resolves the
  // headline conversion against (#1882/#2419).
  const finishedStage = vertical === 'MARKETING' ? 'DEAL_WON' : 'HIRED_660';

  const adminEmail = uniqueEmail(`anagate-${vertical.toLowerCase()}-admin`);
  const ownerEmail = uniqueEmail(`anagate-${vertical.toLowerCase()}-owner`);
  const leadEmail = uniqueEmail(`anagate-${vertical.toLowerCase()}-lead`);
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', `${vertical} Admin`);
  const owner = await seedUser(ownerEmail, PASSWORD, 'MENTOR', `${vertical} Owner`);
  const lead = await seedUser(leadEmail, PASSWORD, 'MENTEE', `${vertical} Lead`);
  await prisma.user.updateMany({
    where: { id: { in: [admin.id, owner.id, lead.id] } },
    data: { orgId: org.id },
  });

  const project = await prisma.project.create({
    data: { orgId: org.id, name: `Project ${stamp}`, ownerType: 'ADMIN', ownerUserId: admin.id },
  });
  await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id,
      mentorId: owner.id,
      menteeId: lead.id,
      projectId: project.id,
      pipelineStatus: finishedStage,
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    },
  });

  return { org, adminEmail, ownerId: owner.id, emails: [adminEmail, ownerEmail, leadEmail] };
}

async function cleanupVerticalOrg(seeded: Awaited<ReturnType<typeof seedVerticalOrg>>) {
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: seeded.org.id } });
  await prisma.project.deleteMany({ where: { orgId: seeded.org.id } });
  await prisma.pipelineStage.deleteMany({ where: { orgId: seeded.org.id } });
  for (const email of seeded.emails) await cleanupByEmail(email);
  await prisma.organization.delete({ where: { id: seeded.org.id } }).catch(() => {});
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an INTERNSHIP admin keeps every analytics card — the gate is a no-op', async ({ page }) => {
  const seeded = await seedVerticalOrg('INTERNSHIP');
  try {
    await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');

    const payload = await (await page.request.get('/api/admin/analytics')).json();
    expect(payload.capabilities).toContain('mentorship');
    expect(payload.capabilities).toContain('projects');
    const kpi = await (await page.request.get('/api/admin/analytics/funnel')).json();
    expect(kpi.capacity.length).toBeGreaterThan(0);

    await gotoSettled(page, '/admin/analytics');
    // The headline keeps its own translated wording on the canonical catalogue:
    // the label only follows the stage when the tenant renamed it (#1882), so
    // nothing about a default deployment's screen moves.
    const headline = page.getByTestId('headline-conversion');
    await expect(headline).toContainText('Hired rate', { timeout: 20_000 });

    for (const id of [...KEPT, ...MENTORSHIP_ONLY]) {
      await expect(page.getByTestId(id), `INTERNSHIP must keep ${id}`).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    await cleanupVerticalOrg(seeded);
  }
});

test('a MARKETING admin sees the funnel cards and none of the mentorship ones', async ({ page }) => {
  const seeded = await seedVerticalOrg('MARKETING');
  try {
    await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');

    const payload = await (await page.request.get('/api/admin/analytics')).json();
    expect(payload.capabilities).not.toContain('mentorship');
    expect(payload.capabilities).not.toContain('projects');
    expect(payload.capabilities).toContain('pipeline');
    // The mentor-capacity query is not even run for this vertical.
    const kpi = await (await page.request.get('/api/admin/analytics/funnel')).json();
    expect(kpi.capacity).toEqual([]);

    // The headline counter of #2419, on the data side: "finished" for this
    // tenant resolves to its OWN last on-path stage (DEAL_WON), so the seeded
    // relation counts — against the old `HIRED_660 + EMPLOYED_700` literal this
    // org holds neither key and every outcome number was a confident zero.
    expect(payload.finishedLabel).toBe('Won');
    expect(payload.finishedLabelIsCustom).toBe(true);
    const owner = (payload.mentorWorkload as { id: string; hired: number }[])
      .find((m) => m.id === seeded.ownerId);
    expect(owner?.hired).toBe(1);

    // …and the RATIO, without predicting a fixture-specific number:
    // `conversionToHired` divides by every relation the deployment can see
    // (tenant isolation is off outside the `isolation` project,
    // `MT_ENFORCE_ISOLATION`), so 100% is not this fixture's to expect. The
    // payload carries BOTH sides of that division, though, and for this tenant
    // `finished` is exactly ['DEAL_WON'] — the last on-path stage of
    // MARKETING_FUNNEL, DEAL_LOST being off-path. So the headline must be the
    // DEAL_WON share of that very same funnel map, whatever else sits in the
    // database. A numerator built from keys this org does not have (the
    // pre-#1882 `HIRED_660 + EMPLOYED_700`) fails the identity, where a mere
    // "renders some percentage" was happy with the 0% that bug produced.
    const funnel = payload.funnel as Record<string, number>;
    expect(funnel.DEAL_WON ?? 0).toBeGreaterThanOrEqual(1);
    expect(payload.totalRelations).toBeGreaterThanOrEqual(funnel.DEAL_WON);
    expect(payload.conversionToHired).toBe(
      Math.round((funnel.DEAL_WON / payload.totalRelations) * 100),
    );

    await gotoSettled(page, '/admin/analytics');
    // …and on the screen side: the tile is LABELLED from that resolved stage.
    // On `main` before #1882/#2419 it read "Hired rate" to a tenant that has no
    // such stage.
    const headline = page.getByTestId('headline-conversion');
    await expect(headline).toContainText('Won rate', { timeout: 20_000 });
    // The number on the tile is the one verified above — the tile renders its
    // value first and its label second, hence the anchor. Nothing writes
    // between the two reads: `workers: 1`, and this fixture is all the spec
    // creates.
    await expect(headline).toHaveText(new RegExp(`^${payload.conversionToHired}%`));
    await expect(headline).not.toContainText('Hired');

    // Everything the funnel half of the page is made of is still there…
    for (const id of KEPT) {
      await expect(page.getByTestId(id), `MARKETING must keep ${id}`).toBeVisible({ timeout: 20_000 });
    }
    // …and nothing about mentors, RSVPs, sign-ups or interns is drawn. Asserted
    // after the cards above are on screen, so the page has its data and an
    // absence here is the gate rather than a slow fetch.
    for (const id of MENTORSHIP_ONLY) {
      await expect(page.getByTestId(id), `MARKETING must not render ${id}`).toHaveCount(0);
    }
  } finally {
    await cleanupVerticalOrg(seeded);
  }
});
