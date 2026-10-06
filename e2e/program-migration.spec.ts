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
