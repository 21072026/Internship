// Operator CLI — the ROLLBACK of one integration source in one organization
// (#2959, docs/integrations/account-events.md § Rolling a source back).
//
//   node prisma/wipe-integration-source.mjs --org <slug|id> --source <slug>            # dry run: counts per table
//   node prisma/wipe-integration-source.mjs --org <slug|id> --source <slug> --apply    # deletes
//   … --json                                                                          # the plan / result as JSON
//
// WHAT "CREATED BY THE SOURCE" MEANS
//   Exactly the accounts whose `Company.createdBySource` is this slug — stamped
//   by the account-event writer in the same insert that creates the account
//   (src/lib/accountEventIngest.ts → createMarketingAccount). A person's
//   account, a demo-form conversion and a file import leave it NULL and are out
//   of reach by construction; so is anything of another organization (every
//   query is scoped by orgId). `IntegrationEvent.companyId` is NOT used for
//   this: an event that merely matched and moved an existing account carries
//   it too. Accounts created before the marker existed are not found — they are
//   listed as "touched, not created" instead.
//
// WHAT ONE ACCOUNT TAKES WITH IT (one transaction per account)
//   • its funnel records (MentorshipRelation where companyId = the account) and
//     their StatusChange rows — the cascades take what hangs off a record
//     (trial reminders, a value row, …);
//   • its lead stand-ins: a MENTEE with the no-login sentinel password on the
//     `import.local` stand-in domain, created no earlier than the account, and
//     with no funnel record outside this account. Any other lead is a person
//     that existed before and is kept;
//   • its ActivityLog rows (target = the account or one of its records);
//   • this source's IntegrationEvent rows for it;
//   • the Company row itself (cascading its contact permission and channels).
//   An account with HUMAN WORK on it is not wiped but listed with the reason:
//   a stage move a person made, an interaction, a note, a message, a meeting,
//   an offer, a goal, a placement, a contact person, a postal campaign, an
//   inquiry converted into it, another user attached to it, or a record whose
//   lead existed before the account and whose start predates it (a record the
//   feed re-pointed rather than created). A rollback never deletes what a person did.
//
// AND OUTSIDE THE ACCOUNTS
//   • every other IntegrationEvent row of this source in this org (recorded,
//     stale, unknown_account, …, and the events that moved accounts the source
//     did not create) — except the events of a KEPT account, which stay as the
//     evidence for a later run;
//   • the source's own `integration.event` and `integration.backward_refused`
//     activity entries (their detail starts with "<slug>: ").
//   Accounts the source only MOVED are left exactly as they are (their stage,
//   their history); the dry run lists them so an operator can look.
//   The IntegrationSource row, the lead Source rows and the org's settings are
//   never touched.
//
// Node 20 on the server cannot import TypeScript, so the few constants this
// needs are mirrored: NO_LOGIN_PASSWORD and PLACEHOLDER_EMAIL_DOMAIN
// (src/lib/menteeAccount.ts) and the slug rule (normalizeSourceSlug, through
// prisma/register-integration-source.mjs). scripts/test/marketing-ops-clis.test.mjs
// compares them with the TS source — change both in one commit.
import { PrismaClient } from '@prisma/client';
import { normalizeSourceSlug } from './register-integration-source.mjs';

/** MIRROR of NO_LOGIN_PASSWORD (src/lib/menteeAccount.ts): the sentinel a lead stand-in carries. */
export const LEAD_NO_LOGIN_PASSWORD = '!created-no-login';
/** MIRROR of PLACEHOLDER_EMAIL_DOMAIN (src/lib/menteeAccount.ts): the stand-in address domain. */
export const STAND_IN_EMAIL_DOMAIN = 'import.local';
/** Clock slack between the account insert and its lead's (same transaction, client-side timestamps). */
export const SAME_INSERT_SLACK_MS = 5_000;

