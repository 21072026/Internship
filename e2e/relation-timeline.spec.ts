import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';

// RelationTimeline (#1702): one chronological panel merging stage moves,
// interactions, meetings, goals and mentor-private notes for a single pairing.
// The panel is fed by GET /api/mentorship/<id>/timeline, which does the merge
// AND the per-role redaction server-side — both are asserted here.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPairing(prefix: string) {
  const adminEmail = uniqueEmail(`${prefix}admin`);
  const mentorEmail = uniqueEmail(`${prefix}mentor`);
  const menteeEmail = uniqueEmail(`${prefix}mentee`);
  const admin = await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Timeline Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Timeline Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Timeline Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERVIEW_PENDING_250' },
  });

  const now = Date.now();
  await prisma.statusChange.create({
    data: {
      relationId: relation.id,
      fromStatus: 'APPLICATION_100',
      toStatus: 'INTERVIEW_PENDING_250',
      changedById: admin.id,
      createdAt: new Date(now - 60 * 60 * 1000),
    },
  });
  await prisma.interactionLog.create({
    data: {
      relationId: relation.id,
      date: new Date(now - 2 * 60 * 60 * 1000),
      subject: 'Kickoff call',
      notes: 'Talked through the interview brief.',
      type: 'Call',
    },
  });
  await prisma.goal.create({
    data: { relationId: relation.id, title: 'Finish the portfolio', createdAt: new Date(now - 3 * 60 * 60 * 1000) },
  });
  // Mentor-private: must reach the admin and the mentor, never the mentee.
  await prisma.relationNote.create({
    data: { relationId: relation.id, authorId: mentor.id, body: 'Needs coaching on system design.' },
  });

  return {
    relation,
    admin,
    mentor,
    mentee,
    emails: { adminEmail, mentorEmail, menteeEmail },
    async cleanup() {
      await cleanupByEmail(menteeEmail);
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(adminEmail);
    },
  };
}

