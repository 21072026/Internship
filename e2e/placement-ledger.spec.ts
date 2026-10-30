import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';

// The placement ledger (#1765, docs/placements.md). A move into the org's hire
// stage stamps exactly one Placement — through the `placement` subscriber on
// the job worker, so the assertions poll — with company, mentor and source
// attributed; a move back out marks it reversed and deletes nothing; a custom
// pipeline's own hire stage counts; and the invoice state moves only along the
// rule, with an audit row.

const PW = 'PlacementLedger123!';
// The worker ticks every 5 s; a subscriber job lands within a couple of ticks.
const POLL = { timeout: 30_000, intervals: [500, 1000, 2000] };

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seed(prefix: string, opts: { customPipeline?: boolean; attribution?: string } = {}) {
  const stamp = `${Date.now()}-${Math.round(Math.random() * 1e4)}`;
  const org = await prisma.organization.create({ data: { name: `PL ${prefix} ${stamp}`, slug: `pl-${prefix}-${stamp}` } });
  if (opts.customPipeline) {
    await prisma.pipelineStage.createMany({
      data: ['SOURCED', 'OFFERED', 'PLACED'].map((key, i) => ({
        orgId: org.id, key, label: key, order: i, isTerminal: i === 2, isOffPath: false,
      })),
    });
  }
  const source = await prisma.source.create({ data: { orgId: org.id, name: `PL Source ${stamp}` } });
  const company = await prisma.company.create({ data: { orgId: org.id, name: `Acme Placements ${stamp}` } });
  const adminEmail = uniqueEmail(`pl-${prefix}-admin`);
  const mentorEmail = uniqueEmail(`pl-${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`pl-${prefix}-mentee`);
  await seedUser(adminEmail, PW, 'ADMIN', 'PL Admin', org.id);
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'PL Mentor', org.id);
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'PL Mentee', org.id);
  await prisma.user.update({ where: { id: mentee.id }, data: { sourceId: source.id } });
  const relation = await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, companyId: company.id,
      pipelineStatus: opts.customPipeline ? 'OFFERED' : 'HIREABLE_600',
      employmentAttribution: opts.attribution ?? null,
    },
  });
  return {
    org, mentor, mentee, relation, source, company, adminEmail,
    cleanup: async () => {
      const placements = await prisma.placement.findMany({ where: { relationId: relation.id }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: placements.map((p) => p.id) } } });
      await prisma.activityLog.deleteMany({ where: { targetId: { in: [relation.id, ...placements.map((p) => p.id)] } } });
      await prisma.placement.deleteMany({ where: { relationId: relation.id } });
      await prisma.statusChange.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      for (const e of [menteeEmail, mentorEmail, adminEmail]) await cleanupByEmail(e);
      await prisma.company.deleteMany({ where: { id: company.id } });
      await prisma.source.deleteMany({ where: { id: source.id } });
      await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
    },
  };
}

const placementOf = (relationId: string) => prisma.placement.findUnique({ where: { relationId } });

test('a hire stamps one attributed placement; leaving the stage reverses it, returning reinstates it', async ({ request }) => {
  // Three worker round-trips in one test.
  test.setTimeout(150_000);
  const s = await seed('stamp');
  try {
    expect((await signInViaApi(request, s.adminEmail, PW)).ok).toBe(true);
    const hire = await request.put(`/api/mentorship/${s.relation.id}`, { data: { pipelineStatus: 'HIRED_660' } });
    expect(hire.status()).toBe(200);

    await expect.poll(async () => (await placementOf(s.relation.id))?.id ?? null, POLL).not.toBeNull();
    const placed = (await placementOf(s.relation.id))!;
    expect(placed).toMatchObject({
      orgId: s.org.id,
      menteeId: s.mentee.id,
      companyId: s.company.id,
      creditedMentorId: s.mentor.id,
      sourceId: s.source.id,
      attribution: 'THROUGH_US',
      invoiceState: 'INVOICEABLE',
      reversedAt: null,
    });
    // It observes: the stamp moved no stage.
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } })).pipelineStatus).toBe('HIRED_660');

    // Listed on the ledger.
    const list = await request.get('/api/admin/placements');
    expect(list.status()).toBe(200);
    expect((await list.json()).placements.map((p: { id: string }) => p.id)).toContain(placed.id);

    // Back out of the hire stage: reversed, not deleted.
    expect((await request.put(`/api/mentorship/${s.relation.id}`, { data: { pipelineStatus: 'HIREABLE_600' } })).status()).toBe(200);
    await expect.poll(async () => (await placementOf(s.relation.id))?.reversedAt ?? null, POLL).not.toBeNull();
    expect(await prisma.placement.count({ where: { relationId: s.relation.id } })).toBe(1);
    // Hidden from the live ledger, shown on request.
    expect((await (await request.get('/api/admin/placements')).json()).placements.map((p: { id: string }) => p.id)).not.toContain(placed.id);
    expect((await (await request.get('/api/admin/placements?includeReversed=1')).json()).placements.map((p: { id: string }) => p.id)).toContain(placed.id);

    // And in again: the same row, reinstated.
    expect((await request.put(`/api/mentorship/${s.relation.id}`, { data: { pipelineStatus: 'HIRED_660' } })).status()).toBe(200);
    await expect.poll(async () => {
      const row = await placementOf(s.relation.id);
      return row ? row.reversedAt === null : 'missing';
    }, POLL).toBe(true);
    expect((await placementOf(s.relation.id))!.id).toBe(placed.id);
  } finally {
    await s.cleanup();
  }
});

test('a custom pipeline stamps on its own hire stage, and a self-found job is not invoiceable', async ({ request }) => {
  const s = await seed('custom', { customPipeline: true, attribution: 'SELF_FOUND' });
  try {
    expect((await signInViaApi(request, s.adminEmail, PW)).ok).toBe(true);
    expect((await request.put(`/api/mentorship/${s.relation.id}`, { data: { pipelineStatus: 'PLACED' } })).status()).toBe(200);
    await expect.poll(async () => (await placementOf(s.relation.id))?.id ?? null, POLL).not.toBeNull();
    expect(await placementOf(s.relation.id)).toMatchObject({ attribution: 'SELF_FOUND', feeModel: 'NONE', invoiceState: 'NOT_INVOICEABLE' });

    const id = (await placementOf(s.relation.id))!.id;
    const refused = await request.patch(`/api/admin/placements/${id}`, { data: { invoiceState: 'INVOICED', invoiceRef: 'INV-1' } });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).code).toBe('not_allowed');
  } finally {
    await s.cleanup();
  }
});

test('invoice state: a reference is required, the change is audited, another org’s id is 404', async ({ request }) => {
  const s = await seed('invoice');
  const other = await seed('other');
  try {
    const placement = await prisma.placement.create({
      data: { orgId: s.org.id, relationId: s.relation.id, menteeId: s.mentee.id, placedAt: new Date(), invoiceState: 'INVOICEABLE' },
    });
    const foreign = await prisma.placement.create({
      data: { orgId: other.org.id, relationId: other.relation.id, menteeId: other.mentee.id, placedAt: new Date(), invoiceState: 'INVOICEABLE' },
    });
    expect((await signInViaApi(request, s.adminEmail, PW)).ok).toBe(true);

    const noRef = await request.patch(`/api/admin/placements/${placement.id}`, { data: { invoiceState: 'INVOICED' } });
    expect(noRef.status()).toBe(400);
    expect((await noRef.json()).code).toBe('invoice_ref_required');

    const ok = await request.patch(`/api/admin/placements/${placement.id}`, { data: { invoiceState: 'INVOICED', invoiceRef: 'INV-2026-001' } });
    expect(ok.status()).toBe(200);
    expect(await prisma.placement.findUniqueOrThrow({ where: { id: placement.id } })).toMatchObject({ invoiceState: 'INVOICED', invoiceRef: 'INV-2026-001' });
    expect(await prisma.auditLog.count({ where: { action: 'PLACEMENT_INVOICE_STATE', targetId: placement.id, orgId: s.org.id } })).toBe(1);

    expect((await request.patch(`/api/admin/placements/${foreign.id}`, { data: { invoiceState: 'WAIVED' } })).status()).toBe(404);
    expect((await prisma.placement.findUniqueOrThrow({ where: { id: foreign.id } })).invoiceState).toBe('INVOICEABLE');
  } finally {
    await s.cleanup();
    await other.cleanup();
  }
});

test('the ledger screen lists a placement and marks it invoiced', async ({ page }) => {
  test.setTimeout(120_000);
  const s = await seed('ui');
  try {
    await prisma.placement.create({
      data: {
        orgId: s.org.id, relationId: s.relation.id, menteeId: s.mentee.id, companyId: s.company.id,
        placedAt: new Date(), attribution: 'THROUGH_US', invoiceState: 'INVOICEABLE',
      },
    });
    await signInAndSettle(page, s.adminEmail, PW, '/admin');
    await gotoSettled(page, '/admin/placements');
    const row = page.getByTestId(`placement-row-${s.relation.id}`);
    await expect(row).toBeVisible();
    await expect(row.getByText(s.company.name, { exact: true })).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept('INV-UI-1'));
    await row.getByTestId('placement-action-INVOICED').click();
    await expect(row.getByTestId('placement-invoice-state')).toHaveText(/Invoiced/);
    await expect(row.getByText('INV-UI-1')).toBeVisible();
  } finally {
    await s.cleanup();
  }
});
