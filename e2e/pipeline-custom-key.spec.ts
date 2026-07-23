import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #747 Slice C: MentorshipRelation.pipelineStatus is now a free String (was the
// PipelineStatus enum), so a tenant can store its OWN stage keys — not just the
// canonical 13. Proves the storage change end-to-end against a real DB, and that
// StatusChange (also String now) records a custom key.
test.afterAll(async () => { await prisma.$disconnect(); });

test('a relation + status change accept a non-canonical (custom) stage key', async () => {
  const mentor = await seedUser(uniqueEmail('ck-mentor'), 'x', 'MENTOR', 'CK Mentor');
  const mentee = await seedUser(uniqueEmail('ck-mentee'), 'x', 'MENTEE', 'CK Mentee');
  let relId: string | null = null;
  try {
    const rel = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'CUSTOM_LEAD_001' },
    });
    relId = rel.id;
    expect(rel.pipelineStatus).toBe('CUSTOM_LEAD_001');

    const change = await prisma.statusChange.create({
      data: { relationId: rel.id, fromStatus: 'CUSTOM_LEAD_001', toStatus: 'CUSTOM_WON_999', changedById: mentor.id },
    });
    expect(change.toStatus).toBe('CUSTOM_WON_999');

    // A canonical key still works exactly as before (regression guard).
    const updated = await prisma.mentorshipRelation.update({
      where: { id: rel.id },
      data: { pipelineStatus: 'APPLICATION_100' },
    });
    expect(updated.pipelineStatus).toBe('APPLICATION_100');
  } finally {
    if (relId) {
      await prisma.statusChange.deleteMany({ where: { relationId: relId } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relId } });
    }
    await cleanupByEmail(mentor.email);
    await cleanupByEmail(mentee.email);
  }
});
