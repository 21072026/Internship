import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, seedMenteeWithRelation, cleanupMenteeWithRelation, type SeededRelation } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * A pairing's lifecycle — pause, resume, end with a reason, reopen (#1770).
 *
 * POST /api/mentorship/[id]/lifecycle is the ONE writer of the state, and who
 * may make which move is a server rule (checkLifecycleMove), so the authorization
 * matrix is pinned through the API: a mentee never moves their own pairing, a
 * mentor moves only their own (someone else's reads as 404), an end needs a
 * reason, an illegal move is 409, and PUT no longer takes `status` at all.
 * The second test drives the admin and mentor screens end to end.
 */

const PASSWORD = 'Lifecycle123!';

async function signedIn(email: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD, { headers: freshIp('relation-lifecycle') });
  expect(res.ok, `sign-in as ${email}`).toBe(true);
  return ctx;
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('lifecycle moves are authorized and validated by the server', { tag: '@smoke' }, async () => {
  const seeded = await seedMenteeWithRelation('lcauthz', PASSWORD);
  const otherMentorEmail = uniqueEmail('lcauthz-other');
  await seedUser(otherMentorEmail, PASSWORD, 'MENTOR', 'Other Mentor');
  const contexts: APIRequestContext[] = [];
  try {
    const mentee = await signedIn(seeded.menteeEmail);
    const otherMentor = await signedIn(otherMentorEmail);
    const mentor = await signedIn(seeded.mentorEmail);
    contexts.push(mentee, otherMentor, mentor);
    const url = `/api/mentorship/${seeded.relationId}/lifecycle`;

    // The mentee: never, not even a pause of their own pairing (their path is the re-match request).
    expect((await mentee.post(url, { data: { to: 'PAUSED' } })).status()).toBe(403);
    expect((await mentee.get(url)).status()).toBe(403);
    // A mentor who is not this pair's: the pairing does not exist for them.
    expect((await otherMentor.post(url, { data: { to: 'PAUSED' } })).status()).toBe(404);
    expect((await otherMentor.get(url)).status()).toBe(404);

    // PUT cannot write the state any more — it says where to go instead.
    const put = await mentor.put(`/api/mentorship/${seeded.relationId}`, { data: { status: 'COMPLETED' } });
    expect(put.status()).toBe(400);
    expect((await put.json()).code).toBe('use_lifecycle_endpoint');

    // The own mentor pauses; `status` is derived, not taken from the body.
    const pause = await mentor.post(url, { data: { to: 'PAUSED', status: 'COMPLETED' } });
    expect(pause.status()).toBe(200);
    let row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.lifecycleState).toBe('PAUSED');
    expect(row.status).toBe('ACTIVE');
    expect(row.pausedAt).not.toBeNull();

    // An end needs a reason, and the reason decides the state.
    const noReason = await mentor.post(url, { data: { to: 'ENDED_EARLY' } });
    expect(noReason.status()).toBe(400);
    expect((await noReason.json()).code).toBe('reason_required');
    const mismatch = await mentor.post(url, { data: { to: 'COMPLETED', reasonCode: 'no_fit' } });
    expect(mismatch.status()).toBe(400);
    expect((await mismatch.json()).code).toBe('reason_mismatch');
    // The flows that also create a successor keep their own doors.
    expect((await mentor.post(url, { data: { to: 'ENDED_REMATCHED', reasonCode: 'no_fit' } })).status()).toBe(400);

    const end = await mentor.post(url, { data: { to: 'ENDED_EARLY', reasonCode: 'mentor_unavailable', reasonNote: 'Moving abroad' } });
    expect(end.status()).toBe(200);
    row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.lifecycleState).toBe('ENDED_EARLY');
    expect(row.status).toBe('COMPLETED');
    expect(row.endReasonCode).toBe('mentor_unavailable');
    expect(row.completedAt).not.toBeNull();
    expect(row.pausedAt).toBeNull();

    // An ended pairing cannot be paused, and a mentor cannot reopen it.
    const illegal = await mentor.post(url, { data: { to: 'PAUSED' } });
    expect(illegal.status()).toBe(409);
    expect(await illegal.json()).toMatchObject({ code: 'illegal_transition', from: 'ENDED_EARLY', to: 'PAUSED' });
    expect((await mentor.post(url, { data: { to: 'ACTIVE' } })).status()).toBe(403);

    // One audit row per move, newest first, with the actor and the reason.
    const history = await (await mentor.get(url)).json();
    expect(history.state).toBe('ENDED_EARLY');
    expect(history.events.map((e: { toState: string }) => e.toState)).toEqual(['ENDED_EARLY', 'PAUSED']);
    expect(history.events[0]).toMatchObject({ reasonCode: 'mentor_unavailable', reasonNote: 'Moving abroad', fromState: 'PAUSED' });

    // Both sides were told — the mentee by an in-app notification, never the reason.
    const notes = await prisma.notification.findMany({ where: { userId: seeded.menteeId, type: { startsWith: 'relation.lifecycle_' } } });
    expect(notes.map((n) => n.type).sort()).toEqual(['relation.lifecycle_ended', 'relation.lifecycle_paused']);
    expect(JSON.stringify(notes.map((n) => n.params))).not.toContain('Moving abroad');
  } finally {
    for (const ctx of contexts) await ctx.dispose();
    await cleanupMenteeWithRelation(seeded);
    await cleanupByEmail(otherMentorEmail);
  }
});

test('admin pauses and resumes on /admin/mentorship; the mentor ends with a reason and sees the history', async ({ page }) => {
  const seeded: SeededRelation = await seedMenteeWithRelation('lcui', PASSWORD);
  const adminEmail = uniqueEmail('lcui-admin');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Lifecycle Admin');
  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/mentorship');
    const row = page.getByTestId(`mentorship-row-${seeded.relationId}`);
    await row.getByTestId('lifecycle-pause').click();
    const dialog = page.getByTestId('lifecycle-dialog');
    await dialog.getByTestId('lifecycle-submit').click();
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId('lifecycle-state-badge')).toBeVisible();
    await expect(row.getByTestId('lifecycle-resume')).toBeVisible();

    // A paused pair keeps its portal (free core: pause is never a feature gate).
    const mentee = await signedIn(seeded.menteeEmail);
    expect((await mentee.get('/portal')).status()).toBe(200);
    await mentee.dispose();

    await row.getByTestId('lifecycle-resume').click();
    await expect(row.getByTestId('lifecycle-pause')).toBeVisible();
    await expect(row.getByTestId('lifecycle-state-badge')).toHaveCount(0);

    // The mentor ends their own pairing — the dialog cannot submit without a reason.
    await page.context().clearCookies();
    await signInAndSettle(page, seeded.mentorEmail, PASSWORD, '/mentor');
    await gotoSettled(page, `/mentor/mentees/${seeded.relationId}`);
    const card = page.getByTestId('mentee-lifecycle-card');
    await card.getByTestId('lifecycle-end').click();
    await expect(dialog.getByTestId('lifecycle-submit')).toBeDisabled();
    await dialog.getByTestId('lifecycle-reason').selectOption('schedule_conflict');
    await dialog.getByTestId('lifecycle-note').fill('Exam season clash');
    await dialog.getByTestId('lifecycle-submit').click();
    await expect(dialog).toBeHidden();

    const rows = card.getByTestId('lifecycle-history-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Exam season clash');
    await expect(card.getByTestId('lifecycle-end')).toHaveCount(0);
  } finally {
    await cleanupMenteeWithRelation(seeded);
    await cleanupByEmail(adminEmail);
  }
});
