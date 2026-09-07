import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Duplicate candidate detection & merge (#841). Full-suite spec — deliberately
// NOT tagged @smoke: it seeds a whole record graph (relations, logs, reports,
// documents, consents) to prove the merge moves every last row.

const ADMIN_PASSWORD = 'AdminPass123!';
const MENTOR_PASSWORD = 'MentorPass123!';

// Everything seeded here is tracked and torn down once in afterAll, so a
// mid-test failure never leaves residue that would pollute the next run's
// duplicate scan.
const seededEmails: string[] = [];
const createdMenteeIds: string[] = [];
const adminIds: string[] = [];
let orgId: string | null = null;

function trackEmail(prefix: string) {
  const email = uniqueEmail(prefix);
  seededEmails.push(email);
  return email;
}

async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

test.afterAll(async () => {
  // Mentees created through the API have generated placeholder emails — delete
  // them by id (relations first: statusChanges & co. die with the relation).
  for (const id of createdMenteeIds) {
    await prisma.mentorshipRelation.deleteMany({ where: { OR: [{ menteeId: id }, { mentorId: id }] } });
    await prisma.user.delete({ where: { id } }).catch(() => {});
  }
  for (const email of seededEmails) {
    await cleanupByEmail(email);
  }
  // AuditLog/ActivityLog rows have no FK to the user — sweep them by actor.
  if (adminIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: adminIds } } });
    await prisma.activityLog.deleteMany({ where: { actorId: { in: adminIds } } });
  }
  if (orgId) {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

test('merge moves every linked record and deletes the duplicate', async ({ page }) => {
  const admin = await seedUser(trackEmail('dupmerge-admin'), ADMIN_PASSWORD, 'ADMIN', 'DupMerge Admin');
  adminIds.push(admin.id);
  const mentor = await seedUser(trackEmail('dupmerge-mentor'), MENTOR_PASSWORD, 'MENTOR', 'DupMerge Mentor');
  // Same person through two doors: identical name modulo Turkish characters
  // (normalizeNameKey folds Ç/ğ/ı), same university.
  const primary = await seedUser(trackEmail('dupmerge-primary'), 'MenteePass123!', 'MENTEE', 'Çağrı Yılmaz');
  const duplicate = await seedUser(trackEmail('dupmerge-dup'), 'MenteePass123!', 'MENTEE', 'Cagri Yilmaz');
  await prisma.user.update({ where: { id: primary.id }, data: { university: 'Hacettepe Üniversitesi' } });
  await prisma.user.update({ where: { id: duplicate.id }, data: { university: 'Hacettepe Universitesi' } });

  // WeeklyReport.orgId is required (FK to Organization) even though the users
  // themselves live in the null default org — a throwaway org anchors it.
  const org = await prisma.organization.create({
    data: { name: 'DupMerge E2E Org', slug: `dupmerge-e2e-${Date.now()}` },
  });
  orgId = org.id;

  // BOTH mentees relate to the SAME mentor — the collapse path: after
  // re-pointing, the duplicate's relation folds into the primary's.
  const relP = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: primary.id },
  });
  const relD = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: duplicate.id },
  });

  // The full graph hanging off the duplicate that must survive the merge.
  const log = await prisma.interactionLog.create({
    data: { relationId: relD.id, date: new Date(), notes: 'Kickoff call before the merge', type: 'Meeting' },
  });
  const statusChange = await prisma.statusChange.create({
    data: { relationId: relD.id, fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220', changedById: mentor.id },
  });
  const weeklyReport = await prisma.weeklyReport.create({
    data: { orgId: org.id, relationId: relD.id, weekStart: new Date('2026-01-05'), summary: 'First week summary' },
  });
  const evaluation = await prisma.evaluation.create({
    data: { relationId: relD.id, authorId: mentor.id, comment: 'Interim evaluation' },
  });
  const goal = await prisma.goal.create({
    data: { relationId: relD.id, title: 'Finish the CV draft' },
  });
  const notification = await prisma.notification.create({
    data: { userId: duplicate.id, type: 'duplicate.suspected', params: { name: duplicate.fullName } },
  });
  const document = await prisma.document.create({
    data: {
      ownerId: duplicate.id,
      uploaderId: mentor.id,
      type: 'OTHER',
      title: 'Internship contract',
      filename: 'contract.pdf',
      contentType: 'application/pdf',
      size: 4,
      data: Buffer.from('test'),
    },
  });
  const consent = await prisma.userConsent.create({
    data: { userId: duplicate.id, type: 'PRIVACY_POLICY', grantedAt: new Date() },
  });

  await signIn(page, admin.email, ADMIN_PASSWORD, '/admin');

  const res = await page.request.post('/api/admin/duplicates/merge', {
    data: {
      primaryId: primary.id,
      duplicateId: duplicate.id,
      // The confirmation gate wants the ABSORBED record's exact name.
      confirmName: duplicate.fullName,
      adminPassword: ADMIN_PASSWORD,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  // The duplicate row is gone.
  expect(await prisma.user.findUnique({ where: { id: duplicate.id } })).toBeNull();

  // The two relations to the same mentor collapsed into exactly one — the
  // primary's original relation survives.
  const relations = await prisma.mentorshipRelation.findMany({
    where: { mentorId: mentor.id, menteeId: primary.id },
  });
  expect(relations).toHaveLength(1);
  expect(relations[0].id).toBe(relP.id);
  expect(await prisma.mentorshipRelation.findUnique({ where: { id: relD.id } })).toBeNull();

  // Every relation child now hangs off the surviving relation.
  expect((await prisma.interactionLog.findUnique({ where: { id: log.id } }))?.relationId).toBe(relP.id);
  expect((await prisma.statusChange.findUnique({ where: { id: statusChange.id } }))?.relationId).toBe(relP.id);
  expect((await prisma.weeklyReport.findUnique({ where: { id: weeklyReport.id } }))?.relationId).toBe(relP.id);
  expect((await prisma.evaluation.findUnique({ where: { id: evaluation.id } }))?.relationId).toBe(relP.id);
  expect((await prisma.goal.findUnique({ where: { id: goal.id } }))?.relationId).toBe(relP.id);

  // Per-user rows were re-pointed at the primary.
  expect((await prisma.notification.findUnique({ where: { id: notification.id } }))?.userId).toBe(primary.id);
  expect((await prisma.document.findUnique({ where: { id: document.id } }))?.ownerId).toBe(primary.id);

  // UserConsent is @@unique([userId, type]) — the primary had none of this
  // type, so the duplicate's row was moved (deduped otherwise); either way the
  // primary now carries the consent.
  const movedConsent = await prisma.userConsent.findUnique({
    where: { userId_type: { userId: primary.id, type: 'PRIVACY_POLICY' } },
  });
  expect(movedConsent).not.toBeNull();
  expect(movedConsent?.id).toBe(consent.id);

  // The merge is audited: which record absorbed which, by whom.
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'USER_MERGE', targetId: primary.id, detail: { contains: duplicate.id } },
  });
  expect(audit).not.toBeNull();
  expect(audit?.actorId).toBe(admin.id);
});

