import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Rich DEMO seed (#550) — fully synthetic data for local development and demos,
// so nobody needs real user PII to work on the app. Idempotent: every record it
// creates is namespaced (emails end in @demo.example.com, names carry "Demo"),
// and re-running skips anything that already exists.
//
// Usage:  npm run seed:demo            (after: npx prisma db push)
// The base first-admin seed (prisma/seed.mjs) is unchanged and still runs via
// `npx prisma db seed`.
//
// SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1,
// or SEED_DEMO_FORCE=1 is set explicitly. The shared preview/prod DBs must
// never receive demo rows by accident.

const prisma = new PrismaClient();

const DEMO_DOMAIN = 'demo.example.com';
const PASSWORD = process.env.SEED_DEMO_PASSWORD || 'DemoPass123!';

function assertSafeTarget() {
  const url = process.env.DATABASE_URL || '';
  const local = /@(localhost|127\.0\.0\.1|mysql|db)[:/]/.test(url);
  if (!local && process.env.SEED_DEMO_FORCE !== '1') {
    console.error(
      'seed-demo: DATABASE_URL does not look local. Refusing to seed demo data.\n' +
      'Set SEED_DEMO_FORCE=1 only if you are certain this is not the shared preview/prod DB.'
    );
    process.exit(1);
  }
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

  console.log(`\nDemo seed complete. All demo accounts share the password: ${PASSWORD}`);
  console.log(`Demo accounts use the @${DEMO_DOMAIN} domain — no real PII involved.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
