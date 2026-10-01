// Remove the bell entries the pre-#2653 admin fan-outs wrote into the WRONG
// organization (#2647). Node 20 ESM, no TS imports.
//
// Until #2653 every "a new person signed up / asked for a mentor / applied"
// notification went to every ADMIN of every tenant, so a MARKETING (SaleVali)
// admin's bell still holds InternCRM names from before the fix. The fan-outs
// are scoped now; this sweeps up what they already wrote. Notification rows
// carry no subject id, so the rule reads the only subject they do carry — the
// person's name in `params` — and two narrow rules decide:
//
//   A. A fan-out row naming a person (`params.name` / `params.from`) is removed
//      when NO user of that name exists in the recipient's own org. A NULL org
//      is the default org's, on both sides, as everywhere (tenantFilter.ts).
//   B. An internship-only fan-out (mentor requests, mentor applications,
//      project join requests, testimonials, auto-link) delivered to an admin of
//      an org whose vertical is not INTERNSHIP is removed outright: nothing in
//      such an org can have produced it.
//
// Only the listed admin fan-out types are ever touched, only ADMIN recipients,
// and a sign-up notification about a person who really is in the recipient's
// org survives rule A. Dry run by default (prints counts); `--confirm` deletes.
// Idempotent: a second run finds nothing.
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Admin fan-outs that name the subject person. */
export const NAMED_FANOUT_TYPES = [
  'signup.new',
  'signup.pendingApproval',
  'duplicate.suspected',
  'mentorship.autoLinkSkipped',
  'mentorship_request.new',
  'mentorship_request.rematch',
  'mentor_application.new',
];

/** Fan-outs only an org with the mentorship module can produce. */
export const INTERNSHIP_ONLY_TYPES = [
  'mentorship.autoLinkSkipped',
  'mentorship_request.new',
  'mentorship_request.newGeneric',
  'mentorship_request.rematch',
  'mentorship_request.rematchGeneric',
  'mentor_application.new',
  'project.joinRequested',
  'testimonial.declined',
];

/** Pure mirror of the rule, for the unit test. */
export function shouldPurge({ type, recipientRole, recipientVertical, subjectName, subjectInRecipientOrg }) {
  if (recipientRole !== 'ADMIN') return false;
  if (INTERNSHIP_ONLY_TYPES.includes(type) && recipientVertical !== 'INTERNSHIP') return true;
  if (NAMED_FANOUT_TYPES.includes(type) && subjectName && !subjectInRecipientOrg) return true;
  return false;
}

const list = (xs) => xs.map((x) => `'${x}'`).join(', ');
const SUBJECT = "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(n.`params`, '$.name')), JSON_UNQUOTE(JSON_EXTRACT(n.`params`, '$.from')))";

/** The two statements; `?` placeholders are the default org id. */
export function purgeStatements() {
  const ruleA =
    'FROM `Notification` n JOIN `User` r ON r.`id` = n.`userId` ' +
    `WHERE r.\`role\` = 'ADMIN' AND n.\`type\` IN (${list(NAMED_FANOUT_TYPES)}) ` +
    `AND ${SUBJECT} IS NOT NULL ` +
    'AND NOT EXISTS (SELECT 1 FROM `User` s WHERE s.`fullName` = ' + SUBJECT +
    ' AND COALESCE(s.`orgId`, ?) = COALESCE(r.`orgId`, ?))';
  const ruleB =
    'FROM `Notification` n JOIN `User` r ON r.`id` = n.`userId` ' +
    'JOIN `Organization` o ON o.`id` = COALESCE(r.`orgId`, ?) ' +
    `WHERE r.\`role\` = 'ADMIN' AND o.\`vertical\` <> 'INTERNSHIP' AND n.\`type\` IN (${list(INTERNSHIP_ONLY_TYPES)})`;
  return [
    { label: 'internship-only fan-out in a non-internship org', from: ruleB, params: 1 },
    { label: 'names nobody in the recipient org', from: ruleA, params: 2 },
  ];
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({ where: { slug: 'default' }, select: { id: true } });
    if (!org) {
      console.log('purge-cross-tenant-notifications: no default org — nothing to do.');
      return;
    }
    let total = 0;
    for (const { label, from, params } of purgeStatements()) {
      const args = Array(params).fill(org.id);
      if (confirm) {
        const n = await prisma.$executeRawUnsafe(`DELETE n ${from}`, ...args);
        total += n;
        console.log(`purge-cross-tenant-notifications: ${n} row(s) removed — ${label}`);
      } else {
        const [row] = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c ${from}`, ...args);
        const n = Number(row?.c ?? 0);
        total += n;
        console.log(`purge-cross-tenant-notifications (dry run): ${n} row(s) would go — ${label}`);
      }
    }
    console.log(`purge-cross-tenant-notifications: ${total} row(s) ${confirm ? 'removed' : 'matched (dry run; pass --confirm)'}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('purge-cross-tenant-notifications failed:', error);
    process.exit(1);
  });
}
