import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { assertSafeDemoTarget } from './demoTarget.mjs';

// Rich DEMO seed (#550) — fully synthetic data for local development and demos,
// so nobody needs real user PII to work on the app. Idempotent: every record it
// creates is namespaced (emails end in @demo.example.com, names carry "Demo"),
// and re-running skips anything that already exists.
//
// Usage:  npm run seed:demo            (after: npx prisma db push)
// The base first-admin seed (prisma/seed.mjs) is unchanged and still runs via
// `npx prisma db seed`.
//
// SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1, at
// a `*_demo` database, or at a per-PR topic database (`internship_pr<N>`) with
// SEED_DEMO_FORCE=1. The shared preview/prod DBs must never receive demo rows
// by accident.

const prisma = new PrismaClient();

const DEMO_DOMAIN = 'demo.example.com';
const PASSWORD = process.env.SEED_DEMO_PASSWORD || 'DemoPass123!';

// The predicate itself lives in ./demoTarget.mjs so the fidelity checker
// (scripts/check-demo-fidelity.mjs, #2063) enforces the SAME definition of
// "local". Two copies could drift, and a guard that two tools disagree about
// is not a guard.
function assertSafeTarget() {
  assertSafeDemoTarget('seed-demo');
}

const MENTORS = [
  { email: `mentor.aylin@${DEMO_DOMAIN}`, fullName: 'Aylin Demo (Mentor)', skills: ['React', 'TypeScript', 'Next.js'], interests: 'Frontend architecture, mentoring juniors', mentorCapacity: 4 },
  { email: `mentor.baran@${DEMO_DOMAIN}`, fullName: 'Baran Demo (Mentor)', skills: ['Java', 'Spring', 'SQL'], interests: 'Backend systems, databases', mentorCapacity: 3 },
  { email: `mentor.ceyda@${DEMO_DOMAIN}`, fullName: 'Ceyda Demo (Mentor)', skills: ['Python', 'Data Engineering'], interests: 'Data pipelines, analytics', mentorCapacity: 2 },
];

const MENTEES = [
  { email: `mentee.deniz@${DEMO_DOMAIN}`, fullName: 'Deniz Demo', university: 'Boğaziçi University', department: 'Computer Engineering', graduationYear: 2027, city: 'Istanbul', skills: ['React', 'JavaScript'], targetPosition: 'Frontend Developer', stage: 'APPLICATION_100' },
  { email: `mentee.efe@${DEMO_DOMAIN}`, fullName: 'Efe Demo', university: 'ODTÜ', department: 'Computer Engineering', graduationYear: 2026, city: 'Ankara', skills: ['Java', 'Spring'], targetPosition: 'Backend Developer', stage: 'INTERVIEW_PENDING_250' },
  { email: `mentee.firat@${DEMO_DOMAIN}`, fullName: 'Fırat Demo', university: 'İTÜ', department: 'Software Engineering', graduationYear: 2026, city: 'Istanbul', skills: ['Python', 'SQL'], targetPosition: 'Data Engineer', stage: 'INTERNSHIP_STARTING_300' },
  { email: `mentee.gizem@${DEMO_DOMAIN}`, fullName: 'Gizem Demo', university: 'Bilkent University', department: 'Computer Science', graduationYear: 2026, city: 'Ankara', skills: ['React', 'Node.js'], targetPosition: 'Fullstack Developer', stage: 'INTERNSHIP_IN_PROGRESS_450' },
  { email: `mentee.hakan@${DEMO_DOMAIN}`, fullName: 'Hakan Demo', university: 'Ege University', department: 'Computer Engineering', graduationYear: 2025, city: 'Izmir', skills: ['C#', '.NET'], targetPosition: 'Backend Developer', stage: 'INTERNSHIP_COMPLETED_490' },
  { email: `mentee.irem@${DEMO_DOMAIN}`, fullName: 'İrem Demo', university: 'Hacettepe University', department: 'AI Engineering', graduationYear: 2025, city: 'Ankara', skills: ['Python', 'ML'], targetPosition: 'ML Engineer', stage: 'HIREABLE_600' },
  { email: `mentee.kaan@${DEMO_DOMAIN}`, fullName: 'Kaan Demo', university: 'Sabancı University', department: 'Computer Science', graduationYear: 2025, city: 'Istanbul', skills: ['TypeScript', 'Next.js'], targetPosition: 'Frontend Developer', stage: 'HIRED_660' },
  { email: `mentee.lale@${DEMO_DOMAIN}`, fullName: 'Lale Demo', university: 'KTÜ', department: 'Software Engineering', graduationYear: 2026, city: 'Trabzon', skills: ['Java', 'Kotlin'], targetPosition: 'Mobile Developer', stage: 'JOB_SEEKING_500' },
];