/**
 * The relation-level tables whose rows are a person's work. A row in any of
 * them keeps the account. Keys are Prisma model accessors; each has `relationId`.
 */
export const HUMAN_WORK_ON_RECORD = [
  'interactionLog',
  'relationNote',
  'sessionNote',
  'message',
  'meeting',
  'offer',
  'goal',
  'placement',
];

/** Company-level human work: Prisma accessor → its company foreign key. */
export const HUMAN_WORK_ON_ACCOUNT = {
  companyContact: 'companyId',
  postCampaignRecipient: 'companyId',
  companyInquiry: 'convertedCompanyId',
};

/** Is this user a stand-in lead record (never a login)? Pure. */
export function isLeadStandIn(user, orgId) {
  return (
    user.orgId === orgId &&
    user.role === 'MENTEE' &&
    user.password === LEAD_NO_LOGIN_PASSWORD &&
    typeof user.email === 'string' &&
    user.email.toLowerCase().endsWith(`@${STAND_IN_EMAIL_DOMAIN}`)
  );
}

/**
 * The verdict on ONE account the source created. Pure: the caller supplies
 * what the database holds.
 *
 *   account     { id, createdAt }
 *   relations   [{ id, menteeId, startDate }]  — every record on the account
 *   leads       [{ id, orgId, role, password, email, createdAt, relationIds: [ids of ALL its records] }]
 *   humanWork   { [table]: count }               — HUMAN_WORK_ON_RECORD/ACCOUNT counts,
 *                                                  plus `statusChangeByPerson` and `otherUsers`
 *   counts      { statusChanges, activityLogs, integrationEvents }
 *   orgId
 *
 * Returns { action: 'wipe' | 'keep', reasons: string[], relationIds, leadIds, keptLeadIds, counts }.
 */
