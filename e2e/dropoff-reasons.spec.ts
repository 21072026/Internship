import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Drop-off reason codes + analytics (#810): every pipeline-stage write path
// (status-changes, mentorship/[id] — also what the board drag/drop and the
// candidate-detail stage select call — and the bulk advanceStage action) must
// require a reason when the target stage is negative/off-path, and none of
// them may be bypassed.
test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signInAdmin(page: Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

async function seedRelation(prefix: string, pipelineStatus = 'INTERNSHIP_IN_PROGRESS_450') {
  const pw = 'DropoffPass123!';
  const adminEmail = uniqueEmail(`${prefix}admin`);
  const mentorEmail = uniqueEmail(`${prefix}mentor`);
  const menteeEmail = uniqueEmail(`${prefix}mentee`);
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Dropoff Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Dropoff Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Dropoff Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus },
  });
  return {
    pw,
    adminEmail,
    admin,
    mentor,
    mentee,
    relation,
    cleanup: async () => {
      await prisma.statusChange.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      await cleanupByEmail(menteeEmail);
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(adminEmail);
    },
  };
}

test('moving into a negative stage without a reasonCode is rejected with 400', async ({ page }) => {
  const s = await seedRelation('neg1');
  try {
    await signInAdmin(page, s.adminEmail, s.pw);
    const res = await page.request.fetch(`/api/mentorship/${s.relation.id}`, {
      method: 'PUT',
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460' },
    });
    expect(res.status()).toBe(400);

    const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } });
    expect(after.pipelineStatus).toBe('INTERNSHIP_IN_PROGRESS_450');
    const changes = await prisma.statusChange.findMany({ where: { relationId: s.relation.id } });
    expect(changes).toHaveLength(0);
  } finally {
    await s.cleanup();
  }
});

test('reasonCode OTHER without a reasonNote is rejected with 400', async ({ page }) => {
  const s = await seedRelation('neg2');
  try {
    await signInAdmin(page, s.adminEmail, s.pw);
    const res = await page.request.fetch(`/api/mentorship/${s.relation.id}`, {
      method: 'PUT',
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'OTHER' },
    });
    expect(res.status()).toBe(400);

    const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } });
    expect(after.pipelineStatus).toBe('INTERNSHIP_IN_PROGRESS_450');
  } finally {
    await s.cleanup();
  }
});

test('a valid reason on a negative-stage move is accepted and persisted', async ({ page }) => {
  const s = await seedRelation('neg3');
  try {
    await signInAdmin(page, s.adminEmail, s.pw);
    const res = await page.request.fetch(`/api/mentorship/${s.relation.id}`, {
      method: 'PUT',
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'NO_RESPONSE' },
    });
    expect(res.status()).toBe(200);

    const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } });
    expect(after.pipelineStatus).toBe('INTERNSHIP_DROPPED_460');
    const change = await prisma.statusChange.findFirstOrThrow({ where: { relationId: s.relation.id } });
    expect(change.reasonCode).toBe('NO_RESPONSE');
    expect(change.reasonNote).toBeNull();
  } finally {
    await s.cleanup();
  }
});

test('OTHER with a note is accepted and the note is persisted', async ({ page }) => {
  const s = await seedRelation('neg4');
  try {
    await signInAdmin(page, s.adminEmail, s.pw);
    const res = await page.request.fetch(`/api/mentorship/${s.relation.id}`, {
      method: 'PUT',
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'OTHER', reasonNote: 'Moved abroad unexpectedly' },
    });
    expect(res.status()).toBe(200);
    const change = await prisma.statusChange.findFirstOrThrow({ where: { relationId: s.relation.id } });
    expect(change.reasonCode).toBe('OTHER');
    expect(change.reasonNote).toBe('Moved abroad unexpectedly');
  } finally {
    await s.cleanup();
  }
});

test('a move into a non-negative stage never requires a reason', async ({ page }) => {
  const s = await seedRelation('pos1', 'APPLICATION_100');
  try {
    await signInAdmin(page, s.adminEmail, s.pw);
    const res = await page.request.fetch(`/api/mentorship/${s.relation.id}`, {
      method: 'PUT',
      data: { pipelineStatus: 'APPROVAL_PENDING_220' },
    });
    expect(res.status()).toBe(200);
    const change = await prisma.statusChange.findFirstOrThrow({ where: { relationId: s.relation.id } });
    expect(change.reasonCode).toBeNull();
  } finally {
    await s.cleanup();
  }
});

