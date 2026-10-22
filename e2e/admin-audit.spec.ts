import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';

// The audit trail viewer (#1583) — the first route behind the permission layer
// (src/lib/authz.ts, #1569). The @smoke test pins the boundary through the real
// guard: who may read `audit.read`, who is refused with a denial row, and what
// a PROGRAM_ADMIN's grants narrow the rows to. The second test is the page.

const PASSWORD = 'AuditTrail123!';

type Seeded = {
  orgId: string;
  otherOrgId: string;
  emails: string[];
  admin: { id: string; email: string };
  observer: { id: string; email: string };
  programAdmin: { id: string; email: string };
  bareProgramAdmin: { id: string; email: string };
  mentor: { id: string; email: string };
  inScope: { id: string; email: string };
  outOfScope: { id: string };
  foreignTarget: { id: string };
  cohortId: string;
};

async function seed(prefix: string): Promise<Seeded> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const org = await prisma.organization.create({ data: { name: `${prefix} Org ${stamp}`, slug: `${prefix}-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `${prefix} Other ${stamp}`, slug: `${prefix}-o-${stamp}` } });
  const emails: string[] = [];
  const mk = async (tag: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId = org.id) => {
    const email = uniqueEmail(`${prefix}-${tag}`);
    emails.push(email);
    const u = await seedUser(email, PASSWORD, role, `${prefix} ${tag}`, orgId);
    return { id: u.id, email };
  };
  const admin = await mk('admin', 'ADMIN'); // column left empty: acts as ORG_ADMIN
  const observer = await mk('observer', 'ADMIN');
  const programAdmin = await mk('padmin', 'ADMIN');
  const bareProgramAdmin = await mk('padmin0', 'ADMIN');
  const mentor = await mk('mentor', 'MENTOR');
  const inScope = await mk('in', 'MENTEE');
  const outOfScope = await mk('out', 'MENTEE');
  const foreignTarget = await mk('foreign', 'MENTEE', other.id);
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });
  await prisma.user.updateMany({ where: { id: { in: [programAdmin.id, bareProgramAdmin.id] } }, data: { adminLevel: 'PROGRAM_ADMIN' } });

  const cohort = await prisma.cohort.create({ data: { name: `${prefix} Cohort ${stamp}`, orgId: org.id } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: inScope.id, cohortId: cohort.id, status: 'ACTIVE', orgId: org.id },
  });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: outOfScope.id, status: 'ACTIVE', orgId: org.id },
  });
  await prisma.adminScopeGrant.create({ data: { userId: programAdmin.id, orgId: org.id, cohortId: cohort.id, createdById: admin.id } });

  await prisma.auditLog.createMany({
    data: [
      { actorId: admin.id, action: `E2E_${stamp}_IN`, targetId: inScope.id, orgId: org.id },
      { actorId: admin.id, action: `E2E_${stamp}_OUT`, targetId: outOfScope.id, orgId: org.id },
      { actorId: admin.id, action: `E2E_${stamp}_FOREIGN`, targetId: foreignTarget.id, orgId: other.id },
    ],
  });
  return {
    orgId: org.id,
    otherOrgId: other.id,
    emails,
    admin,
    observer,
    programAdmin,
    bareProgramAdmin,
    mentor,
    inScope,
    outOfScope,
    foreignTarget,
    cohortId: cohort.id,
  };
}

async function cleanup(s: Seeded) {
  const users = await prisma.user.findMany({ where: { email: { in: s.emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] } });
  await prisma.activityLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.adminScopeGrant.deleteMany({ where: { orgId: { in: [s.orgId, s.otherOrgId] } } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: s.orgId } });
  await prisma.cohort.deleteMany({ where: { id: s.cohortId } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: { in: [s.orgId, s.otherOrgId] } } });
}

async function actions(ctx: APIRequestContext, prefix: string): Promise<{ status: number; actions: string[] }> {
  const res = await ctx.get(`/api/admin/audit?action=${encodeURIComponent(prefix)}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), actions: (body.items ?? []).map((i: { action: string }) => i.action).sort() };
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test(
  'audit.read: an admin and an observer read their own org, a mentor and a grant-less program admin are refused with a denial row, grants narrow',
  { tag: '@smoke' },
  async ({ playwright }) => {
    const s = await seed('audit');
    const prefix = (await prisma.auditLog.findFirstOrThrow({ where: { targetId: s.inScope.id } })).action.replace(/_IN$/, '');
    const ctxs: APIRequestContext[] = [];
    const as = async (email: string) => {
      const ctx = await playwright.request.newContext();
      ctxs.push(ctx);
      expect((await signInViaApi(ctx, email, PASSWORD)).ok).toBeTruthy();
      return ctx;
    };
    try {
      // ORG_ADMIN (empty column): its own org's rows, never the other org's.
      const admin = await actions(await as(s.admin.email), prefix);
      expect(admin.status).toBe(200);
      expect(admin.actions).toEqual([`${prefix}_IN`, `${prefix}_OUT`]);

      // OBSERVER: a read-only tier still holds audit.read.
      const observer = await actions(await as(s.observer.email), prefix);
      expect(observer.status).toBe(200);
      expect(observer.actions).toEqual([`${prefix}_IN`, `${prefix}_OUT`]);

      // PROGRAM_ADMIN with a cohort grant: only the row about a person in it.
      const scoped = await actions(await as(s.programAdmin.email), prefix);
      expect(scoped.status).toBe(200);
      expect(scoped.actions).toEqual([`${prefix}_IN`]);

      // PROGRAM_ADMIN without a grant: nothing — a 403, not an empty "everything".
      const bare = await actions(await as(s.bareProgramAdmin.email), prefix);
      expect(bare.status).toBe(403);

      // A mentor has no admin tier at all.
      const mentor = await actions(await as(s.mentor.email), prefix);
      expect(mentor.status).toBe(403);

      // Signed out: 401.
      const anon = await playwright.request.newContext();
      ctxs.push(anon);
      expect((await anon.get('/api/admin/audit')).status()).toBe(401);

      // Every refusal left one warning row naming the permission and the route.
      const denials = await prisma.activityLog.findMany({
        where: { action: 'authz.capability_denied', actorEmail: { in: [s.mentor.email, s.bareProgramAdmin.email] } },
        select: { actorEmail: true, level: true, targetId: true, detail: true },
      });
      expect(denials.map((d) => d.actorEmail).sort()).toEqual([s.mentor.email, s.bareProgramAdmin.email].sort());
      for (const d of denials) {
        expect(d.level).toBe('WARNING');
        expect(d.targetId).toBe('/api/admin/audit');
        expect(d.detail).toContain('audit.read');
      }
    } finally {
      for (const c of ctxs) await c.dispose();
      await cleanup(s);
    }
  },
);

test('the audit page lists rows with names, and an impersonation row shows its origin', async ({ page }) => {
  const s = await seed('auditui');
  try {
    const at = new Date();
    await prisma.auditLog.create({
      data: { actorId: s.admin.id, action: 'IMPERSONATE_START', targetId: s.inScope.id, detail: 'Support ticket', orgId: s.orgId, createdAt: at },
    });
    await prisma.activityLog.create({
      data: {
        action: 'impersonate.start',
        level: 'WARNING',
        actorId: s.admin.id,
        actorEmail: s.admin.email,
        targetType: 'user',
        targetId: s.inScope.id,
        ip: '203.0.113.7',
        userAgent: 'E2E-Agent/1.0',
        orgId: s.orgId,
        createdAt: new Date(at.getTime() + 3),
      },
    });

    await signInAndSettle(page, s.admin.email, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/audit');
    await expect(page.getByRole('heading', { name: 'Audit trail', level: 1 })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('audit-filter-action').fill('IMPERSONATE_START');
    const row = page.getByTestId('audit-row').filter({ hasText: s.inScope.email });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await expect(row).toContainText(s.admin.email);
    await expect(row).toContainText('Support ticket');
    await expect(row.getByTestId('audit-activity')).toContainText('203.0.113.7');
    await expect(row.getByTestId('audit-activity')).toContainText('E2E-Agent/1.0');
    await expect(row.getByRole('link', { name: 'Open in activity log' })).toHaveAttribute('href', '/admin/activity?action=impersonate.start');
  } finally {
    await cleanup(s);
  }
});