const COMPANIES = [
  { name: 'Demo Yazılım A.Ş.', industry: 'Software', size: '50-100', needs: [{ position: 'Frontend Developer', count: 2, period: '2026 Summer' }, { position: 'Backend Developer', count: 1, period: '2026 Summer' }] },
  { name: 'Demo Data GmbH', industry: 'Data & Analytics', size: '10-50', needs: [{ position: 'Data Engineer', count: 1, period: '2026 Fall' }] },
];

// ---------------------------------------------------------------------------
// The development / oversight half of the demo set (#2062): weekly reports,
// to-dos, mentor questions and document requirements. Everything below hangs
// off the mentors, mentees, relations and project created above rather than
// inventing a parallel world.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical Monday 00:00 UTC of the week `offsetWeeks` away from today — the
 * same anchoring the app itself uses (`utcWeekStart`, src/lib/week.ts), which
 * is what turns WeeklyReport's `@@unique([relationId, weekStart])` into the
 * dedupe key for a re-run instead of a source of duplicates.
 */
function utcMonday(offsetWeeks = 0) {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + offsetWeeks * 7);
  return day;
}

// A weekly diary only makes sense once the internship is running.
const REPORTING_STAGES = ['INTERNSHIP_IN_PROGRESS_450', 'INTERNSHIP_COMPLETED_490', 'HIREABLE_600', 'HIRED_660'];

// One piece of work per interning relation, so four diaries do not read as four
// copies of the same week. Indexed, not random — the seed stays deterministic.
const REPORT_TOPICS = ['the reporting screen', 'the CSV export', 'the analytics dashboard', 'the notification centre'];

// Three entries from the shared to-do pool, copied VERBATIM (title + all three
// languages) from prisma/seed-goal-templates.mjs. That seeder fills the pool on
// every prod deploy but is not part of the demo path — infra/server/demo-refresh.sh
// and infra/server/topic-deploy.sh run seed.mjs + seed-demo.mjs and nothing else
// — so without these three the demo has no shared template to hand out and the
// "your mentor sent you this" rendering path (ProjectTask.templateId) is dead.
// The Turkish wording is the pool's dedupe key, so copying it verbatim means a
// database where seed-goal-templates already ran gains nothing here.
const SHARED_TASK_TEMPLATES = [
  {
    key: 'run-locally',
    translations: {
      tr: 'Projeyi yerelde çalıştır: depoyu klonla, kur ve ayağa kaldır',
      en: 'Get the project running locally: clone, install, start it',
      de: 'Das Projekt lokal zum Laufen bringen: klonen, installieren, starten',
    },
  },
  {
    key: 'weekly-note',
    translations: {
      tr: 'Haftalık ilerleme notunu yaz ve mentoruna gönder',
      en: 'Write your weekly progress note and send it to your mentor',
      de: 'Den wöchentlichen Fortschrittsbericht schreiben und an den Mentor senden',
    },
  },
  {
    key: 'find-a-bug',
    translations: {
      tr: 'Bir hata (bug) bul ve nasıl tekrar edildiğini adım adım yaz',
      en: 'Find a bug and write down the steps to reproduce it',
      de: 'Einen Bug finden und die Schritte zum Reproduzieren aufschreiben',
    },
  },
];

