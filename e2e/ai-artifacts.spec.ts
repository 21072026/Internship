import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { hashInput } from '../src/lib/ai/artifacts';
import { defaultOrgId } from '../src/lib/defaultOrg';

// AI artefacts (#2044): a result survives a reload, an identical request inside
// the TTL is answered from the saved copy without a provider call or a unit of
// quota, and the mentee — and only the mentee — decides whether their mentor
// may read it. CI has no provider key, which is exactly what makes "no
// provider call" provable: a fresh call would stop at 501.

const PW = 'Artifacts123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a saved result answers again at no cost, survives a reload, and is shared only by its subject', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const menteeEmail = uniqueEmail('art-mentee');
  const mentorEmail = uniqueEmail('art-mentor');
  const otherMentorEmail = uniqueEmail('art-other');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Art Mentee');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Art Mentor');
  await seedUser(otherMentorEmail, PW, 'MENTOR', 'Art Other');
  await prisma.user.update({ where: { id: mentee.id }, data: { targetPosition: 'Backend Developer', skills: ['Java', 'SQL'] } });
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  try {
    // An earlier generation, as runAiGated's write-through would have stored it.
    const saved = await prisma.aiArtifact.create({
      data: {
        // The org whose quota the mentee's calls consume — an org-less user's is the default org.
        orgId: mentee.orgId ?? (await defaultOrgId()),
        taskId: 'interview_prep',
        subjectUserId: mentee.id,
        createdById: mentee.id,
        inputHash: hashInput({ position: 'Backend Developer', skills: ['Java', 'SQL'], focus: '' }),
        content: '1. Tell me about a REST API you designed.',
      },
    });

    await signInAndSettle(page, menteeEmail, PW, '/portal');
    // The same ask again: the saved copy, no provider call, no quota.
    const usageBefore = await prisma.aiUsage.count();
    const again = await page.request.post('/api/interview-prep', { data: {} });
    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({ prep: saved.content, cached: true, artifact: { id: saved.id, visibility: 'PRIVATE' } });
    expect(await prisma.aiUsage.count()).toBe(usageBefore);
    // Regenerate is a real call — which, without a provider, stops at 501.
    expect((await page.request.post('/api/interview-prep', { data: { regenerate: true } })).status()).toBe(501);
    // A different input is a different question.
    expect((await page.request.post('/api/interview-prep', { data: { focus: 'system design' } })).status()).toBe(501);
    // A reload reads it back, with when it was made.
    const reload = await (await page.request.get('/api/interview-prep')).json();
    expect(reload.latest).toMatchObject({ id: saved.id, content: saved.content, mine: true });
    expect(new Date(reload.latest.createdAt).getTime()).toBe(saved.createdAt.getTime());

    // The mentor cannot read an unshared artefact — asserted on the route.
    await signInAsFreshUser(page, mentorEmail, PW, '/mentor');
    expect((await page.request.get(`/api/ai/artifacts/${saved.id}`)).status()).toBe(403);
    expect((await (await page.request.get(`/api/ai/artifacts?subjectUserId=${mentee.id}`)).json()).artifacts).toEqual([]);
    // Nor may the mentor share it on the mentee's behalf.
    expect((await page.request.patch(`/api/ai/artifacts/${saved.id}`, { data: { visibility: 'SHARED_WITH_MENTOR' } })).status()).toBe(404);

    // The mentee shares it…
    await signInAsFreshUser(page, menteeEmail, PW, '/portal');
    const share = await page.request.patch(`/api/ai/artifacts/${saved.id}`, { data: { visibility: 'SHARED_WITH_MENTOR' } });
    expect((await share.json()).artifact.visibility).toBe('SHARED_WITH_MENTOR');

    // …the mentor reads it, on the route and on the mentee's page…
    await signInAsFreshUser(page, mentorEmail, PW, '/mentor');
    expect((await page.request.get(`/api/ai/artifacts/${saved.id}`)).status()).toBe(200);
    await page.goto(`/mentor/mentees/${rel.id}`);
    await expect(page.getByTestId('shared-ai-artifacts')).toContainText('Interview prep');

    // …a mentor who is not theirs does not (and learns nothing from the status)…
    await signInAsFreshUser(page, otherMentorEmail, PW, '/mentor');
    expect((await page.request.get(`/api/ai/artifacts/${saved.id}`)).status()).toBe(404);

    // …and taking it back closes it again.
    await signInAsFreshUser(page, menteeEmail, PW, '/portal');
    await page.request.patch(`/api/ai/artifacts/${saved.id}`, { data: { visibility: 'PRIVATE' } });
    await signInAsFreshUser(page, mentorEmail, PW, '/mentor');
    expect((await page.request.get(`/api/ai/artifacts/${saved.id}`)).status()).toBe(403);
    expect(await prisma.auditLog.count({ where: { actorId: mentee.id, action: 'ai_artifact.visibility', targetId: saved.id } })).toBe(2);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(otherMentorEmail);
  }
  // Erasing the person erased what was generated about them (the cascade).
  expect(await prisma.aiArtifact.count({ where: { subjectUserId: mentee.id } })).toBe(0);
});

