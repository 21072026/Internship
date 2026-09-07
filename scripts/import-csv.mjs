#!/usr/bin/env node
/**
 * Import the legacy mentoring spreadsheet (CSV) into the CRM.
 *
 * Usage:
 *   node scripts/import-csv.mjs --file=data.csv                 # dry-run (no writes)
 *   node scripts/import-csv.mjs --url="https://.../pub?output=csv"
 *   node scripts/import-csv.mjs --file=data.csv --owner=admin@example.com --apply
 *
 * Dry-run is the default: it parses, maps and reports without touching the DB.
 * --apply requires --owner (an existing MENTOR/ADMIN that owns the imported
 * mentees). The import is idempotent: re-running upserts by (synthetic) email.
 *
 * Data hygiene: the "firma hesap bilgileri" column may contain credentials and
 * is never imported. "46199" (empty-date artifact), "#REF!" and "-" become null.
 */
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const APPLY = !!args.apply;

const STATUS_MAP = {
  100: 'APPLICATION_100',
  220: 'APPROVAL_PENDING_220',
  250: 'INTERVIEW_PENDING_250',
  270: 'INTRODUCTION_PENDING_270',
  300: 'INTERNSHIP_STARTING_300',
  450: 'INTERNSHIP_IN_PROGRESS_450',
  460: 'INTERNSHIP_DROPPED_460',
  490: 'INTERNSHIP_COMPLETED_490',
  500: 'JOB_SEEKING_500',
  600: 'HIREABLE_600',
  660: 'HIRED_660',
  700: 'EMPLOYED_700',
  800: 'INTERNSHIP_FOUND_ELSEWHERE_800',
};

const clean = (v) => {
  const s = (v ?? '').trim();
  if (!s || s === '-' || s === '#REF!' || s === '46199') return null;
  return s;
};
const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');

const STATUS_KEYS = Object.keys(STATUS_MAP).map(Number);
function mapStatus(raw) {
  const s = clean(raw);
  if (!s) return 'APPLICATION_100';
  const m = s.match(/(\d{3})/);
  if (!m) return 'APPLICATION_100';
  const n = Number(m[1]);
  if (STATUS_MAP[n]) return STATUS_MAP[n];
  // In-between legacy codes (e.g. 230/260/440) -> nearest defined stage.
  const nearest = STATUS_KEYS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
  return STATUS_MAP[nearest];
}
function waNumber(raw) {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/wa\.me\/(\+?\d+)/i);
  return m ? m[1] : /^\+?\d{6,}$/.test(s) ? s : null;
}
function parseDate(raw) {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return isNaN(dt.getTime()) ? null : dt;
}

