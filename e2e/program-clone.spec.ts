import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';

// Clone a programme for the next intake (#1643). The rule (what is
// configuration, what is a person) is unit-tested in
// scripts/test/program-clone.test.mjs; this pins the route end to end:
// the config travels, NO person-shaped row does, the copy is audited, another
// org's programme is a 404, and a PROGRAM_ADMIN clones only a granted
// programme and gets no grant on the clone.

const PASSWORD = 'CloneNext123!';

test.afterAll(async () => prisma.$disconnect());

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD);
  expect(res.ok, `sign-in failed for ${email}: ${res.error}`).toBe(true);
  return ctx;
}

/** Every person-shaped row a programme can own — all must be zero on a clone. */
async function personRows(cohortId: string) {
  const [relations, grants, rounds, costs, events, stepRuns] = await Promise.all([
    prisma.mentorshipRelation.count({ where: { cohortId } }),
    prisma.adminScopeGrant.count({ where: { cohortId } }),
    prisma.matchRound.count({ where: { cohortId } }),
    prisma.programCost.count({ where: { cohortId } }),
    prisma.programEvent.count({ where: { programId: cohortId } }),
    prisma.programStepRun.count({ where: { step: { programId: cohortId } } }),
  ]);
  return { relations, grants, rounds, costs, events, stepRuns };
}