test('an unchanged interaction log re-opens its kept summary, free, for the pair only', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const menteeEmail = uniqueEmail('sum-mentee');
  const mentorEmail = uniqueEmail('sum-mentor');
  const otherMentorEmail = uniqueEmail('sum-other');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Sum Mentee');
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Sum Mentor');
  await seedUser(otherMentorEmail, PW, 'MENTOR', 'Sum Other');
  await prisma.userConsent.create({ data: { userId: mentee.id, type: 'AI_INTERACTION_SUMMARY', grantedAt: new Date() } });
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  const date = new Date('2026-09-01T10:00:00.000Z');
  await prisma.interactionLog.create({ data: { relationId: rel.id, date, type: 'Meeting', notes: 'Walked through the first API task.' } });
  try {
    // What the route hashes: this relation, this mentee, this exact log.
    const saved = await prisma.aiArtifact.create({
      data: {
        orgId: mentee.orgId ?? (await defaultOrgId()),
        taskId: 'interaction_summary',
        subjectUserId: mentee.id,
        createdById: mentor.id,
        relationId: rel.id,
        inputHash: hashInput({
          relationId: rel.id,
          mentee: 'Sum Mentee',
          log: [{ date: date.toISOString(), type: 'Meeting', subject: '', notes: 'Walked through the first API task.' }],
        }),
        content: '- Steady start on the API task.',
      },
    });

    await signInAndSettle(page, mentorEmail, PW, '/mentor');
    const usageBefore = await prisma.aiUsage.count();
    const again = await page.request.post('/api/interactions/summary', { data: { relationId: rel.id } });
    expect(await again.json()).toMatchObject({ summary: saved.content, cached: true, artifact: { id: saved.id } });
    expect(await prisma.aiUsage.count()).toBe(usageBefore);
    // Regenerate is a real call; so is a log with one more entry.
    expect((await page.request.post('/api/interactions/summary', { data: { relationId: rel.id, regenerate: true } })).status()).toBe(501);
    // The card opens on the kept summary, with when it was made.
    await page.goto(`/mentor/mentees/${rel.id}`);
    const card = page.getByTestId('interaction-summary');
    await expect(card).toContainText('Steady start on the API task.');
    await expect(card.getByTestId('ai-artifact-generated')).toBeVisible();
    await prisma.interactionLog.create({ data: { relationId: rel.id, date: new Date(), type: 'Call', notes: 'Second check-in.' } });
    expect((await page.request.post('/api/interactions/summary', { data: { relationId: rel.id } })).status()).toBe(501);

    // A mentor who is not this pair's reads nothing back.
    await signInAsFreshUser(page, otherMentorEmail, PW, '/mentor');
    expect((await page.request.get(`/api/interactions/summary?relationId=${rel.id}`)).status()).toBe(403);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(otherMentorEmail);
  }
});

test('the same candidates re-use the kept match rationale; a stale or changed one does not', async ({ page }) => {
  test.slow();
  // An org of its own, so the candidate pool is exactly this admin and this
  // mentor — the hash covers the pool, and a shared org's pool moves under
  // parallel workers.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `Match Org ${stamp}`, slug: `match-${stamp}` } });
  const adminEmail = uniqueEmail('match-admin');
  const mentorEmail = uniqueEmail('match-mentor');
  const menteeEmail = uniqueEmail('match-mentee');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Match Admin', org.id);
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Match Mentor', org.id);
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Match Mentee', org.id);
  await prisma.user.update({ where: { id: mentor.id }, data: { skills: ['Go'] } });
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['Go'] } });
  const candidate = (label: string, id: string, skills: string[]) => ({ label, skills, interests: null, activeMentees: 0, capacity: null, mentorId: id });
  try {
    const saved = await prisma.aiArtifact.create({
      data: {
        orgId: org.id,
        taskId: 'mentor_match',
        subjectUserId: mentee.id,
        createdById: admin.id,
        // Skill overlap first: the mentor is A, the admin (no overlap) is B.
        inputHash: hashInput({
          mentee: { skills: ['Go'], targetPosition: '', interests: '' },
          candidates: [candidate('A', mentor.id, ['Go']), candidate('B', admin.id, [])],
        }),
        content: JSON.stringify([{ label: 'A', reason: 'Both work in Go.' }]),
      },
    });

    await signInAndSettle(page, adminEmail, PW, '/admin');
    const usageBefore = await prisma.aiUsage.count();
    const res = await (await page.request.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id } })).json();
    expect(res).toMatchObject({ aiUsed: true, cached: true, artifact: { id: saved.id } });
    expect(res.suggestions[0]).toMatchObject({ mentorId: mentor.id, reason: 'Both work in Go.' });
    expect(await prisma.aiUsage.count()).toBe(usageBefore);

    // On the candidate row: the rationale, and that it is the saved copy.
    await page.goto('/admin/candidates');
    const desktop = page.getByTestId('candidates-desktop-list');
    await desktop.getByTestId('suggest-mentor').first().click();
    await expect(desktop.getByTestId('mentor-suggestion').first()).toContainText('Both work in Go.');
    await expect(desktop.getByTestId('ai-artifact-cached').first()).toBeVisible();

    // Regenerate goes to the provider (none here): the rule-based fallback.
    expect((await (await page.request.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id, regenerate: true } })).json()).aiUsed).toBe(false);
    // A stored ranking that no longer decodes is a miss, never a 500.
    await prisma.aiArtifact.update({ where: { id: saved.id }, data: { content: 'not a ranking' } });
    const stale = await page.request.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id } });
    expect(stale.status()).toBe(200);
    expect((await stale.json()).aiUsed).toBe(false);
  } finally {
    await prisma.matchFeedback.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
    await prisma.aiArtifact.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
