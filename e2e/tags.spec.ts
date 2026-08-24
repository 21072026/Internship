import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// #887 — free-form tags on people.
//
// What these tests actually defend:
//   · a tag belongs to ONE organisation and cannot be seen or applied across
//     the boundary (asserted on the RESPONSE BODY, not on what the UI hides);
//   · AND means "all of these", OR means "any of these" — the two produce
//     different lists and the server, not the browser, decides;
//   · a saved view that included a tag filter returns the SAME list;
//   · deleting a tag deletes the label, never the person;
//   · the per-person cap holds on the bulk path too;
//   · and the #740 stage-ordering bug in candidates/bulk stays fixed, because
//     this change touches that file.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A tag is org-scoped by construction, so the admin has to be in an org for
// any of this to exist. The seeder backfills a default org (#543); this only
// covers a DB that predates it, and runs before sign-in because the orgId
// reaches the handler through the JWT, not through a fresh read.
async function adminOrgId(): Promise<string> {
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, orgId: true } });
  if (admin?.orgId) return admin.orgId;
  const org =
    (await prisma.organization.findFirst({ where: { slug: 'default' } })) ??
    (await prisma.organization.create({ data: { name: 'Default', slug: 'default' } }));
  await prisma.user.update({ where: { id: admin!.id }, data: { orgId: org.id } });
  return org.id;
}

/** A mentee in the admin's own org, so org-scoped reads can see them. */
async function seedMentee(prefix: string, orgId: string, fullName?: string) {
  const email = uniqueEmail(prefix);
  const user = await seedUser(email, 'MenteePass123', 'MENTEE', fullName ?? `Tag ${prefix}`);
  await prisma.user.update({ where: { id: user.id }, data: { orgId } });
  return { email, user };
}

test('tags are org-scoped: another tenant’s label is neither listed nor attachable', async ({ page }) => {
  test.slow();
  const orgId = await adminOrgId();
  const other = await prisma.organization.create({
    data: { name: 'E2E Tag Other Org', slug: uniqueEmail('tag-org').split('@')[0] },
  });
  const foreignTag = await prisma.tag.create({ data: { orgId: other.id, name: 'Foreign Label' } });
  const { email, user } = await seedMentee('tag-scope', orgId);
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    // Not in the vocabulary the admin is served — checked on the body, because
    // "not rendered" and "not returned" are different things (#740).
    const list = await page.request.get('/api/tags');
    expect(list.ok()).toBeTruthy();
    const body = await list.json();
    expect((body.tags as { name: string }[]).some((t) => t.name === 'Foreign Label')).toBe(false);

    // And it cannot be attached to one of our own people.
    const assign = await page.request.post('/api/tags/assign', {
      data: { userId: user.id, tagId: foreignTag.id, action: 'add' },
    });
    expect(assign.status()).toBe(404);
    expect(await prisma.userTag.count({ where: { userId: user.id } })).toBe(0);
  } finally {
    await cleanupByEmail(email);
    await prisma.tag.deleteMany({ where: { orgId: other.id } });
    await prisma.organization.delete({ where: { id: other.id } }).catch(() => {});
  }
});

test('AND means all of them, OR means any of them — decided on the server', async ({ page }) => {
  test.slow();
  const orgId = await adminOrgId();
  const both = await seedMentee('tag-both', orgId);
  const onlyOne = await seedMentee('tag-one', orgId);
  const tagA = await prisma.tag.create({ data: { orgId, name: `E2E A ${Date.now()}` } });
  const tagB = await prisma.tag.create({ data: { orgId, name: `E2E B ${Date.now()}` } });
  try {
    await prisma.userTag.createMany({
      data: [
        { userId: both.user.id, tagId: tagA.id },
        { userId: both.user.id, tagId: tagB.id },
        { userId: onlyOne.user.id, tagId: tagA.id },
      ],
    });

    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    const ids = async (mode: 'and' | 'or') => {
      const res = await page.request.get(`/api/candidates?tags=${tagA.id},${tagB.id}&tagMode=${mode}&pageSize=100`);
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      return (data.candidates as { id: string }[]).map((c) => c.id);
    };

    const or = await ids('or');
    expect(or).toContain(both.user.id);
    expect(or).toContain(onlyOne.user.id);

    const and = await ids('and');
    expect(and).toContain(both.user.id);
    // Carrying one of the two is not carrying both.
    expect(and).not.toContain(onlyOne.user.id);
  } finally {
    await cleanupByEmail(both.email);
    await cleanupByEmail(onlyOne.email);
    await prisma.tag.deleteMany({ where: { id: { in: [tagA.id, tagB.id] } } });
  }
});