export function classifyAccount({ account, relations, leads, humanWork, counts, orgId }) {
  const reasons = Object.entries(humanWork)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table}: ${n}`);
  const relationIds = relations.map((r) => r.id);
  const onAccount = new Set(relationIds);
  const accountAt = new Date(account.createdAt).getTime();

  const leadIds = [];
  const keptLeadIds = [];
  const deletable = new Set();
  for (const lead of leads) {
    const createdWithAccount = new Date(lead.createdAt).getTime() >= accountAt - SAME_INSERT_SLACK_MS;
    const onlyHere = lead.relationIds.every((id) => onAccount.has(id));
    if (isLeadStandIn(lead, orgId) && createdWithAccount && onlyHere) {
      leadIds.push(lead.id);
      deletable.add(lead.id);
    } else {
      keptLeadIds.push(lead.id);
    }
  }
  // A record of a lead that existed before the account, started before it: the
  // feed attached the account to an existing record instead of creating one.
  const repointed = relations.filter(
    (r) => !deletable.has(r.menteeId) && new Date(r.startDate).getTime() < accountAt - SAME_INSERT_SLACK_MS,
  );
  if (repointed.length) reasons.push(`records that predate the account: ${repointed.length}`);

  return {
    action: reasons.length ? 'keep' : 'wipe',
    reasons,
    relationIds,
    leadIds,
    keptLeadIds,
    counts: {
      companies: 1,
      relations: relationIds.length,
      statusChanges: counts.statusChanges,
      leadUsers: leadIds.length,
      contactPermissions: counts.contactPermissions ?? 0,
      companyChannels: counts.companyChannels ?? 0,
      activityLogs: counts.activityLogs,
      integrationEvents: counts.integrationEvents,
    },
  };
}

export const COUNT_TABLES = [
  'companies',
  'relations',
  'statusChanges',
  'leadUsers',
  'contactPermissions',
  'companyChannels',
  'activityLogs',
  'integrationEvents',
];

/** Sums the per-account counts of the accounts that are wiped, plus the source-wide rows. */
export function totalCounts(verdicts, sourceWide) {
  const total = Object.fromEntries(COUNT_TABLES.map((t) => [t, 0]));
  for (const v of verdicts) {
    if (v.action !== 'wipe') continue;
    for (const t of COUNT_TABLES) total[t] += v.counts[t] ?? 0;
  }
  total.activityLogs += sourceWide.activityLogs;
  total.integrationEvents += sourceWide.integrationEvents;
  return total;
}

/**
 * The activity entries an event of `slug` wrote outside any account: detail
 * starts with "<slug>: ". `exceptRelationIds` leaves out the entries that
 * target a record already counted with its account (a refused backward move on
 * a record that is wiped), so the dry run never counts one row twice. Both
 * actions always carry a targetType, so the `not` below never meets a NULL.
 */
export const sourceActivityWhere = (orgId, slug, exceptRelationIds = []) => ({
  orgId,
  action: { in: ['integration.event', 'integration.backward_refused'] },
  detail: { startsWith: `${slug}: ` },
  ...(exceptRelationIds.length
    ? { OR: [{ targetType: { not: 'MentorshipRelation' } }, { targetId: { notIn: exceptRelationIds } }] }
    : {}),
});

// ── Database ─────────────────────────────────────────────────────────────────

async function inspectAccount(db, orgId, slug, company) {
  const relations = await db.mentorshipRelation.findMany({
    where: { orgId, companyId: company.id },
    select: { id: true, menteeId: true, startDate: true },
  });
  const relationIds = relations.map((r) => r.id);
  const menteeIds = [...new Set(relations.map((r) => r.menteeId))];
  const leadsRaw = menteeIds.length
    ? await db.user.findMany({
        where: { id: { in: menteeIds } },
        select: { id: true, orgId: true, role: true, password: true, email: true, createdAt: true, menteeRelations: { select: { id: true } } },
      })
    : [];
  const leads = leadsRaw.map(({ menteeRelations, ...u }) => ({ ...u, relationIds: menteeRelations.map((r) => r.id) }));

  const humanWork = {};
  for (const table of HUMAN_WORK_ON_RECORD) {
    humanWork[table] = relationIds.length ? await db[table].count({ where: { relationId: { in: relationIds } } }) : 0;
  }
  for (const [table, fk] of Object.entries(HUMAN_WORK_ON_ACCOUNT)) {
    humanWork[table] = await db[table].count({ where: { [fk]: company.id } });
  }
  humanWork.statusChangeByPerson = relationIds.length
    ? await db.statusChange.count({ where: { relationId: { in: relationIds }, changedById: { not: null } } })
    : 0;
  humanWork.otherUsers = await db.user.count({ where: { companyId: company.id, id: { notIn: menteeIds } } });

  const activityWhere = activityWhereFor(orgId, company.id, relationIds);
  const counts = {
    statusChanges: relationIds.length ? await db.statusChange.count({ where: { relationId: { in: relationIds } } }) : 0,
    contactPermissions: await db.contactPermission.count({ where: { companyId: company.id } }),
    companyChannels: await db.companyChannel.count({ where: { companyId: company.id } }),
    activityLogs: await db.activityLog.count({ where: activityWhere }),
    integrationEvents: await db.integrationEvent.count({ where: { orgId, provider: slug, companyId: company.id } }),
  };
  return { company, ...classifyAccount({ account: company, relations, leads, humanWork, counts, orgId }) };
}

// The account's own entries. The target ids are this org's own rows, so an
// entry naming one is about it; an entry written without a bound tenant
// (orgId NULL) is included for that reason, another org's never is.
function activityWhereFor(orgId, companyId, relationIds) {
  return {
    AND: [
      { OR: [{ orgId }, { orgId: null }] },
      {
        OR: [
          { targetType: 'Company', targetId: companyId },
          ...(relationIds.length ? [{ targetType: 'MentorshipRelation', targetId: { in: relationIds } }] : []),
        ],
      },
    ],
  };
}

async function buildPlan(db, org, slug) {
  const source = await db.integrationSource.findFirst({ where: { orgId: org.id, slug }, select: { slug: true, enabled: true } });
  const companies = await db.company.findMany({
    where: { orgId: org.id, createdBySource: slug },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const accounts = [];
  for (const company of companies) accounts.push(await inspectAccount(db, org.id, slug, company));
  const keptIds = accounts.filter((a) => a.action === 'keep').map((a) => a.company.id);
  const createdIds = new Set(companies.map((c) => c.id));

  // Accounts this source moved but did not create: listed, never touched.
  const touchedRows = await db.integrationEvent.findMany({
    where: { orgId: org.id, provider: slug, companyId: { not: null } },
    select: { companyId: true },
    distinct: ['companyId'],
  });
  const touchedNotCreated = touchedRows.map((r) => r.companyId).filter((id) => !createdIds.has(id));

  const sourceWide = {
    integrationEvents: await db.integrationEvent.count({ where: sourceEventsWhere(org.id, slug, [...createdIds]) }),
    activityLogs: await db.activityLog.count({
      where: sourceActivityWhere(org.id, slug, accounts.filter((a) => a.action === 'wipe').flatMap((a) => a.relationIds)),
    }),
  };
  const totals = totalCounts(accounts, sourceWide);
  return { source, accounts, keptIds, createdIds: [...createdIds], touchedNotCreated, sourceWide, totals };
}

// The source's events not tied to an account handled per account: no account,
// or an account the source did not create. A created account's events go with
// the account, and a KEPT account's events stay.
function sourceEventsWhere(orgId, slug, createdIds) {
  return {
    orgId,
    provider: slug,
    OR: [{ companyId: null }, ...(createdIds.length ? [{ companyId: { notIn: createdIds } }] : [{ companyId: { not: null } }])],
  };
}

async function wipeAccount(prisma, orgId, slug, verdict) {
  const { company, relationIds, leadIds } = verdict;
  return prisma.$transaction(async (tx) => {
    const n = {};
    n.activityLogs = (await tx.activityLog.deleteMany({ where: activityWhereFor(orgId, company.id, relationIds) })).count;
    n.statusChanges = relationIds.length
      ? (await tx.statusChange.deleteMany({ where: { relationId: { in: relationIds } } })).count
      : 0;
    n.relations = relationIds.length
      ? (await tx.mentorshipRelation.deleteMany({ where: { orgId, id: { in: relationIds } } })).count
      : 0;
    // The stand-in guard is repeated in the WHERE: a row that stopped being a
    // stand-in since the plan was read is simply not deleted.
    n.leadUsers = leadIds.length
      ? (
          await tx.user.deleteMany({
            where: { id: { in: leadIds }, orgId, role: 'MENTEE', password: LEAD_NO_LOGIN_PASSWORD, email: { endsWith: `@${STAND_IN_EMAIL_DOMAIN}` } },
          })
        ).count
      : 0;
    n.integrationEvents = (await tx.integrationEvent.deleteMany({ where: { orgId, provider: slug, companyId: company.id } })).count;
    n.contactPermissions = await tx.contactPermission.count({ where: { companyId: company.id } });
    n.companyChannels = await tx.companyChannel.count({ where: { companyId: company.id } });
    n.companies = (await tx.company.deleteMany({ where: { id: company.id, orgId, createdBySource: slug } })).count;
    if (n.companies !== 1) throw new Error(`account ${company.id} changed since it was read`);
    return n;
  });
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const USAGE = 'Usage: node prisma/wipe-integration-source.mjs --org <slug|id> --source <slug> [--apply] [--json]';

function printPlan(org, slug, plan, apply) {
  console.log(`${org.slug} (${org.id}) — rollback of source "${slug}", ${apply ? 'APPLY' : 'dry run'}`);
  if (!plan.source) console.log(`  note: no IntegrationSource "${slug}" is registered in this org (its rows are still found).`);
  console.log(`  accounts created by the source: ${plan.accounts.length} (wipe ${plan.accounts.length - plan.keptIds.length}, keep ${plan.keptIds.length})`);
  for (const a of plan.accounts.filter((x) => x.action === 'keep')) {
    console.log(`    KEPT ${a.company.id} "${a.company.name}": ${a.reasons.join(', ')}`);
  }
  if (plan.touchedNotCreated.length) {
    console.log(`  accounts the source moved but did not create (left as they are): ${plan.touchedNotCreated.length}`);
    for (const id of plan.touchedNotCreated.slice(0, 20)) console.log(`    ${id}`);
  }
  console.log('  rows per table:');
  for (const t of COUNT_TABLES) console.log(`    ${t.padEnd(20)} ${plan.totals[t]}`);
}

async function main() {
  const orgRef = (arg('org') ?? '').trim();
  const rawSlug = arg('source');
  if (!orgRef || !rawSlug) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const slug = normalizeSourceSlug(rawSlug);
  if (!slug) {
    console.error(`"${rawSlug}" is not a valid source slug.`);
    process.exitCode = 2;
    return;
  }
  const apply = has('apply');
  const json = has('json');
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findFirst({
      where: { OR: [{ id: orgRef }, { slug: orgRef }] },
      select: { id: true, slug: true },
    });
    if (!org) {
      console.error(`No organization with slug or id "${orgRef}".`);
      process.exitCode = 1;
      return;
    }
    const plan = await buildPlan(prisma, org, slug);
    if (!apply) {
      if (json) console.log(JSON.stringify({ org: org.slug, source: slug, apply, ...summary(plan) }));
      else {
        printPlan(org, slug, plan, apply);
        console.log('Dry run: nothing was written. Re-run with --apply.');
      }
      return;
    }

    const deleted = Object.fromEntries(COUNT_TABLES.map((t) => [t, 0]));
    const failed = [];
    for (const verdict of plan.accounts) {
      if (verdict.action !== 'wipe') continue;
      try {
        const n = await wipeAccount(prisma, org.id, slug, verdict);
        for (const t of COUNT_TABLES) deleted[t] += n[t] ?? 0;
      } catch (e) {
        failed.push({ companyId: verdict.company.id, error: String(e?.message ?? e).slice(0, 300) });
      }
    }
    // Source-wide rows last, recomputed against what is left: an account whose
    // wipe failed keeps its events (it is still created by the source).
    const createdLeft = (await prisma.company.findMany({ where: { orgId: org.id, createdBySource: slug }, select: { id: true } })).map((c) => c.id);
    const ev = await prisma.integrationEvent.deleteMany({ where: sourceEventsWhere(org.id, slug, createdLeft) });
    const al = await prisma.activityLog.deleteMany({ where: sourceActivityWhere(org.id, slug) });
    deleted.integrationEvents += ev.count;
    deleted.activityLogs += al.count;

    if (json) console.log(JSON.stringify({ org: org.slug, source: slug, apply, ...summary(plan), deleted, failed }));
    else {
      printPlan(org, slug, plan, apply);
      console.log('  deleted:');
      for (const t of COUNT_TABLES) console.log(`    ${t.padEnd(20)} ${deleted[t]}`);
      for (const f of failed) console.log(`  FAILED ${f.companyId}: ${f.error} (rolled back; nothing of it was deleted)`);
    }
    if (failed.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

function summary(plan) {
  return {
    registered: !!plan.source,
    accounts: plan.accounts.map((a) => ({ companyId: a.company.id, action: a.action, reasons: a.reasons, counts: a.counts, keptLeadIds: a.keptLeadIds })),
    touchedNotCreated: plan.touchedNotCreated,
    totals: plan.totals,
  };
}

// Import-safe: only runs as a CLI, so a test can import the pure rule.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
