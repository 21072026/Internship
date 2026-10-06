import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// A negative open-text cluster (#2046) flags the pairs whose rows are in it on
// the at-risk queue — a note beside the pair, never a change to its score. An
// org of its own, so the newest summary is exactly the one seeded here.

const PW = 'FeedbackFlag123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a negative theme flags its pairs on /admin/health without touching the score', async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `Flag ${stamp}`, slug: `flag-${stamp}` } });
  const emails = { admin: uniqueEmail('flag-admin'), mentor: uniqueEmail('flag-mentor'), sour: uniqueEmail('flag-sour'), fine: uniqueEmail('flag-fine') };
  try {
    const admin = await seedUser(emails.admin, PW, 'ADMIN', 'Flag Admin', org.id);
    const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'Flag Mentor', org.id);
    const sour = await seedUser(emails.sour, PW, 'MENTEE', 'Sour Mentee', org.id);
    const fine = await seedUser(emails.fine, PW, 'MENTEE', 'Fine Mentee', org.id);
    const relSour = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: sour.id, status: 'ACTIVE' } });
    const relFine = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: fine.id, status: 'ACTIVE' } });
    const evSour = await prisma.evaluation.create({ data: { relationId: relSour.id, authorId: mentor.id, comment: 'Keeps missing the deadlines we agreed.', submittedAt: new Date() } });
    const evFine = await prisma.evaluation.create({ data: { relationId: relFine.id, authorId: mentor.id, comment: 'Steady, reliable progress.', submittedAt: new Date() } });

    await signInAndSettle(page, emails.admin, PW, '/admin');
    const before = await (await page.request.get('/api/admin/health')).json();
    const scoreOf = (body: { rows: { relationId: string; score: number | null }[] }, id: string) => body.rows.find((r) => r.relationId === id)?.score;
    expect(before.counts.feedback).toBe(0);

    await prisma.aiArtifact.create({
      data: {
        orgId: org.id,
        taskId: 'evaluation_insights',
        createdById: admin.id,
        inputHash: `seed-${stamp}`,
        content: JSON.stringify({
          themes: [
            { label: 'Missed deadlines', count: 1, exampleIds: [evSour.id], sentiment: 'negative' },
            { label: 'Reliable progress', count: 1, exampleIds: [evFine.id], sentiment: 'positive' },
          ],
          overall: { positive: 1, neutral: 0, negative: 1, unclear: 0 },
          notableQuotes: [],
          caveats: [],
          sent: 2,
        }),
      },
    });

    const after = await (await page.request.get('/api/admin/health')).json();
    expect(after.counts.feedback).toBe(1);
    const flagged = after.rows.find((r: { relationId: string }) => r.relationId === relSour.id);
    expect(flagged.feedbackFlag).toMatchObject({ themes: ['Missed deadlines'] });
    // A positive theme raises nothing.
    const other = after.rows.find((r: { relationId: string }) => r.relationId === relFine.id);
    expect(other?.feedbackFlag ?? null).toBeNull();
    // A note, not a rule: the band and score are what they were. A pair that
    // was quiet before is now listed instead of counted as quiet.
    const was = before.rows.find((r: { relationId: string }) => r.relationId === relSour.id);
    if (was) {
      expect(flagged.band).toBe(was.band);
      expect(scoreOf(after, relSour.id)).toBe(scoreOf(before, relSour.id));
    } else {
      expect(before.excluded.quiet - after.excluded.quiet).toBe(1);
    }

    await page.goto('/admin/health');
    const chip = page.getByTestId(`health-feedback-${relSour.id}`);
    await expect(chip).toContainText('Negative feedback: Missed deadlines');
    await expect(chip).toHaveAttribute('href', '/admin/insights');
  } finally {
    await prisma.aiArtifact.deleteMany({ where: { orgId: org.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
