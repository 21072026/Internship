import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// Mid-programme migration (#2073): a four-sheet export with its own column
// names and stage names. An org of its own, so the stages are the default
// catalogue and nothing else is in the way.

const PW = 'Migrate123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a four-sheet migration previews, applies with original dates, re-runs as unchanged and sends no mail', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `Migrate ${stamp}`, slug: `migrate-${stamp}` } });
  const adminEmail = uniqueEmail('mig-admin');
  const otherMentorEmail = uniqueEmail('mig-staff');
  const mentor = `mig-mentor-${stamp}@demo.example.com`;
  const ada = `mig-ada-${stamp}@demo.example.com`;
  const bo = `mig-bo-${stamp}@demo.example.com`;
  const migrated = [mentor, ada, bo];
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Migrate Admin', org.id);
    await seedUser(otherMentorEmail, PW, 'MENTOR', 'Staff Mentor', org.id);

    // The incumbent's headers and stage names — none of them ours.
    const body = {
      sheets: {
        people: `Mail;Name;Rolle\n${mentor};Deniz Mentor;Mentor\n${ada};Ada Lovelace;Praktikant\n${bo};Bo Tester;mentee`,
        pairs: `mentor,mentee,state\n${mentor},${ada},active\n${mentor},${bo},completed`,
        stageHistory: [
          'mentor,mentee,stage,when',
          `${mentor},${ada},Im Praktikum,01.03.2026`,
          `${mentor},${ada},Interview,2026-02-01`,
          `${mentor},${ada},Archiv,2026-03-15`,
          `${mentor},${ada},Interview,2099-01-01`,
          `${mentor},${bo},Eingestellt,2026-05-01`,
        ].join('\n'),
        interactions: [
          'mentor,mentee,date,kind,topic,notes',
          `${mentor},${ada},2026-02-10,Görüşme,Kickoff,Agreed on the first goals.`,
          `${mentor},${ada},2026-03-05,e-mail,,Sent the internship plan.`,
          `${mentor},nobody-${stamp}@demo.example.com,2026-03-05,Meeting,,Not a pair.`,
        ].join('\n'),
      },
      mapping: {
        people: { email: 'Mail', fullName: 'Name', role: 'Rolle' },
        pairs: { mentorEmail: 'mentor', menteeEmail: 'mentee', status: 'state' },
        stageHistory: { mentorEmail: 'mentor', menteeEmail: 'mentee', toStage: 'stage', date: 'when' },
        interactions: { mentorEmail: 'mentor', menteeEmail: 'mentee', type: 'kind', subject: 'topic' },
      },
      stageMap: { Interview: 'INTERVIEW_PENDING_250', 'Im Praktikum': 'INTERNSHIP_IN_PROGRESS_450', Eingestellt: 'HIRED_660' },
    };

    // A mentor is refused at the route.
    await signInAndSettle(page, otherMentorEmail, PW, '/mentor');
    expect((await page.request.post('/api/admin/migrate', { data: body })).status()).toBe(403);

    await signInAsFreshUser(page, adminEmail, PW, '/admin');
    // A stage map naming something that is not a stage here is refused up front.
    const badMap = await page.request.post('/api/admin/migrate', { data: { ...body, stageMap: { Interview: 'NOPE' } } });
    expect(badMap.status()).toBe(400);
    expect((await badMap.json()).code).toBe('invalid_stage_target');

    const mailBefore = await prisma.emailLog.count({ where: { to: { in: migrated } } });

    // 1. The rehearsal: everything previewed, nothing written.
    const dry = await (await page.request.post('/api/admin/migrate', { data: body })).json();
    expect(dry.dryRun).toBe(true);
    expect(dry.sheets.people.counts).toMatchObject({ CREATE: 3 });
    expect(dry.sheets.pairs.counts).toMatchObject({ CREATE: 2 });
    expect(dry.sheets.stageHistory.counts).toMatchObject({ CREATE: 3, ERROR: 2 });
    const reasons = dry.sheets.stageHistory.rows.filter((r: { status: string }) => r.status === 'ERROR').map((r: { reason: string }) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining(['unmapped stage "Archiv"', 'date is in the future']));
    expect(dry.sheets.interactions.counts).toMatchObject({ CREATE: 2, SKIP: 1 });
    expect(await prisma.user.count({ where: { email: { in: migrated } } })).toBe(0);

    // 2. The real run.
    const real = await (await page.request.post('/api/admin/migrate', { data: { ...body, confirm: true } })).json();
    expect(real.dryRun).toBe(false);
    const users = await prisma.user.findMany({ where: { email: { in: migrated } }, select: { id: true, email: true, role: true, orgId: true } });
    expect(users).toHaveLength(3);
    expect(users.every((u) => u.orgId === org.id)).toBe(true);
    expect(users.find((u) => u.email === mentor)?.role).toBe('MENTOR');
    const rels = await prisma.mentorshipRelation.findMany({
      where: { mentorId: users.find((u) => u.email === mentor)!.id },
      select: { id: true, menteeId: true, status: true, pipelineStatus: true, orgId: true },
    });
    expect(rels).toHaveLength(2);
    expect(rels.every((r) => r.orgId === org.id)).toBe(true);
    const adaRel = rels.find((r) => r.menteeId === users.find((u) => u.email === ada)!.id)!;
    const boRel = rels.find((r) => r.menteeId === users.find((u) => u.email === bo)!.id)!;
    expect(adaRel).toMatchObject({ status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' });
    expect(boRel).toMatchObject({ status: 'COMPLETED', pipelineStatus: 'HIRED_660' });
    const history = await prisma.statusChange.findMany({ where: { relationId: adaRel.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => [h.fromStatus, h.toStatus, h.createdAt.toISOString().slice(0, 10)])).toEqual([
      ['APPLICATION_100', 'INTERVIEW_PENDING_250', '2026-02-01'],
      ['INTERVIEW_PENDING_250', 'INTERNSHIP_IN_PROGRESS_450', '2026-03-01'],
    ]);
    // Each pair stands where its last move took it, and no move goes nowhere (#934).
    expect(await prisma.statusChange.count({ where: { relationId: { in: [adaRel.id, boRel.id] }, fromStatus: { equals: prisma.statusChange.fields.toStatus } } })).toBe(0);
    const logs = await prisma.interactionLog.findMany({ where: { relationId: adaRel.id }, orderBy: { date: 'asc' } });
    expect(logs.map((l) => [l.type, l.date.toISOString().slice(0, 10)])).toEqual([['Meeting', '2026-02-10'], ['Email', '2026-03-05']]);

    // 3. The same file again: nothing new.
    const again = await (await page.request.post('/api/admin/migrate', { data: { ...body, confirm: true } })).json();
    expect(again.sheets.people.counts).toMatchObject({ CREATE: 0, UNCHANGED: 3 });
    expect(again.sheets.pairs.counts).toMatchObject({ CREATE: 0, UNCHANGED: 2 });
    expect(again.sheets.stageHistory.counts).toMatchObject({ CREATE: 0, UNCHANGED: 3 });
    expect(again.sheets.interactions.counts).toMatchObject({ CREATE: 0, UNCHANGED: 2 });
    expect(await prisma.user.count({ where: { email: { in: migrated } } })).toBe(3);
    expect(await prisma.mentorshipRelation.count({ where: { id: { in: rels.map((r) => r.id) } } })).toBe(2);
    expect(await prisma.statusChange.count({ where: { relationId: adaRel.id } })).toBe(2);
    expect(await prisma.interactionLog.count({ where: { relationId: adaRel.id } })).toBe(2);

    // Not one e-mail to anybody the migration touched.
    expect(await prisma.emailLog.count({ where: { to: { in: migrated } } })).toBe(mailBefore);
  } finally {
    for (const e of migrated) await cleanupByEmail(e);
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(otherMentorEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});

test('the migration screen proposes the columns, takes an explicit stage map, previews, then migrates', async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `Migrate UI ${stamp}`, slug: `migrate-ui-${stamp}` } });
  const adminEmail = uniqueEmail('migui-admin');
  const mentor = `migui-mentor-${stamp}@demo.example.com`;
  const ada = `migui-ada-${stamp}@demo.example.com`;
  const migrated = [mentor, ada];
  const file = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Migrate UI Admin', org.id);
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await page.goto('/admin/migrate');
    await expect(page.getByTestId('migrate-no-mail')).toBeVisible();

    // Turkish headers, German stage names.
    await page.getByTestId('migrate-upload-people').setInputFiles(file('people.csv', `E-Posta;Ad Soyad;Rol\n${mentor};Deniz;Mentör\n${ada};Ada;Mentee`));
    await page.getByTestId('migrate-upload-pairs').setInputFiles(file('pairs.csv', `Mentor,Mentee,Durum\n${mentor},${ada},aktif`));
    await page.getByTestId('migrate-upload-stageHistory').setInputFiles(
      file('history.csv', `Mentor,Stajyer,Aşama,Tarih\n${mentor},${ada},Interview,01.02.2026\n${mentor},${ada},Im Praktikum,01.03.2026\n${mentor},${ada},Archiv,15.03.2026`),
    );
    await expect(page.getByTestId('migrate-loaded-stageHistory')).toContainText('3');

    // The mapping is proposed from the headers.
    await expect(page.getByTestId('migrate-mapping-people-email')).toHaveValue('E-Posta');
    await expect(page.getByTestId('migrate-mapping-people-fullName')).toHaveValue('Ad Soyad');
    await expect(page.getByTestId('migrate-mapping-stageHistory-menteeEmail')).toHaveValue('Stajyer');
    await expect(page.getByTestId('migrate-mapping-stageHistory-toStage')).toHaveValue('Aşama');

    // Two stages mapped; "Archiv" deliberately left unmapped.
    await page.getByTestId('migrate-stagemap-Interview').selectOption('INTERVIEW_PENDING_250');
    await page.getByTestId('migrate-stagemap-Im Praktikum').selectOption('INTERNSHIP_IN_PROGRESS_450');
    await page.getByTestId('migrate-preview').click();
    const result = page.getByTestId('migrate-result');
    await expect(result).toHaveAttribute('data-dry-run', 'true');
    const history = page.getByTestId('migrate-sheet-stageHistory');
    await expect(history.getByTestId('import-preview-counts').locator('[data-status="CREATE"]')).toHaveAttribute('data-count', '2');
    await expect(history.getByTestId('import-preview-row-3')).toHaveAttribute('data-status', 'ERROR');
    await expect(history.getByTestId('import-preview-row-3')).toContainText('Stage "Archiv" is not mapped');
    expect(await prisma.user.count({ where: { email: { in: migrated } } })).toBe(0);

    await page.getByTestId('migrate-confirm').click();
    await expect(result).toHaveAttribute('data-dry-run', 'false');
    const rel = await prisma.mentorshipRelation.findFirst({ where: { mentee: { email: ada } }, select: { pipelineStatus: true, orgId: true, status: true } });
    expect(rel).toEqual({ pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450', orgId: org.id, status: 'ACTIVE' });
  } finally {
    for (const e of migrated) await cleanupByEmail(e);
    await cleanupByEmail(adminEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
