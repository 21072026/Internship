#!/usr/bin/env node
// A programme at scale, for measuring the admin screens on a developer machine
// (#1434). The demo set has 8 candidates; the product's target is a whole
// programme's pool, and the four admin screens that broke at 1 000 (#1436–#1439)
// are re-measured here at 5 000.
//
// WHAT IT WRITES — into ONE organisation of its own (slug `scale-local`), so the
// default org and the demo set (prisma/seed-demo.mjs, #1379) are untouched:
//   - an ADMIN to sign in with:   admin.scale@scale.example.test / ScalePass123!
//   - SCALE_MENTORS mentors (default 40)
//   - SCALE_MENTEES mentees (default 5 000) — names drawn from small lists, so the
//     duplicate scan meets the near-twins a real pool has
//   - one relation for every SCALE_RELATION_EVERY-th mentee (default every 3rd),
//     spread over the pipeline stages
// Re-running tops the org up to the numbers; it never deletes or rewrites a row.
//
// SAFETY: DATABASE_URL must be a localhost/127.0.0.1 MySQL URL —
// isLocalOnlyTarget() in prisma/demoTarget.mjs, unit-tested in
// scripts/test/demo-target.test.mjs. No force flag, no database-name exception.
// Not wired into any deploy or CI step on purpose.
//
// Usage:  npx prisma db push && node scripts/seed-scale.mjs
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { assertLocalOnlyTarget } from '../prisma/demoTarget.mjs';

assertLocalOnlyTarget('seed-scale');

const MENTEES = Number(process.env.SCALE_MENTEES || 5000);
const MENTORS = Number(process.env.SCALE_MENTORS || 40);
const RELATION_EVERY = Number(process.env.SCALE_RELATION_EVERY || 3);
const DOMAIN = 'scale.example.test';
const ADMIN_EMAIL = `admin.scale@${DOMAIN}`;
const PASSWORD = 'ScalePass123!';
const BATCH = 500;

const STAGES = [
  'APPLICATION_100', 'APPROVAL_PENDING_220', 'INTERVIEW_PENDING_250', 'INTRODUCTION_PENDING_270',
  'INTERNSHIP_STARTING_300', 'INTERNSHIP_IN_PROGRESS_450', 'INTERNSHIP_COMPLETED_490',
  'JOB_SEEKING_500', 'HIREABLE_600', 'HIRED_660', 'EMPLOYED_700',
];
const FIRST = ['Ada', 'Ali', 'Ayşe', 'Berk', 'Can', 'Deniz', 'Elif', 'Emre', 'Ece', 'Hasan', 'Jonas', 'Lea', 'Mehmet', 'Mia', 'Noah', 'Selin', 'Zeynep', 'Lukas', 'Sara', 'Yusuf'];
const LAST = ['Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Müller', 'Schmidt', 'Weber', 'Fischer', 'Arslan', 'Doğan', 'Koch', 'Aydın', 'Öztürk', 'Becker'];
const UNIS = ['Synthetic University A', 'Synthetic University B', 'Synthetic Technical College', 'Example Institute'];

const nameAt = (i) => `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${Math.floor(i / (FIRST.length * LAST.length)) || ''}`.trim();

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'scale-local' },
    update: {},
    create: { slug: 'scale-local', name: 'Scale (local)' },
    select: { id: true },
  });
  const hash = await bcrypt.hash(PASSWORD, 10);

  // The admin: rows are per world (`@@unique([email, orgId])`), so look up in this org only.
  const admin = await prisma.user.findFirst({ where: { email: ADMIN_EMAIL, orgId: org.id }, select: { id: true } });
  if (!admin) {
    await prisma.user.create({
      data: { email: ADMIN_EMAIL, password: hash, role: 'ADMIN', fullName: 'Scale Admin', skills: [], orgId: org.id, isActive: true, emailVerified: true },
    });
  }

  const topUp = async (role, target, emailAt, extra) => {
    const have = await prisma.user.count({ where: { orgId: org.id, role } });
    for (let start = have; start < target; start += BATCH) {
      const end = Math.min(target, start + BATCH);
      await prisma.user.createMany({
        data: Array.from({ length: end - start }, (_, k) => {
          const i = start + k;
          return { email: emailAt(i), password: hash, role, skills: [], orgId: org.id, isActive: true, emailVerified: true, ...extra(i) };
        }),
        skipDuplicates: true,
      });
    }
    return Math.max(0, target - have);
  };

  const newMentors = await topUp('MENTOR', MENTORS, (i) => `mentor.${i}@${DOMAIN}`, (i) => ({
    fullName: `Mentor ${nameAt(i * 7)}`,
    mentorCapacity: 40,
    mentorOnboardingSeenAt: new Date(),
  }));
  const newMentees = await topUp('MENTEE', MENTEES, (i) => `mentee.${i}@${DOMAIN}`, (i) => ({
    fullName: nameAt(i),
    university: UNIS[i % UNIS.length],
    graduationYear: 2024 + (i % 4),
  }));

  // Relations: every RELATION_EVERY-th mentee without one gets a mentor, round-robin.
  const mentors = await prisma.user.findMany({ where: { orgId: org.id, role: 'MENTOR' }, select: { id: true }, orderBy: { email: 'asc' } });
  const mentees = await prisma.user.findMany({
    where: { orgId: org.id, role: 'MENTEE', menteeRelations: { none: {} } },
    select: { id: true, email: true },
    orderBy: { email: 'asc' },
  });
  const wanted = mentees.filter((m) => Number(/^mentee\.(\d+)@/.exec(m.email)?.[1] ?? 1) % RELATION_EVERY === 0);
  let relations = 0;
  for (let start = 0; start < wanted.length; start += BATCH) {
    const chunk = wanted.slice(start, start + BATCH);
    const res = await prisma.mentorshipRelation.createMany({
      data: chunk.map((m, k) => ({
        mentorId: mentors[(start + k) % mentors.length].id,
        menteeId: m.id,
        orgId: org.id,
        status: 'ACTIVE',
        pipelineStatus: STAGES[(start + k) % STAGES.length],
        startDate: new Date(Date.now() - ((start + k) % 365) * 86_400_000),
      })),
    });
    relations += res.count;
  }

  const totals = {
    mentees: await prisma.user.count({ where: { orgId: org.id, role: 'MENTEE' } }),
    mentors: await prisma.user.count({ where: { orgId: org.id, role: 'MENTOR' } }),
    relations: await prisma.mentorshipRelation.count({ where: { orgId: org.id } }),
  };
  console.log(`seed-scale: +${newMentees} mentees, +${newMentors} mentors, +${relations} relations → ${JSON.stringify(totals)}`);
  console.log(`seed-scale: sign in as ${ADMIN_EMAIL} / ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