// What the demo organisation asks every intern for. `labels` carries all three
// languages because that JSON shape is how the app renders a requirement per
// reader (src/lib/documentRequirements.ts). `appliesToStage` must be a real
// pipeline-stage key (src/lib/pipeline.ts).
const DOCUMENT_REQUIREMENTS = [
  {
    key: 'demo-internship-agreement',
    order: 0,
    appliesToStage: null,
    labels: { en: 'Internship agreement (demo)', tr: 'Staj sözleşmesi (demo)', de: 'Praktikumsvertrag (Demo)' },
  },
  {
    key: 'demo-insurance-form',
    order: 1,
    appliesToStage: null,
    labels: { en: 'Accident insurance form (demo)', tr: 'Kaza sigortası formu (demo)', de: 'Unfallversicherungsformular (Demo)' },
  },
  {
    key: 'demo-university-approval',
    order: 2,
    appliesToStage: 'INTERNSHIP_STARTING_300',
    labels: { en: 'University approval letter (demo)', tr: 'Üniversite onay yazısı (demo)', de: 'Genehmigungsschreiben der Universität (Demo)' },
  },
  {
    key: 'demo-final-report',
    order: 3,
    appliesToStage: 'INTERNSHIP_COMPLETED_490',
    labels: { en: 'Final internship report (demo)', tr: 'Staj bitirme raporu (demo)', de: 'Abschlussbericht des Praktikums (Demo)' },
  },
];

/**
 * A real, openable one-page PDF built from a few lines of synthetic text.
 *
 * Document.data is required bytes, and the app both sniffs the magic bytes on
 * upload (`contentMatchesType`, src/lib/fileType.ts) and hands the bytes back
 * on download — so a `Buffer.from('%PDF-1.4')` stub would satisfy the column
 * and then fail to open in front of whoever clicked it. Hand-rolled rather than
 * pulled from pdf-lib to keep the seeder's dependencies at prisma + bcryptjs,
 * and byte-for-byte deterministic: same text in, same bytes out, every run.
 *
 * The page uses the standard Helvetica font, so `lines` must be plain ASCII:
 * anything outside it is dropped rather than drawn as a stray glyph.
 */
