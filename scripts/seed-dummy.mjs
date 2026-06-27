#!/usr/bin/env node
/**
 * Seed realistic DUMMY data into a NON-production database (e.g. preview), so the
 * test environment never holds real people's PII.
 *
 * Usage:
 *   node scripts/seed-dummy.mjs                 # add dummy data
 *   node scripts/seed-dummy.mjs --wipe          # delete existing mentees/mentors first
 *   node scripts/seed-dummy.mjs --wipe --count=48 --force
 *
 * Safety: refuses to --wipe a database literally named `internship_crm` (prod)
 * unless --force is given. ADMIN users and companies are preserved.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const WIPE = !!args.wipe;
const FORCE = !!args.force;
const COUNT = Number(args.count) || 48;

const prisma = new PrismaClient();

// Simple seeded PRNG for reproducible-ish output.
let _s = 1234567;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const some = (arr, n) => [...arr].sort(() => rnd() - 0.5).slice(0, n);

const FIRST = ['Elif', 'Yusuf', 'Lena', 'Mert', 'Aylin', 'Jonas', 'Zeynep', 'Lukas', 'Deniz', 'Mia',
  'Emre', 'Hannah', 'Can', 'Leon', 'Selin', 'Felix', 'Ada', 'Noah', 'Ece', 'Paul',
  'Buse', 'Finn', 'Derya', 'Ben', 'Naz', 'Tim', 'Irem', 'Jan', 'Sena', 'Max'];
const LAST = ['Yılmaz', 'Schmidt', 'Demir', 'Müller', 'Kaya', 'Fischer', 'Şahin', 'Weber', 'Çelik',
  'Wagner', 'Aydın', 'Becker', 'Öztürk', 'Hoffmann', 'Arslan', 'Schulz', 'Doğan', 'Koch', 'Kurt', 'Bauer'];
const CITIES = ['Köln', 'Düsseldorf', 'Monheim am Rhein', 'Berlin', 'Hamburg', 'München', 'Frankfurt',
  'Leverkusen', 'Bonn', 'Essen', 'Dortmund', 'Remscheid'];
const UNIS = ['TH Köln', 'RWTH Aachen', 'Uni Düsseldorf', 'TU Dortmund', 'Uni zu Köln', 'FH Aachen',
  'Hochschule Bonn-Rhein-Sieg', 'TU München', 'Uni Duisburg-Essen'];
const DEPTS = ['Informatik', 'Wirtschaftsinformatik', 'Software Engineering', 'Data Science',
  'Elektrotechnik', 'Mechatronik', 'BWL', 'Cyber Security'];
const SKILLS = ['React', 'TypeScript', 'Node.js', 'Python', 'Java', 'SQL', 'Docker', 'AWS', 'Figma',
  'Next.js', 'C#', 'Kotlin', 'Data Analysis', 'Machine Learning', 'Linux', 'Git'];
const STATUSES = [
  'APPLICATION_100', 'APPROVAL_PENDING_220', 'INTERVIEW_PENDING_250', 'INTRODUCTION_PENDING_270',
  'INTERNSHIP_STARTING_300', 'INTERNSHIP_IN_PROGRESS_450', 'INTERNSHIP_DROPPED_460',
  'INTERNSHIP_COMPLETED_490', 'JOB_SEEKING_500', 'HIREABLE_600', 'HIRED_660', 'EMPLOYED_700',
  'INTERNSHIP_FOUND_ELSEWHERE_800',
];
const PROJECTS = ['BCS-IT', 'OKAY', 'NFC', 'Abics'];
const INTERACTION_TYPES = ['Meeting', 'Feedback', 'Email'];
const NOTES = ['İlk tanışma görüşmesi yapıldı.', 'CV birlikte gözden geçirildi.', 'Teknik mülakat hazırlığı.',
  'Haftalık ilerleme kontrolü.', 'Staj yeri ile görüşüldü.', 'Geri bildirim verildi.', 'Hedefler güncellendi.'];

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

async function dbName() {
  const r = await prisma.$queryRawUnsafe('SELECT DATABASE() AS db');
  return r?.[0]?.db ?? '';
}

async function wipe() {
  const db = await dbName();
  if (db === 'internship_crm' && !FORCE) {
    throw new Error(`Refusing to --wipe production DB "${db}" without --force.`);
  }
  console.log(`Wiping non-admin users and all relations from "${db}"...`);
  await prisma.statusChange.deleteMany({});
  await prisma.interactionLog.deleteMany({});
  await prisma.mentorshipRelation.deleteMany({});
  const r = await prisma.user.deleteMany({ where: { role: { not: 'ADMIN' } } });
  console.log(`Deleted ${r.count} non-admin users.`);
}

async function ensureCompanies() {
  const map = {};
  for (const name of PROJECTS) {
    const c = (await prisma.company.findFirst({ where: { name } })) ?? (await prisma.company.create({ data: { name } }));
    map[name] = c.id;
  }
  return map;
}

async function main() {
  if (WIPE) await wipe();
  const companies = await ensureCompanies();
  const pw = await bcrypt.hash('DummyPass123!', 10);

  // A few mentors
  const mentors = [];
  for (const m of [['Aysun Korkmaz', 'aysun.korkmaz'], ['Daniel Krause', 'daniel.krause'], ['Hakan Yıldız', 'hakan.yildiz']]) {
    const email = `${m[1]}@example.com`;
    const mentor = (await prisma.user.findUnique({ where: { email } })) ??
      (await prisma.user.create({ data: { email, password: pw, role: 'MENTOR', fullName: m[0], skills: [] } }));
    mentors.push(mentor);
  }

  let created = 0;
  for (let i = 0; i < COUNT; i++) {
    const first = pick(FIRST), last = pick(LAST);
    const fullName = `${first} ${last}`;
    const email = `${slug(fullName)}.${i}@example.com`;
    const status = STATUSES[i % STATUSES.length];
    const mentor = mentors[i % mentors.length];
    const project = rnd() < 0.85 ? pick(PROJECTS) : null;

    const mentee = await prisma.user.create({
      data: {
        email,
        password: pw,
        role: 'MENTEE',
        fullName,
        city: pick(CITIES),
        university: pick(UNIS),
        department: pick(DEPTS),
        graduationYear: 2024 + Math.floor(rnd() * 4),
        phone: `+49 1${Math.floor(500 + rnd() * 400)} ${Math.floor(1000000 + rnd() * 8999999)}`,
        whatsapp: rnd() < 0.6 ? `+49 1${Math.floor(500 + rnd() * 400)}${Math.floor(1000000 + rnd() * 8999999)}` : null,
        skills: some(SKILLS, 2 + Math.floor(rnd() * 4)),
      },
    });

    const rel = await prisma.mentorshipRelation.create({
      data: {
        mentorId: mentor.id,
        menteeId: mentee.id,
        pipelineStatus: status,
        companyId: project ? companies[project] : null,
      },
    });

    // a couple of interactions
    const nInt = Math.floor(rnd() * 3);
    for (let k = 0; k < nInt; k++) {
      await prisma.interactionLog.create({
        data: { relationId: rel.id, date: new Date(2025, 0, 1 + Math.floor(rnd() * 300)), notes: pick(NOTES), type: pick(INTERACTION_TYPES) },
      });
    }
    // a status-history entry for advanced stages
    if (STATUSES.indexOf(status) > 1) {
      await prisma.statusChange.create({
        data: { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: status, changedById: mentor.id },
      });
    }
    created++;
  }
  console.log(`Created ${mentors.length} mentors and ${created} dummy mentees.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