test('a stage move and a logged interaction appear in the same timeline panel', async ({ page }) => {
  const fixture = await seedPairing('tl1');
  try {
    await signInAndSettle(page, fixture.emails.adminEmail, 'AdminPass123!', '/admin');
    await gotoSettled(page, `/admin/candidates/${fixture.mentee.id}`);

    const panel = page.getByTestId('relation-timeline');
    await expect(panel).toBeVisible();

    // Four sources, one list — and it is not a blank card.
    const entries = panel.getByTestId('timeline-entry');
    await expect(entries).toHaveCount(4);
    await expect(panel.locator('[data-kind="stage"]')).toHaveCount(1);
    await expect(panel.locator('[data-kind="interaction"]')).toHaveCount(1);
    await expect(panel.locator('[data-kind="goal"]')).toHaveCount(1);
    await expect(panel.locator('[data-kind="note"]')).toHaveCount(1);

    // Newest first: the stage move (1h ago) is above the interaction (2h ago),
    // which is above the goal (3h ago). The note was written just now.
    await expect(entries.nth(0)).toHaveAttribute('data-kind', 'note');
    await expect(entries.nth(1)).toHaveAttribute('data-kind', 'stage');
    await expect(entries.nth(2)).toHaveAttribute('data-kind', 'interaction');
    await expect(entries.nth(3)).toHaveAttribute('data-kind', 'goal');

    // The stage-history list the panel sits next to is still there (#1702 adds,
    // it does not replace).
    await expect(page.getByRole('button', { name: 'Delete entry' })).toHaveCount(1);

    // A filter chip narrows the list to one kind.
    await panel.getByTestId('timeline-filter-stage').click();
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toHaveAttribute('data-kind', 'stage');

    await panel.getByTestId('timeline-filter-all').click();
    await expect(entries).toHaveCount(4);

    // Nothing is silently truncated: the last page says so instead of leaving
    // the reader guessing whether a cap swallowed the rest.
    await expect(panel.getByTestId('timeline-end')).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test('the mentor sees the panel on the mentee detail screen; the mentee never sees the private note', async ({ page }) => {
  const fixture = await seedPairing('tl2');
  try {
    await signInAndSettle(page, fixture.emails.mentorEmail, 'MentorPass123!', '/mentor');
    await gotoSettled(page, `/mentor/mentees/${fixture.relation.id}`);

    const panel = page.getByTestId('relation-timeline');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('timeline-entry')).toHaveCount(4);
    await expect(panel.locator('[data-kind="note"]')).toHaveCount(1);

    // Same relation, different viewer: the mentee's list drops the mentor's
    // private note entirely — and `note` is not even offered as a filter.
    await signInAsFreshUser(page, fixture.emails.menteeEmail, 'MenteePass123!', '/portal');
    const res = await page.request.get(`/api/mentorship/${fixture.relation.id}/timeline`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.kinds).not.toContain('note');
    expect((body.entries as { kind: string }[]).map((e) => e.kind)).toEqual(['stage', 'interaction', 'goal']);
  } finally {
    await fixture.cleanup();
  }
});

test('a page of history ends with a cursor the next page continues from', async ({ page }) => {
  const fixture = await seedPairing('tl3');
  try {
    // Enough interactions that a small page cannot hold them.
    const base = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await prisma.interactionLog.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        relationId: fixture.relation.id,
        date: new Date(base + i * 60_000),
        notes: `Paged interaction ${i}`,
        type: 'Email' as const,
      })),
    });

    await signInAndSettle(page, fixture.emails.adminEmail, 'AdminPass123!', '/admin');

    const first = await page.request.get(`/api/mentorship/${fixture.relation.id}/timeline?limit=4`);
    const firstPage = await first.json();
    expect(firstPage.entries).toHaveLength(4);
    expect(firstPage.nextCursor).toBeTruthy();

    // Walk the cursor to the end of the history.
    const ids: string[] = firstPage.entries.map((e: { id: string }) => e.id);
    let cursor: string | null = firstPage.nextCursor;
    let pages = 1;
    while (cursor && pages < 10) {
      const res = await page.request.get(
        `/api/mentorship/${fixture.relation.id}/timeline?limit=4&cursor=${encodeURIComponent(cursor)}`
      );
      const body = await res.json();
      expect(body.entries.length).toBeGreaterThan(0);
      ids.push(...body.entries.map((e: { id: string }) => e.id));
      cursor = body.nextCursor;
      pages += 1;
    }

    // No row is served twice and none is skipped.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10); // 1 stage + 7 interactions + 1 goal + 1 note
  } finally {
    await fixture.cleanup();
  }
});

test('the load-more button pages the panel forward instead of re-fetching page one', async ({ page }) => {
  const fixture = await seedPairing('tl4');
  try {
    // The panel's own page size is DEFAULT_TIMELINE_LIMIT (20) and the UI has
    // no way to shrink it, so the second page has to be earned with real rows.
    // 22 interactions + the 4 seeded entries = 26 → exactly two pages.
    const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
    await prisma.interactionLog.createMany({
      data: Array.from({ length: 22 }, (_, i) => ({
        relationId: fixture.relation.id,
        date: new Date(base + i * 60_000),
        notes: `Paged interaction ${i}`,
        type: 'Email' as const,
      })),
    });

    await signInAndSettle(page, fixture.emails.adminEmail, 'AdminPass123!', '/admin');
    await gotoSettled(page, `/admin/candidates/${fixture.mentee.id}`);

    const panel = page.getByTestId('relation-timeline');
    const entries = panel.getByTestId('timeline-entry');
    await expect(entries).toHaveCount(20);

    // A stale cursor would re-serve page 1 and append it to itself: the count
    // would still climb (to 40), so counting alone cannot catch that bug.
    // Capture the ids and require the second page to be entirely new ones.
    const idsOf = async () =>
      entries.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-entry-id') ?? ''));
    const firstPage = await idsOf();

    await panel.getByTestId('timeline-load-more').click();
    await expect(entries).toHaveCount(26);

    const all = await idsOf();
    expect(new Set(all).size).toBe(all.length); // nothing served twice
    expect(all.slice(0, firstPage.length)).toEqual(firstPage); // page 1 untouched

    // 26 of 26 are in — the panel now says it has reached the beginning.
    await expect(panel.getByTestId('timeline-end')).toBeVisible();
    await expect(panel.getByTestId('timeline-load-more')).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});