// #419 — the coverage hole: the spec above deliberately seeds BOTH accounts to
// the SAME mentor (the collapse path), so the divergent-mentor branch of
// mergeUsers' menteeId re-point had never been executed by a test. That branch
// used to carry the duplicate's ACTIVE relation over ALONGSIDE the primary's,
// leaving one mentee with two active mentors — silently, in the one operation
// that cannot be undone. Two mentors each entering the same person is exactly
// the duplicate scenario, which makes it the most likely producer in practice.
test('merging two records whose active mentors differ is refused, and nothing is written', async ({ page }) => {
  const admin = await seedUser(trackEmail('divmerge-admin'), ADMIN_PASSWORD, 'ADMIN', 'DivMerge Admin');
  adminIds.push(admin.id);
  const mentorA = await seedUser(trackEmail('divmerge-mentor-a'), MENTOR_PASSWORD, 'MENTOR', 'DivMerge Mentor A');
  const mentorB = await seedUser(trackEmail('divmerge-mentor-b'), MENTOR_PASSWORD, 'MENTOR', 'DivMerge Mentor B');
  const primary = await seedUser(trackEmail('divmerge-primary'), 'MenteePass123!', 'MENTEE', 'Deniz Şahin');
  const duplicate = await seedUser(trackEmail('divmerge-dup'), 'MenteePass123!', 'MENTEE', 'Deniz Sahin');

  const relP = await prisma.mentorshipRelation.create({
    data: { mentorId: mentorA.id, menteeId: primary.id, status: 'ACTIVE' },
  });
  const relD = await prisma.mentorshipRelation.create({
    data: { mentorId: mentorB.id, menteeId: duplicate.id, status: 'ACTIVE' },
  });
  // History hanging off the losing relation: it must be intact afterwards, since
  // the whole point of refusing is that no data decision was taken.
  const log = await prisma.interactionLog.create({
    data: { relationId: relD.id, date: new Date(), notes: 'Call with mentor B', type: 'Meeting' },
  });

  await signIn(page, admin.email, ADMIN_PASSWORD, '/admin');

  const res = await page.request.post('/api/admin/duplicates/merge', {
    data: {
      primaryId: primary.id,
      duplicateId: duplicate.id,
      confirmName: duplicate.fullName,
      adminPassword: ADMIN_PASSWORD,
    },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('active_mentor_conflict');
  // "Close one first" is not actionable without saying which two mentors clash.
  expect([body.detail.primaryMentorName, body.detail.duplicateMentorName].sort()).toEqual(
    [mentorA.fullName, mentorB.fullName].sort()
  );

  // The transaction rolled back — the real assertion, because a merge is
  // otherwise irreversible: both user rows, both relations and the child row
  // are all exactly as they were.
  expect(await prisma.user.findUnique({ where: { id: duplicate.id } })).not.toBeNull();
  expect(await prisma.user.findUnique({ where: { id: primary.id } })).not.toBeNull();
  const relations = await prisma.mentorshipRelation.findMany({
    where: { id: { in: [relP.id, relD.id] } },
    orderBy: { id: 'asc' },
  });
  expect(relations).toHaveLength(2);
  expect(relations.every((r) => r.status === 'ACTIVE')).toBe(true);
  expect(relations.find((r) => r.id === relD.id)?.menteeId).toBe(duplicate.id);
  expect((await prisma.interactionLog.findUnique({ where: { id: log.id } }))?.relationId).toBe(relD.id);

  // And the documented remediation works: one mentor closes their mentorship
  // through the normal path, then the same merge goes through.
  await prisma.mentorshipRelation.update({
    where: { id: relD.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  const retry = await page.request.post('/api/admin/duplicates/merge', {
    data: {
      primaryId: primary.id,
      duplicateId: duplicate.id,
      confirmName: duplicate.fullName,
      adminPassword: ADMIN_PASSWORD,
    },
  });
  expect(retry.ok(), await retry.text()).toBeTruthy();
  expect(await prisma.user.findUnique({ where: { id: duplicate.id } })).toBeNull();
  // Exactly one ACTIVE mentorship survives on the primary, and the closed one's
  // history came with it rather than being deleted.
  expect(await prisma.mentorshipRelation.count({ where: { menteeId: primary.id, status: 'ACTIVE' } })).toBe(1);
  expect((await prisma.interactionLog.findUnique({ where: { id: log.id } }))?.relationId).toBe(relD.id);
  expect((await prisma.mentorshipRelation.findUnique({ where: { id: relD.id } }))?.menteeId).toBe(primary.id);
});

test('scan page lists the pair and typed-name gate blocks a wrong name', async ({ page }) => {
  const admin = await seedUser(trackEmail('dupscan-admin'), ADMIN_PASSWORD, 'ADMIN', 'DupScan Admin');
  adminIds.push(admin.id);
  const menteeA = await seedUser(trackEmail('dupscan-a'), 'MenteePass123!', 'MENTEE', 'Öykü Demir');
  const menteeB = await seedUser(trackEmail('dupscan-b'), 'MenteePass123!', 'MENTEE', 'Oyku Demir');
  await prisma.user.update({ where: { id: menteeA.id }, data: { university: 'Ege Üniversitesi' } });
  await prisma.user.update({ where: { id: menteeB.id }, data: { university: 'Ege Universitesi' } });

  await signIn(page, admin.email, ADMIN_PASSWORD, '/admin');
  await page.goto('/admin/duplicates');

  // Other specs may seed their own look-alike mentees into the shared scan —
  // scope to the card that carries OUR pair.
  const card = page.getByTestId('duplicate-pair').filter({ hasText: 'Öykü Demir' }).filter({ hasText: 'Oyku Demir' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  await card.getByRole('button', { name: 'Compare & merge' }).click();
  await expect(card.getByTestId('merge-form')).toBeVisible();

  // A wrong typed name keeps the destructive button disabled even with a
  // password filled in — the misclick guard, exercised without merging.
  await card.getByTestId('merge-confirm-name').fill('Someone Else Entirely');
  await card.getByTestId('merge-admin-password').fill(ADMIN_PASSWORD);
  await expect(card.getByRole('button', { name: 'Merge permanently' })).toBeDisabled();

  // Nothing was merged: both records still exist.
  expect(await prisma.user.findUnique({ where: { id: menteeA.id } })).not.toBeNull();
  expect(await prisma.user.findUnique({ where: { id: menteeB.id } })).not.toBeNull();
});

test('mentor create pre-flight returns 409 possible_duplicate and confirmDuplicate overrides', async ({ page }) => {
  const mentor = await seedUser(trackEmail('duppre-mentor'), MENTOR_PASSWORD, 'MENTOR', 'DupPre Mentor');
  const existing = await seedUser(trackEmail('duppre-existing'), 'MenteePass123!', 'MENTEE', 'Şeyma Kaya');
  await prisma.user.update({ where: { id: existing.id }, data: { university: 'Boğaziçi Üniversitesi' } });

  await signIn(page, mentor.email, MENTOR_PASSWORD, '/mentor');

  // ASCII spelling of the same name + university → the pre-flight must warn,
  // not create.
  const payload = { fullName: 'Seyma Kaya', university: 'Bogazici Universitesi' };
  const blocked = await page.request.post('/api/mentor/mentees', { data: payload });
  expect(blocked.status()).toBe(409);
  const blockedBody = await blocked.json();
  expect(blockedBody.error).toBe('possible_duplicate');
  expect(
    (blockedBody.possibleDuplicates as { id: string }[]).some((m) => m.id === existing.id),
  ).toBeTruthy();

  // "Create anyway": the explicit override goes through.
  const confirmed = await page.request.post('/api/mentor/mentees', {
    data: { ...payload, confirmDuplicate: true },
  });
  expect(confirmed.status(), await confirmed.text()).toBe(201);
  const created = await confirmed.json();
  expect(created.menteeId).toBeTruthy();
  createdMenteeIds.push(created.menteeId);
});