function demoPdf(lines) {
  const escape = (value) => value.replace(/[^\x20-\x7e]/g, '').replace(/([\\()])/g, '\\$1');
  const stream = `${lines
    .map((line, index) => `BT /F1 12 Tf 72 ${700 - index * 18} Td (${escape(line)}) Tj ET`)
    .join('\n')}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function upsertUser({ email, fullName, role, extra = {} }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const user = await prisma.user.create({
    data: { email, password: hash, role, fullName, skills: [], ...extra },
  });
  console.log(`created ${role}: ${email}`);
  return user;
}

async function main() {
  assertSafeTarget();

  // Admin — the identity /demo hands out for the public demo (#966). Namespaced
  // like every other demo row, so it never collides with the real first admin
  // that prisma/seed.mjs creates from SEED_ADMIN_EMAIL.
  const demoAdmin = await upsertUser({
    email: `admin.demo@${DEMO_DOMAIN}`,
    fullName: 'Admin Demo',
    role: 'ADMIN',
    // Super admin (#1535): tenant management is gated on this flag, and the
    // demo identity is the only admin on a preview/topic environment — without
    // it /admin/organizations would be a dead screen there.
    extra: { emailVerified: true, isSuperAdmin: true },
  });
  // upsertUser leaves an existing row untouched, so a demo database seeded
  // before the flag existed needs this one idempotent nudge.
  if (!demoAdmin.isSuperAdmin) {
    await prisma.user.update({ where: { id: demoAdmin.id }, data: { isSuperAdmin: true } });
  }

  // Mentors
  const mentors = [];
  for (const m of MENTORS) {
    mentors.push(await upsertUser({
      email: m.email, fullName: m.fullName, role: 'MENTOR',
      extra: { skills: m.skills, interests: m.interests, mentorCapacity: m.mentorCapacity, emailVerified: true },
    }));
  }

  // Companies (+ needs + one read-only company login each)
  const companies = [];
  for (const c of COMPANIES) {
    let company = await prisma.company.findFirst({ where: { name: c.name } });
    if (!company) {
      company = await prisma.company.create({
        data: { name: c.name, industry: c.industry, size: c.size, needs: { create: c.needs } },
      });
      console.log(`created company: ${c.name}`);
    }
    companies.push(company);
    const loginEmail = `company.${companies.length}@${DEMO_DOMAIN}`;
    await upsertUser({
      email: loginEmail, fullName: `${c.name} Observer`, role: 'COMPANY',
      extra: { companyId: company.id, emailVerified: true },
    });
  }

  // A cohort to group the relations
  let cohort = await prisma.cohort.findFirst({ where: { name: 'Demo Cohort 2026' } });
  if (!cohort) cohort = await prisma.cohort.create({ data: { name: 'Demo Cohort 2026', term: '2026' } });

  // A demo project with tasks (owned by the first mentor)
  let project = await prisma.project.findFirst({ where: { name: 'Demo CRM Uygulaması' } });
  if (!project) {
    project = await prisma.project.create({
      data: {
        name: 'Demo CRM Uygulaması',
        description: 'Synthetic internship project used for demos.',
        technologies: ['TypeScript', 'Next.js', 'Prisma'],
        ownerType: 'MENTOR',
        ownerUserId: mentors[0].id,
        status: 'ACTIVE',
        tasks: { create: [
          { title: 'Set up repository', done: true, order: 0 },
          { title: 'Build login flow', done: true, order: 1 },
          { title: 'Implement dashboard', done: false, order: 2 },
        ] },
      },
    });
    console.log('created demo project');
  }

  // Mentees + relations spread across the pipeline
  for (let i = 0; i < MENTEES.length; i++) {
    const m = MENTEES[i];
    const mentor = mentors[i % mentors.length];
    const company = companies[i % companies.length];
    const mentee = await upsertUser({
      email: m.email, fullName: m.fullName, role: 'MENTEE',
      extra: {
        university: m.university, department: m.department, graduationYear: m.graduationYear,
        city: m.city, skills: m.skills, targetPosition: m.targetPosition, emailVerified: true,
        // Half the mentees opt into company visibility so the talent pool has content.
        ...(i % 2 === 0 ? { publicProfile: true, consents: { create: { type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } } } : {}),
      },
    });

    const existingRel = await prisma.mentorshipRelation.findFirst({ where: { menteeId: mentee.id } });
    if (existingRel) continue;

    const rel = await prisma.mentorshipRelation.create({
      data: {
        mentorId: mentor.id, menteeId: mentee.id,
        companyId: i % 2 === 0 ? company.id : null,
        cohortId: cohort.id,
        projectId: i === 3 ? project.id : null,
        pipelineStatus: m.stage,
        startDate: new Date(Date.now() - (60 - i * 5) * 24 * 60 * 60 * 1000),
      },
    });

    // Interaction history (varied recency so the attention queue has content)
    await prisma.interactionLog.create({
      data: { relationId: rel.id, type: 'Meeting', notes: 'Kick-off meeting (demo)', date: new Date(Date.now() - (30 - i * 3) * 24 * 60 * 60 * 1000) },
    });
    if (i % 2 === 0) {
      await prisma.interactionLog.create({
        data: { relationId: rel.id, type: 'Feedback', notes: 'Progress check (demo)', date: new Date(Date.now() - i * 2 * 24 * 60 * 60 * 1000) },
      });
    }

    // Goals — some open, some done
    await prisma.goal.create({ data: { relationId: rel.id, title: 'Complete onboarding checklist', status: 'DONE', completedAt: new Date(), createdByRole: 'MENTOR' } });
    if (i % 3 !== 0) {
      await prisma.goal.create({ data: { relationId: rel.id, title: 'Ship first feature PR', status: 'OPEN', createdByRole: 'MENTOR' } });
    }

    // A mentor evaluation for mentees past the internship start
    if (['INTERNSHIP_IN_PROGRESS_450', 'INTERNSHIP_COMPLETED_490', 'HIREABLE_600', 'HIRED_660'].includes(m.stage)) {
      await prisma.evaluation.create({
        data: {
          relationId: rel.id, authorId: mentor.id, type: m.stage === 'INTERNSHIP_COMPLETED_490' ? 'FINAL' : 'INTERIM',
          scores: { technical: 3 + (i % 3), communication: 4, reliability: 3 + (i % 2), growth: 4 },
          comment: 'Synthetic demo evaluation.',
        },
      });
    }

    // Status history so time-in-stage analytics have data
    await prisma.statusChange.create({
      data: { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: m.stage, changedById: mentor.id, createdAt: new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000) },
    });

    console.log(`created relation: ${m.fullName} → ${mentor.fullName} (${m.stage})`);
  }

  // Org backfill (#1272): the demo box reseeds between deploys, so without
  // this the freshly created org-less rows 403 the COMPANY demo account
  // (fail-closed org scoping, #1227) until the next deploy's backfill runs.
  const defaultOrg = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  for (const model of ['user', 'source', 'cohort', 'company', 'project', 'mentorshipRelation']) {
    await prisma[model].updateMany({ where: { orgId: null }, data: { orgId: defaultOrg.id } });
  }
  console.log('backfilled default org onto demo rows');

  // ---------------------------------------------------------------------------
  // Development / oversight half (#2062): weekly reports, to-dos, mentor
  // questions and document requirements. Until now these four screens seeded
  // zero rows, so the oversight story we tell a coordinator — "you see a weekly
  // report from every intern, the documents they still owe you, the questions
  // they asked and the to-dos they are working through" — was four empty
  // screens on every demo and per-PR environment.
  //
  // Deliberately placed AFTER the org backfill above: WeeklyReport.orgId and
  // DocumentRequirement.orgId are REQUIRED columns, and the relations and users
  // they read that id from only acquire theirs a few lines up.
  // ---------------------------------------------------------------------------

  const demoRelations = await prisma.mentorshipRelation.findMany({
    where: { mentee: { email: { endsWith: `@${DEMO_DOMAIN}` } } },
    select: { id: true, orgId: true, mentorId: true, menteeId: true, pipelineStatus: true, mentee: { select: { email: true } } },
    // Ordered by e-mail, not by date: `startDate` is derived from the wall
    // clock, and the content below is picked per index, so a stable order is
    // what keeps two runs on two machines identical.
    orderBy: { mentee: { email: 'asc' } },
  });
  const relationOf = (localPart) => demoRelations.find((relation) => relation.mentee.email === `${localPart}@${DEMO_DOMAIN}`);

  // Weekly reports — three consecutive weeks for every relation whose
  // internship has actually started: last-but-one reviewed and approved with a
  // mentor comment, last week either awaiting review or sent back for changes,
  // and this week still a draft. Monday-anchored, so the unique key makes a
  // re-run a no-op.
  const reportingRelations = demoRelations.filter((relation) => REPORTING_STAGES.includes(relation.pipelineStatus));
  let reportsCreated = 0;
  for (let index = 0; index < reportingRelations.length; index++) {
    const relation = reportingRelations[index];
    const topic = REPORT_TOPICS[index % REPORT_TOPICS.length];
    const weeks = [
      {
        weekStart: utcMonday(-2),
        summary: `Paired with my mentor on ${topic} and opened two pull requests. (demo)`,
        hoursSpent: 36,
        blockers: null,
        status: 'APPROVED',
        mentorComment: 'Solid week — keep the pull request descriptions this detailed. (demo)',
        reviewed: true,
      },
      index % 2 === 0
        ? {
            weekStart: utcMonday(-1),
            summary: `Built ${topic}, wrote its first tests and sat in on a code review. (demo)`,
            hoursSpent: 32,
            blockers: 'Not sure yet how to test the e-mail path. (demo)',
            status: 'SUBMITTED',
            mentorComment: null,
            reviewed: false,
          }
        : {
            weekStart: utcMonday(-1),
            summary: `Finished ${topic} and started on the filters. (demo)`,
            hoursSpent: 30,
            blockers: null,
            status: 'CHANGES_REQUESTED',
            mentorComment: 'Add what you took away from the code review and I will sign this off. (demo)',
            reviewed: true,
          },
      {
        weekStart: utcMonday(0),
        summary: `Notes so far: wrapping up ${topic}, then the print view. (demo)`,
        hoursSpent: 8,
        blockers: null,
        status: 'DRAFT',
        mentorComment: null,
        reviewed: false,
      },
    ];
    for (const week of weeks) {
      const existing = await prisma.weeklyReport.findUnique({
        where: { relationId_weekStart: { relationId: relation.id, weekStart: week.weekStart } },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.weeklyReport.create({
        data: {
          orgId: relation.orgId ?? defaultOrg.id,
          relationId: relation.id,
          weekStart: week.weekStart,
          summary: week.summary,
          hoursSpent: week.hoursSpent,
          blockers: week.blockers,
          status: week.status,
          mentorComment: week.mentorComment,
          reviewedById: week.reviewed ? relation.mentorId : null,
          // The Tuesday after the week it reviews — clamped to now, so a review
          // is never dated in the future when the seeder runs early in the week.
          reviewedAt: week.reviewed ? new Date(Math.min(week.weekStart.getTime() + 8 * DAY_MS, Date.now())) : null,
        },
      });
      reportsCreated++;
    }
  }
  console.log(`weekly reports: ${reportsCreated} created (${reportingRelations.length} interning relations × 3 weeks)`);

  // The shared to-do pool: the wording of a handed-out to-do is read from the
  // template every time it is displayed, so the pool has to exist before the
  // to-dos that reference it.
  const templateIdByKey = new Map();
  for (const template of SHARED_TASK_TEMPLATES) {
    // Dedupe on `title` exactly as prisma/seed-goal-templates.mjs does: MySQL
    // does not enforce @@unique([projectId, title]) across NULL projectIds.
    let row = await prisma.projectTaskTemplate.findFirst({
      where: { projectId: null, title: template.translations.tr },
      select: { id: true },
    });
    if (!row) {
      row = await prisma.projectTaskTemplate.create({
        data: { projectId: null, title: template.translations.tr, translations: template.translations },
        select: { id: true },
      });
    }
    templateIdByKey.set(template.key, row.id);
  }

  // To-dos (/todos). One row shape covers three cases and all three are here:
  // a project goal nobody has taken, a to-do a mentor handed over, and a line
  // somebody wrote for themselves. Two come from the shared pool (`templateId`
  // set), which is what makes them render in the reader's own language.
  // The project-scoped ones sit on Gizem's relation because that is the only
  // relation the demo project is attached to (`projectId: i === 3` above).
  const todoSpecs = [
    { mentee: 'mentee.gizem', projectId: project.id, order: 3, done: false, author: 'mentor', title: 'Write the sprint demo script (demo)' },
    { mentee: 'mentee.gizem', projectId: project.id, order: 4, done: true, author: 'mentor', templateKey: 'run-locally' },
    { mentee: null, projectId: project.id, order: 5, done: false, author: 'mentor', title: 'Polish the analytics dashboard — anyone can take this (demo)' },
    { mentee: 'mentee.hakan', projectId: null, order: 0, done: false, author: 'mentor', templateKey: 'weekly-note' },
    { mentee: 'mentee.firat', projectId: null, order: 0, done: false, author: 'self', title: 'Ask about the internship paperwork (demo)' },
    { mentee: 'mentee.firat', projectId: null, order: 1, done: true, author: 'mentor', templateKey: 'find-a-bug' },
  ];
  let todosCreated = 0;
  for (const spec of todoSpecs) {
    // An unassigned project goal (`mentee: null`) belongs to the project, not
    // to a person, so it needs no relation to hang off.
    const relation = spec.mentee ? relationOf(spec.mentee) : null;
    if (spec.mentee && !relation) continue;
    const templateId = spec.templateKey ? templateIdByKey.get(spec.templateKey) ?? null : null;
    // The snapshot title the app would store: resolved once from the assignee's
    // own language, which for a demo mentee (no preferredLanguage) is the
    // default locale — English (src/lib/goalTemplates.ts).
    const title = spec.templateKey
      ? SHARED_TASK_TEMPLATES.find((template) => template.key === spec.templateKey).translations.en
      : spec.title;
    const assigneeId = relation ? relation.menteeId : null;
    const existing = await prisma.projectTask.findFirst({
      where: { projectId: spec.projectId, title, assigneeId },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.projectTask.create({
      data: {
        projectId: spec.projectId,
        title,
        templateId,
        assigneeId,
        // Who wrote it, so "your mentor gave you this" and "you wrote this
        // yourself" stay distinguishable. An unassigned project goal has no
        // relation, so it is credited to the project's owner.
        createdById: spec.author === 'self' ? assigneeId : (relation?.mentorId ?? mentors[0].id),
        done: spec.done,
        doneAt: spec.done ? new Date(Date.now() - 3 * DAY_MS) : null,
        order: spec.order,
      },
    });
    todosCreated++;
  }
  console.log(`to-dos: ${todosCreated} created (${todoSpecs.filter((spec) => spec.templateKey).length} from the shared pool)`);

  // Mentor questions — the answered/unanswered split is the whole point of the
  // model, so one relation carries both.
  const questionSpecs = [
    {
      mentee: 'mentee.gizem',
      question: 'How much detail should the blockers section of the weekly report have? (demo)',
      answer: 'Enough that I can help without a follow-up question — one or two sentences per blocker. (demo)',
    },
    {
      mentee: 'mentee.gizem',
      question: 'Could we go through my pull request together before the sprint demo? (demo)',
      answer: null,
    },
    {
      mentee: 'mentee.firat',
      question: 'Which documents do I need to hand in before the internship starts? (demo)',
      answer: 'The internship agreement and the insurance form — both are listed on your documents page. (demo)',
    },
  ];
  let questionsCreated = 0;
  for (const spec of questionSpecs) {
    const relation = relationOf(spec.mentee);
    if (!relation) continue;
    const existing = await prisma.mentorQuestion.findFirst({
      where: { relationId: relation.id, question: spec.question },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.mentorQuestion.create({
      data: {
        relationId: relation.id,
        askedById: relation.menteeId,
        question: spec.question,
        answer: spec.answer,
        answeredAt: spec.answer ? new Date(Date.now() - 2 * DAY_MS) : null,
      },
    });
    questionsCreated++;
  }
  console.log(`mentor questions: ${questionsCreated} created (${questionSpecs.filter((spec) => spec.answer).length} answered)`);

  // Document requirements + the documents that fulfil some of them. Completion
  // is never stored on the requirement: it is derived from the documents that
  // carry its id, so leaving two requirements unfulfilled is what makes the
  // "still owed" half of the screen visible. `update: {}` on the upsert keeps
  // whatever an admin changed on the demo.
  const requirementIdByKey = new Map();
  for (const requirement of DOCUMENT_REQUIREMENTS) {
    const row = await prisma.documentRequirement.upsert({
      where: { orgId_key: { orgId: defaultOrg.id, key: requirement.key } },
      update: {},
      create: {
        orgId: defaultOrg.id,
        key: requirement.key,
        labels: requirement.labels,
        appliesToStage: requirement.appliesToStage,
        appliesToRole: 'MENTEE',
        mandatory: true,
        order: requirement.order,
      },
      select: { id: true },
    });
    requirementIdByKey.set(requirement.key, row.id);
  }

  const documentSpecs = [
    {
      mentee: 'mentee.gizem',
      requirementKey: 'demo-internship-agreement',
      type: 'CONTRACT',
      title: 'Internship agreement (demo)',
      filename: 'internship-agreement-demo.pdf',
      uploader: 'self',
    },
    {
      mentee: 'mentee.hakan',
      requirementKey: 'demo-internship-agreement',
      type: 'CONTRACT',
      title: 'Internship agreement (demo)',
      filename: 'internship-agreement-demo.pdf',
      // Handed in on paper and scanned by the mentor — the other upload path.
      uploader: 'mentor',
    },
    {
      mentee: 'mentee.hakan',
      requirementKey: 'demo-final-report',
      type: 'OTHER',
      title: 'Final internship report (demo)',
      filename: 'final-internship-report-demo.pdf',
      uploader: 'self',
    },
  ];
  let documentsCreated = 0;
  for (const spec of documentSpecs) {
    const relation = relationOf(spec.mentee);
    const requirementId = requirementIdByKey.get(spec.requirementKey);
    if (!relation || !requirementId) continue;
    const existing = await prisma.document.findFirst({
      where: { ownerId: relation.menteeId, requirementId },
      select: { id: true },
    });
    if (existing) continue;
    const bytes = demoPdf([
      spec.title,
      'Synthetic demo document - contains no real personal data.',
      `Demo CRM / ${spec.filename}`,
    ]);
    await prisma.document.create({
      data: {
        ownerId: relation.menteeId,
        uploaderId: spec.uploader === 'self' ? relation.menteeId : relation.mentorId,
        requirementId,
        type: spec.type,
        title: spec.title,
        filename: spec.filename,
        contentType: 'application/pdf',
        size: bytes.length,
        data: bytes,
      },
    });
    documentsCreated++;
  }
  console.log(
    `document requirements: ${DOCUMENT_REQUIREMENTS.length} in place, ${documentsCreated} document(s) created ` +
    '(the insurance form and the university letter stay unfulfilled on purpose)'
  );

  // Contributor terms (#1025, #1026). The demo set portrays projects that have
  // been running for a while, and someone who has been on a project for months
  // has long since accepted its terms — so the realistic demo state is accepted,
  // not a legal wall on the first click. Idempotent: only ever adds what is
  // missing, and does nothing at all when no terms are configured.
  const demoTerms = await prisma.contributorTerms.findFirst({
    where: { key: 'default' },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    select: { version: true },
  });
  if (demoTerms) {
    const demoUsers = await prisma.user.findMany({
      where: { email: { endsWith: `@${DEMO_DOMAIN}` } },
      select: { id: true },
    });
    const demoMembers = await prisma.projectMember.findMany({
      where: { userId: { in: demoUsers.map((u) => u.id) } },
      select: { userId: true, projectId: true },
    });
    const wanted = [
      ...demoUsers.map((u) => ({ userId: u.id, projectId: null })),
      ...demoMembers.map((m) => ({ userId: m.userId, projectId: m.projectId })),
    ];
    let accepted = 0;
    for (const w of wanted) {
      const exists = await prisma.contributorTermsAcceptance.findFirst({
        where: { userId: w.userId, termsKey: 'default', version: demoTerms.version, projectId: w.projectId },
        select: { id: true },
      });
      if (exists) continue;
      await prisma.contributorTermsAcceptance.create({
        data: { userId: w.userId, termsKey: 'default', version: demoTerms.version, projectId: w.projectId },
      });
      accepted++;
    }
    console.log(`recorded ${accepted} demo contributor-terms acceptances`);
  }

  console.log(`\nDemo seed complete. All demo accounts share the password: ${PASSWORD}`);
  console.log(`Demo accounts use the @${DEMO_DOMAIN} domain — no real PII involved.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