async function loadCsv() {
  if (args.file) return readFileSync(args.file, 'utf8');
  if (args.url) {
    const res = await fetch(args.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    return res.text();
  }
  throw new Error('Provide --file=<path> or --url=<published csv url>');
}

function mapRow(row) {
  const fullName = clean(row['isim soyisim']);
  if (!fullName) return null; // skip nameless rows
  const realEmail = clean(row['Email']);
  const email = realEmail || `imported.${slug(fullName)}@import.local`;
  return {
    fullName,
    email,
    syntheticEmail: !realEmail,
    pipelineStatus: mapStatus(row['Status']),
    whatsapp: waNumber(row['whatsapp']),
    phone: clean(row['Telefon']) || waNumber(row['whatsapp']),
    city: clean(row['Sehir']),
    department: clean(row['Brans / IT alani egitiminiz']),
    referralSource: clean(row['Referans']),
    birthDate: parseDate(row['dtarihi']),
    cvUrl: (() => {
      const u = clean(row['cv']);
      return u && /^https?:\/\//.test(u) ? u : null;
    })(),
    project: clean(row['proje']),
  };
}

function report(rows, mapped) {
  const byStatus = {};
  let synthetic = 0;
  for (const r of mapped) {
    byStatus[r.pipelineStatus] = (byStatus[r.pipelineStatus] || 0) + 1;
    if (r.syntheticEmail) synthetic++;
  }
  console.log(`\n=== Import ${APPLY ? '(APPLY)' : '(DRY-RUN — no writes)'} ===`);
  console.log(`CSV rows: ${rows.length}`);
  console.log(`Mapped (named) records: ${mapped.length}  | skipped nameless: ${rows.length - mapped.length}`);
  console.log(`Real emails: ${mapped.length - synthetic}  | synthetic placeholder emails: ${synthetic}`);
  console.log('Note: "firma hesap bilgileri" column is excluded (may contain credentials).');
  console.log('\nPipeline status distribution:');
  for (const k of Object.keys(byStatus).sort()) console.log(`  ${k}: ${byStatus[k]}`);
  console.log('\nSample (first 5):');
  for (const r of mapped.slice(0, 5))
    console.log(`  - ${r.fullName} [${r.pipelineStatus}] city=${r.city ?? '-'} wa=${r.whatsapp ?? '-'} ref=${r.referralSource ?? '-'}`);
}

async function apply(mapped) {
  if (!args.owner) throw new Error('--apply requires --owner=<mentor/admin email>');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const owner = await prisma.user.findUnique({ where: { email: String(args.owner) } });
    if (!owner) throw new Error(`Owner not found: ${args.owner}`);
    if (!['ADMIN', 'MENTOR'].includes(owner.role))
      throw new Error(`Owner must be ADMIN or MENTOR (is ${owner.role})`);

    // Find-or-create companies for the CSV "proje" column (cached).
    const companyCache = new Map();
    const companyId = async (name) => {
      if (!name) return undefined;
      if (companyCache.has(name)) return companyCache.get(name);
      const found = (await prisma.company.findFirst({ where: { name } })) ?? (await prisma.company.create({ data: { name } }));
      companyCache.set(name, found.id);
      return found.id;
    };

    let created = 0,
      updated = 0,
      relCreated = 0;
    // Rows refused because the mentee already has an ACTIVE mentor elsewhere.
    const skippedActiveMentor = [];
    for (const r of mapped) {
      const relCompanyId = await companyId(r.project);
      const data = {
        fullName: r.fullName,
        role: 'MENTEE',
        phone: r.phone,
        whatsapp: r.whatsapp,
        city: r.city,
        department: r.department,
        referralSource: r.referralSource,
        birthDate: r.birthDate,
        cvUrl: r.cvUrl,
      };
      const existing = await prisma.user.findUnique({ where: { email: r.email } });
      const user = existing
        ? ((updated++), await prisma.user.update({ where: { email: r.email }, data }))
        : ((created++),
          await prisma.user.create({
            data: { ...data, email: r.email, password: '!imported-no-login' },
          }));
      // One mentee, at most one ACTIVE mentor (#419). The idempotency lookup
      // below stays scoped to --owner on purpose: widening it would let an
      // import as a different owner silently STEAL an existing relation, which
      // is worse than what it used to do. So the invariant is asserted
      // separately, before the create branch.
      //
      // Duplicated from src/lib/activeMentorship.ts — which is the source of
      // truth — because tsconfig excludes scripts/ and a .mjs file cannot
      // import a @/lib TS module. Same compromise every prisma/backfill-*.mjs
      // already lives with.
      const activeElsewhere = await prisma.mentorshipRelation.findFirst({
        where: { menteeId: user.id, status: 'ACTIVE', mentorId: { not: owner.id } },
        orderBy: { startDate: 'asc' },
        select: { id: true, mentorId: true },
      });
      if (activeElsewhere) {
        skippedActiveMentor.push({ email: r.email, mentorId: activeElsewhere.mentorId });
        continue;
      }
      const rel = await prisma.mentorshipRelation.findFirst({
        where: { mentorId: owner.id, menteeId: user.id },
      });
      if (rel) {
        await prisma.mentorshipRelation.update({
          where: { id: rel.id },
          data: { pipelineStatus: r.pipelineStatus, ...(relCompanyId ? { companyId: relCompanyId } : {}) },
        });
      } else {
        await prisma.mentorshipRelation.create({
          data: {
            mentorId: owner.id,
            menteeId: user.id,
            orgId: owner.orgId,
            pipelineStatus: r.pipelineStatus,
            ...(relCompanyId ? { companyId: relCompanyId } : {}),
          },
        });
        relCreated++;
      }
    }
    console.log(`\nApplied: users created=${created} updated=${updated}; relations created=${relCreated}`);
    if (skippedActiveMentor.length > 0) {
      console.log(`\nSKIPPED — already has an active mentor (${skippedActiveMentor.length}):`);
      for (const s of skippedActiveMentor) console.log(`  ${s.email} (active mentor ${s.mentorId})`);
      // A partially applied import must not exit 0: this is a manual --apply
      // run by a human who needs to see that some rows did not land.
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

const csv = await loadCsv();
const rows = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
const mapped = rows.map(mapRow).filter(Boolean);
report(rows, mapped);
if (APPLY) await apply(mapped);
else console.log('\n(Dry-run only. Re-run with --owner=<email> --apply to write.)');