test('the manual status-changes correction endpoint enforces the same reason rule', async ({ page }) => {
  const s = await seedRelation('hist1');
  try {
    await signInAdmin(page, s.adminEmail, s.pw);

    const missing = await page.request.post('/api/status-changes', {
      data: { relationId: s.relation.id, fromStatus: 'INTERNSHIP_IN_PROGRESS_450', toStatus: 'INTERNSHIP_DROPPED_460' },
    });
    expect(missing.status()).toBe(400);

    const ok = await page.request.post('/api/status-changes', {
      data: {
        relationId: s.relation.id,
        fromStatus: 'INTERNSHIP_IN_PROGRESS_450',
        toStatus: 'INTERNSHIP_DROPPED_460',
        reasonCode: 'SKILL_MISMATCH',
      },
    });
    expect(ok.status()).toBe(201);
    const body = await ok.json();
    expect(body.change.reasonCode).toBe('SKILL_MISMATCH');
  } finally {
    await s.cleanup();
  }
});

test('bulk advanceStage steps exactly one canonical stage forward (#740) and never needs/accepts a reason', async ({ page }) => {
  const s1 = await seedRelation('bulk1', 'APPLICATION_100');
  const s2 = await seedRelation('bulk2', 'EMPLOYED_700'); // terminal — must NOT advance
  try {
    await signInAdmin(page, s1.adminEmail, s1.pw);
    const res = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [s1.mentee.id], action: 'advanceStage' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);

    const after1 = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s1.relation.id } });
    // The correct next canonical stage — not an off-by-one/indexOf+1 guess.
    expect(after1.pipelineStatus).toBe('APPROVAL_PENDING_220');
    const change = await prisma.statusChange.findFirstOrThrow({ where: { relationId: s1.relation.id } });
    expect(change.reasonCode).toBeNull();

    await page.context().clearCookies();
    await signInAdmin(page, s2.adminEmail, s2.pw);
    const res2 = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [s2.mentee.id], action: 'advanceStage' },
    });
    const body2 = await res2.json();
    expect(body2.updated).toBe(0);
    const after2 = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s2.relation.id } });
    expect(after2.pipelineStatus).toBe('EMPLOYED_700');
  } finally {
    await s1.cleanup();
    await s2.cleanup();
  }
});