test('cloning a programme copies its configuration and no person, audited, tenant- and grant-scoped', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Clone ${s}`, slug: `clone-${s}`, plan: 'ENTERPRISE' } });
  const other = await prisma.organization.create({ data: { name: `Clone other ${s}`, slug: `clone-other-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['cl-org', 'cl-prog', 'cl-mentor', 'cl-mentee', 'cl-other'].map((p) => uniqueEmail(p).toLowerCase());
  const [orgEmail, progEmail, mentorEmail, menteeEmail, otherEmail] = emails;
  try {
    const orgAdmin = await seedUser(orgEmail, PASSWORD, 'ADMIN', 'Clone Org Admin', org.id);
    await prisma.user.update({ where: { id: orgAdmin.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const prog = await seedUser(progEmail, PASSWORD, 'ADMIN', 'Clone Program Admin', org.id);
    await prisma.user.update({ where: { id: prog.id }, data: { adminLevel: 'PROGRAM_ADMIN' } });
    const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Clone Mentor', org.id);
    const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Clone Mentee', org.id);
    await seedUser(otherEmail, PASSWORD, 'ADMIN', 'Other Admin', other.id);

    // The source programme, fully configured and populated.
    const source = await prisma.cohort.create({ data: { orgId: org.id, name: `Interns 2026 ${s}`, term: '2026 Spring', eligibilityMode: 'RULES' } });
    const ungranted = await prisma.cohort.create({ data: { orgId: org.id, name: `Other track ${s}` } });
    const foreign = await prisma.cohort.create({ data: { orgId: other.id, name: `Foreign ${s}` } });
    await prisma.stageSla.createMany({
      data: [
        { orgId: org.id, stageKey: 'APPLICATION_100', days: 4, wipLimit: 12, escalateAfterDays: 2, cohortId: source.id, scope: `c:${source.id}` },
        { orgId: org.id, stageKey: 'APPLICATION_100', days: 2, cohortId: source.id, mentorId: mentor.id, scope: `m:${mentor.id}|c:${source.id}` },
      ],
    });
    await prisma.programEligibilityRule.create({
      data: { orgId: org.id, programId: source.id, effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ['Berlin'], priority: 3, createdById: orgAdmin.id },
    });
    const step = await prisma.programStep.create({
      data: { orgId: org.id, programId: source.id, order: 0, anchor: 'RELATION_START', offsetDays: 7, audience: 'BOTH', action: 'NUDGE', title: 'Kick-off', publishedAt: new Date() },
    });
    await prisma.programStep.create({
      data: { orgId: org.id, programId: source.id, order: 1, anchor: 'RELATION_START', offsetDays: 14, audience: 'MENTEE', action: 'NUDGE', title: 'Retired step', archivedAt: new Date() },
    });
    await prisma.setting.create({ data: { orgId: org.id, programId: source.id, key: 'reminderDays', value: '9' } });
    const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, cohortId: source.id } });
    await prisma.programStepRun.create({ data: { stepId: step.id, relationId: relation.id, dueAt: new Date() } });
    await prisma.adminScopeGrant.create({ data: { userId: prog.id, orgId: org.id, cohortId: source.id, createdById: orgAdmin.id } });
    expect((await personRows(source.id)).relations).toBe(1);

    // --- an org admin clones it -------------------------------------------
    const admin = await ctxFor(orgEmail);
    const res = await admin.post(`/api/cohorts/${source.id}/clone`, { data: { name: `Interns 2027 ${s}`, term: '2027 Spring' } });
    expect(res.status()).toBe(201);
    const body = await res.json();
    const cloneId: string = body.cohort.id;
    expect(body.copied).toEqual({ stageSlas: 1, eligibilityRules: 1, steps: 1, settings: 1 });

    const clone = await prisma.cohort.findUniqueOrThrow({ where: { id: cloneId } });
    expect(clone).toMatchObject({ orgId: org.id, name: `Interns 2027 ${s}`, term: '2027 Spring', eligibilityMode: 'RULES' });
    const slas = await prisma.stageSla.findMany({ where: { cohortId: cloneId } });
    expect(slas.map((r) => ({ stageKey: r.stageKey, days: r.days, wipLimit: r.wipLimit, escalateAfterDays: r.escalateAfterDays, mentorId: r.mentorId, scope: r.scope })))
      .toEqual([{ stageKey: 'APPLICATION_100', days: 4, wipLimit: 12, escalateAfterDays: 2, mentorId: null, scope: `c:${cloneId}` }]);
    const rules = await prisma.programEligibilityRule.findMany({ where: { programId: cloneId } });
    expect(rules.map((r) => ({ effect: r.effect, attribute: r.attribute, operator: r.operator, value: r.value, priority: r.priority, createdById: r.createdById })))
      .toEqual([{ effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ['Berlin'], priority: 3, createdById: orgAdmin.id }]);
    const steps = await prisma.programStep.findMany({ where: { programId: cloneId } });
    expect(steps.map((r) => r.title)).toEqual(['Kick-off']);
    expect(steps[0].publishedAt).not.toBeNull();
    const settings = await prisma.setting.findMany({ where: { programId: cloneId } });
    expect(settings.map((r) => ({ key: r.key, value: r.value }))).toEqual([{ key: 'reminderDays', value: '9' }]);
    expect(await prisma.settingChange.count({ where: { programId: cloneId, key: 'reminderDays', actorId: orgAdmin.id } })).toBe(1);

    // No person travels: every person-shaped table is empty for the clone, the source untouched.
    expect(await personRows(cloneId)).toEqual({ relations: 0, grants: 0, rounds: 0, costs: 0, events: 0, stepRuns: 0 });
    expect((await personRows(source.id)).relations).toBe(1);

    // Audited, in the tenant's stream.
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: 'PROGRAM_CLONE', actorId: orgAdmin.id } });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.detail!)).toMatchObject({ from: source.id, to: cloneId, stageSlas: 1, eligibilityRules: 1, steps: 1, settings: 1 });

    // Another org's programme is a 404 — and nothing is created.
    const before = await prisma.cohort.count({ where: { orgId: org.id } });
    expect((await admin.post(`/api/cohorts/${foreign.id}/clone`, { data: { name: 'Stolen' } })).status()).toBe(404);
    expect((await admin.post(`/api/cohorts/${source.id}/clone`, { data: { name: '  ' } })).status()).toBe(400);
    expect(await prisma.cohort.count({ where: { orgId: org.id } })).toBe(before);
    await admin.dispose();

    // --- a PROGRAM_ADMIN: its granted programme only, and no grant on the clone ---
    const progCtx = await ctxFor(progEmail);
    expect((await progCtx.post(`/api/cohorts/${ungranted.id}/clone`, { data: { name: 'Not mine' } })).status()).toBe(404);
    const progRes = await progCtx.post(`/api/cohorts/${source.id}/clone`, { data: { name: `Interns 2028 ${s}` } });
    expect(progRes.status()).toBe(201);
    const progClone: string = (await progRes.json()).cohort.id;
    expect(await prisma.adminScopeGrant.count({ where: { userId: prog.id, cohortId: progClone } })).toBe(0);
    await progCtx.dispose();

    // --- the screen: the button opens the dialog pre-filled for the next intake ---
    await signInAndSettle(page, orgEmail, PASSWORD, '/admin');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(page, '/admin/cohorts');
    await page.getByTestId(`cohort-clone-${source.id}`).click();
    await expect(page.getByTestId('cohort-clone-name')).toHaveValue(`Interns 2027 ${s}`);
    await expect(page.getByTestId('cohort-clone-term')).toHaveValue('2027 Spring');
    await page.getByTestId('cohort-clone-name').fill(`Interns UI ${s}`);
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(page.getByTestId('cohort-clone-notice')).toHaveText(`Created "Interns UI ${s}".`);
    const uiClone = await prisma.cohort.findFirstOrThrow({ where: { orgId: org.id, name: `Interns UI ${s}` } });
    await expect(page.getByTestId(`cohort-row-${uiClone.id}`)).toBeVisible();
    expect(await personRows(uiClone.id)).toEqual({ relations: 0, grants: 0, rounds: 0, costs: 0, events: 0, stepRuns: 0 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.auditLog.deleteMany({ where: { orgId: { in: [org.id, other.id] } } }).catch(() => {});
    await prisma.settingChange.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.cohort.deleteMany({ where: { orgId: { in: [org.id, other.id] } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } }).catch(() => {});
  }
});
