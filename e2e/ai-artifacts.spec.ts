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