test('a custom-pipeline org detects negative stages from isOffPath, not a hardcoded key list', async ({ page }) => {
  const pw = 'DropoffPass123!';
  const stamp = uniqueEmail('dropoffcp').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `Dropoff CP ${stamp}`, slug: `dcp-${stamp}` } });
  const adminEmail = uniqueEmail('dcpadmin');
  const mentorEmail = uniqueEmail('dcpmentor');
  const menteeEmail = uniqueEmail('dcpmentee');
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'CP Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'CP Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'CP Mentee');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  let relation: { id: string } | null = null;
  try {
    await prisma.pipelineStage.createMany({
      data: [
        { orgId: org.id, key: 'LEAD', label: 'Lead', order: 0 },
        { orgId: org.id, key: 'LOST', label: 'Lost', order: 1, isOffPath: true },
      ],
    });
    relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id, pipelineStatus: 'LEAD' },
    });

    await signInAdmin(page, adminEmail, pw);

    // LEAD -> LOST is negative in THIS org's pipeline even though "LOST" is not
    // one of the canonical PipelineStatus keys — must require a reason.
    const noReason = await page.request.fetch(`/api/mentorship/${relation.id}`, {
      method: 'PUT',
      data: { pipelineStatus: 'LOST' },
    });
    expect(noReason.status()).toBe(400);

    const withReason = await page.request.fetch(`/api/mentorship/${relation.id}`, {
      method: 'PUT',
      data: { pipelineStatus: 'LOST', reasonCode: 'COMPANY_CANCELLED' },
    });
    expect(withReason.status()).toBe(200);
  } finally {
    if (relation) {
      await prisma.statusChange.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    }
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('drop-off analytics aggregates stage × reason, grouping legacy null reasons as Unspecified', async ({ page }) => {
  const s = await seedRelation('an1', 'INTERNSHIP_IN_PROGRESS_450');
  try {
    // A legacy pre-#810 row: negative stage, no reasonCode.
    await prisma.statusChange.create({
      data: {
        relationId: s.relation.id,
        fromStatus: 'INTERNSHIP_IN_PROGRESS_450',
        toStatus: 'INTERNSHIP_DROPPED_460',
        changedById: s.admin.id,
      },
    });
    // A fresh, reasoned row for the same stage.
    await prisma.statusChange.create({
      data: {
        relationId: s.relation.id,
        fromStatus: 'INTERNSHIP_IN_PROGRESS_450',
        toStatus: 'INTERNSHIP_DROPPED_460',
        changedById: s.admin.id,
        reasonCode: 'CANDIDATE_WITHDREW',
      },
    });

    await signInAdmin(page, s.adminEmail, s.pw);
    const res = await page.request.get('/api/admin/analytics/aging');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const dropReasons: { pipelineStatus: string; reasonCode: string; count: number }[] = body.dropReasons;

    const unspecified = dropReasons.find((d) => d.pipelineStatus === 'INTERNSHIP_DROPPED_460' && d.reasonCode === 'UNSPECIFIED');
    const withdrew = dropReasons.find((d) => d.pipelineStatus === 'INTERNSHIP_DROPPED_460' && d.reasonCode === 'CANDIDATE_WITHDREW');
    expect(unspecified?.count).toBe(1);
    expect(withdrew?.count).toBe(1);

    await page.goto('/admin/analytics');
    await expect(page.getByTestId('drop-reasons-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('drop-reasons-card')).toContainText(/Unspecified|Belirtilmemiş|Nicht angegeben/);
  } finally {
    await s.cleanup();
  }
});

test('the analytics Excel export includes a Drop reasons sheet', async ({ page }) => {
  const s = await seedRelation('xls1', 'INTERNSHIP_IN_PROGRESS_450');
  try {
    await prisma.statusChange.create({
      data: {
        relationId: s.relation.id,
        fromStatus: 'INTERNSHIP_IN_PROGRESS_450',
        toStatus: 'INTERNSHIP_DROPPED_460',
        changedById: s.admin.id,
        reasonCode: 'LOCATION',
      },
    });

    await signInAdmin(page, s.adminEmail, s.pw);
    await page.goto('/admin/analytics');
    await expect(page.getByRole('button', { name: 'Export Excel' })).toBeVisible({ timeout: 10_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Excel' }).click(),
    ]);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();

    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.readFile(filePath!);
    expect(wb.SheetNames).toContain('Drop reasons');
    const sheet = XLSX.utils.sheet_to_json(wb.Sheets['Drop reasons']) as Record<string, unknown>[];
    expect(sheet.some((r) => r.Reason === 'Location' && Number(r.Count) >= 1)).toBe(true);
  } finally {
    await s.cleanup();
  }
});

test('candidate-detail page blocks a negative-stage move until a reason is chosen', async ({ page }) => {
  const s = await seedRelation('ui1', 'INTERNSHIP_IN_PROGRESS_450');
  try {
    await signInAdmin(page, s.adminEmail, s.pw);
    await page.goto(`/admin/candidates/${s.mentee.id}`);
    await expect(page.getByTestId('stage-select')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('stage-select').selectOption('INTERNSHIP_DROPPED_460');
    const dialog = page.getByTestId('dropoff-reason-dialog');
    await expect(dialog).toBeVisible();
    // Confirm is disabled with no reason chosen — the dialog is the only path
    // to the API, so this is what keeps the UI from ever sending a reason-less
    // negative-stage request.
    await expect(page.getByTestId('dropoff-reason-confirm')).toBeDisabled();

    await page.getByTestId('dropoff-reason-select').selectOption('SCHEDULE_CONFLICT');
    const putRes = page.waitForResponse((r) => r.url().includes(`/api/mentorship/${s.relation.id}`) && r.request().method() === 'PUT');
    await page.getByTestId('dropoff-reason-confirm').click();
    await putRes;

    const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } });
    expect(after.pipelineStatus).toBe('INTERNSHIP_DROPPED_460');
    const change = await prisma.statusChange.findFirstOrThrow({ where: { relationId: s.relation.id } });
    expect(change.reasonCode).toBe('SCHEDULE_CONFLICT');
  } finally {
    await s.cleanup();
  }
});