test('a saved view remembers the tag filter and replays the same list', async ({ page }) => {
  test.slow();
  const orgId = await adminOrgId();
  // A shared, unique surname keeps the list to exactly these two whatever else
  // the database holds — the page paginates, so "everyone else is also here"
  // is not a stable assertion.
  const stamp = `Savedview${Date.now()}`;
  const tagged = await seedMentee('tag-saved-in', orgId, `Inside ${stamp}`);
  const untagged = await seedMentee('tag-saved-out', orgId, `Outside ${stamp}`);
  const tag = await prisma.tag.create({ data: { orgId, name: `E2E Saved ${Date.now()}` } });
  try {
    await prisma.userTag.create({ data: { userId: tagged.user.id, tagId: tag.id } });
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await page.goto('/admin/candidates');
    await page.getByTestId('candidates-search-input').fill(stamp);

    const chip = page.getByTestId(`tag-filter-chip-${tag.id}`);
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await chip.click();

    const desktop = page.getByTestId('candidates-desktop-list');
    await expect(desktop.getByTestId(`candidate-card-${tagged.user.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(desktop.getByTestId(`candidate-card-${untagged.user.id}`)).toHaveCount(0);

    // Save the view under a name, clear the filter, then replay it.
    page.on('dialog', (d) => d.accept('Tagged only'));
    await page.getByTestId('saved-views-save').click();
    const savedView = page.getByRole('button', { name: 'Tagged only' });
    await expect(savedView).toBeVisible({ timeout: 10_000 });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect(desktop.getByTestId(`candidate-card-${untagged.user.id}`)).toBeVisible({ timeout: 20_000 });

    await savedView.click();
    // Same list as before — the saved view carried the tag filter, not just the
    // other six.
    await expect(desktop.getByTestId(`candidate-card-${tagged.user.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(desktop.getByTestId(`candidate-card-${untagged.user.id}`)).toHaveCount(0);
  } finally {
    await cleanupByEmail(tagged.email);
    await cleanupByEmail(untagged.email);
    await prisma.tag.deleteMany({ where: { id: tag.id } });
  }
});

test('deleting a tag removes the label, never the person', async ({ page }) => {
  test.slow();
  const orgId = await adminOrgId();
  const { email, user } = await seedMentee('tag-delete', orgId);
  const tag = await prisma.tag.create({ data: { orgId, name: `E2E Delete ${Date.now()}` } });
  try {
    await prisma.userTag.create({ data: { userId: user.id, tagId: tag.id } });
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    const res = await page.request.delete(`/api/tags/${tag.id}`);
    expect(res.ok()).toBeTruthy();

    expect(await prisma.tag.count({ where: { id: tag.id } })).toBe(0);
    expect(await prisma.userTag.count({ where: { tagId: tag.id } })).toBe(0);
    // The candidate is untouched.
    const still = await prisma.user.findUnique({ where: { id: user.id }, select: { isActive: true } });
    expect(still).not.toBeNull();
    expect(still?.isActive).toBe(true);
  } finally {
    await cleanupByEmail(email);
    await prisma.tag.deleteMany({ where: { id: tag.id } });
  }
});

test('a mentor may tag their own mentee and nobody else’s', async ({ page }) => {
  test.slow();
  const orgId = await adminOrgId();
  const mentorEmail = uniqueEmail('tag-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Tag Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { orgId } });
  const mine = await seedMentee('tag-mentee-mine', orgId);
  const theirs = await seedMentee('tag-mentee-theirs', orgId);
  const tag = await prisma.tag.create({ data: { orgId, name: `E2E Mentor ${Date.now()}` } });
  try {
    await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mine.user.id, orgId, status: 'ACTIVE' },
    });
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');

    const ok = await page.request.post('/api/tags/assign', {
      data: { userId: mine.user.id, tagId: tag.id, action: 'add' },
    });
    expect(ok.ok()).toBeTruthy();

    const denied = await page.request.post('/api/tags/assign', {
      data: { userId: theirs.user.id, tagId: tag.id, action: 'add' },
    });
    expect(denied.status()).toBe(403);
    expect(await prisma.userTag.count({ where: { userId: theirs.user.id } })).toBe(0);
  } finally {
    await cleanupByEmail(mine.email);
    await cleanupByEmail(theirs.email);
    await cleanupByEmail(mentorEmail);
    await prisma.tag.deleteMany({ where: { id: tag.id } });
  }
});

test('the per-person tag limit holds on the bulk path too', async ({ page }) => {
  test.slow();
  const orgId = await adminOrgId();
  const { email, user } = await seedMentee('tag-limit', orgId);
  const stamp = Date.now();
  const filler = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      prisma.tag.create({ data: { orgId, name: `E2E Fill ${stamp}-${i}` } })
    )
  );
  const extra = await prisma.tag.create({ data: { orgId, name: `E2E Extra ${stamp}` } });
  try {
    await prisma.userTag.createMany({ data: filler.map((t) => ({ userId: user.id, tagId: t.id })) });
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    const res = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [user.id], action: 'addTag', tagId: extra.id },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.updated).toBe(0);
    expect(body.skippedAtLimit).toBe(1);
    // 21 would mean the cap only exists on the single-assign route.
    expect(await prisma.userTag.count({ where: { userId: user.id } })).toBe(20);
  } finally {
    await cleanupByEmail(email);
    await prisma.tag.deleteMany({ where: { id: { in: [...filler.map((t) => t.id), extra.id] } } });
  }
});

// #740 regression guard. Bulk "advance stage" once did indexOf+1 on the raw
// enum, which stepped an in-progress internship straight into the "dropped"
// stage that happens to sit next to it. This change edits that file, so the
// fixed behaviour is asserted rather than assumed.
test('bulk advance stage still skips the off-path stages (#740)', async ({ page }) => {
  test.slow();
  const orgId = await adminOrgId();
  const mentorEmail = uniqueEmail('tag-740-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Bulk Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { orgId } });
  const { email, user } = await seedMentee('tag-740-mentee', orgId);
  try {
    const relation = await prisma.mentorshipRelation.create({
      data: {
        mentorId: mentor.id,
        menteeId: user.id,
        orgId,
        status: 'ACTIVE',
        pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450',
      },
    });
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    const res = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [user.id], action: 'advanceStage' },
    });
    expect(res.ok()).toBeTruthy();

    const after = await prisma.mentorshipRelation.findUnique({
      where: { id: relation.id },
      select: { pipelineStatus: true },
    });
    // The next stage on the path, not the drop-out stage sitting beside it.
    expect(after?.pipelineStatus).toBe('INTERNSHIP_COMPLETED_490');
    expect(after?.pipelineStatus).not.toBe('INTERNSHIP_DROPPED_460');
  } finally {
    await cleanupByEmail(email);
    await cleanupByEmail(mentorEmail);
  }
});
