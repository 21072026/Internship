import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

/**
 * Setting a relation to the stage it is already in must record nothing (#934).
 *
 * `e2e/admin-status.spec.ts` already covers the two request-shaped write paths
 * from the admin UI's point of view. This spec is about the *rule*: every path
 * that can create a `StatusChange` now builds it through `statusChangeData()`
 * (src/lib/stageChange.ts), which refuses a `fromStatus === toStatus` row.
 *
 * Only the first two steps reach that gate. The bulk "advance stage" step below
 * cannot: `nextOnPathStatus` returns the NEXT element of a duplicate-free list,
 * so it never hands back the current stage, and a terminal relation is dropped
 * earlier by `if (!nextStatus) continue` (#740). That step is here for the
 * outcome an admin cares about — a batch that has nowhere to advance to writes
 * no history and sends no notification — not as coverage of the new gate.
 *
 * A same-stage write is a successful no-op, never a 400: an admin who re-picks
 * the current value in a select has not made a mistake, and the clients that
 * fire the request on every change already treat a non-2xx as a failure to
 * surface. Each assertion therefore checks BOTH halves — the response was ok,
 * and the table did not grow.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a stage write to the current stage records no history row and no error', async ({ page }) => {
  const adminEmail = uniqueEmail('noop-gate-admin');
  const mentorEmail = uniqueEmail('noop-gate-mentor');
  const menteeEmail = uniqueEmail('noop-gate-mentee');
  const password = 'NoopGate123!';

  await seedUser(adminEmail, password, 'ADMIN', 'No-op Gate Admin');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'No-op Gate Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'No-op Gate Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'HIREABLE_600' },
  });

  const historyCount = () => prisma.statusChange.count({ where: { relationId: relation.id } });
  const notificationCount = () => prisma.notification.count({ where: { userId: mentee.id } });

  try {
    await signInAsFreshUser(page, adminEmail, password, '/admin');
    expect(await historyCount()).toBe(0);
    const notificationsBefore = await notificationCount();

    // 1. PUT /api/mentorship/[id] — what the board drag/drop and the
    //    candidate-detail stage select call.
    const put = await page.request.put(`/api/mentorship/${relation.id}`, {
      data: { pipelineStatus: 'HIREABLE_600' },
    });
    expect(put.status()).toBe(200);
    expect(await historyCount()).toBe(0);

    // 2. POST /api/status-changes — the admin's manual history entry.
    const post = await page.request.post('/api/status-changes', {
      data: { relationId: relation.id, fromStatus: 'HIREABLE_600', toStatus: 'HIREABLE_600' },
    });
    expect(post.status()).toBe(200);
    expect(await post.json()).toMatchObject({ change: null, changed: false });
    expect(await historyCount()).toBe(0);

    // 3. Bulk "advance stage" on a terminal relation: there is nowhere on-path
    //    to advance to, so the batch reports zero and writes nothing rather
    //    than logging a move to the stage the mentee is already in. This is the
    //    pre-existing `if (!nextStatus) continue` (#740) doing the work, not
    //    the new gate — see the note at the top of this file.
    await prisma.mentorshipRelation.update({
      where: { id: relation.id },
      data: { pipelineStatus: 'EMPLOYED_700' },
    });
    const bulkNoOp = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [mentee.id], action: 'advanceStage' },
    });
    expect(bulkNoOp.status()).toBe(200);
    expect(await bulkNoOp.json()).toMatchObject({ ok: true, updated: 0 });
    expect(await historyCount()).toBe(0);

    // Nothing above told the mentee their stage changed, because it did not.
    expect(await notificationCount()).toBe(notificationsBefore);

    // Regression guard: a REAL move is still recorded, by the same bulk path.
    await prisma.mentorshipRelation.update({
      where: { id: relation.id },
      data: { pipelineStatus: 'HIREABLE_600' },
    });
    const bulkMove = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [mentee.id], action: 'advanceStage' },
    });
    expect(bulkMove.status()).toBe(200);
    expect(await bulkMove.json()).toMatchObject({ ok: true, updated: 1 });

    const rows = await prisma.statusChange.findMany({ where: { relationId: relation.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660' });
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus)
      .toBe('HIRED_660');
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
