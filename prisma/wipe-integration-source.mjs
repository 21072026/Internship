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
//     (trial reminders, an imported value row, …);
//   • its lead stand-ins: a MENTEE with the no-login sentinel password on the
//     `import.local` stand-in domain, created no earlier than the account, and
//     with no funnel record outside this account;
//   • its ActivityLog rows (target = the account, one of its records or one of
//     its stand-ins, in every targetType spelling in use);
//   • this source's IntegrationEvent rows for it;
//   • the Company row itself (cascading its machine-written contact
//     permission and channels).
//
// AN ACCOUNT WITH HUMAN WORK ON IT IS KEPT, WITH THE REASON
//   A rollback never deletes what a person did, so the test is open-ended
//   rather than a list of known tables:
//   • a row in ANY table with a foreign key to one of its records or to the
//     account, except the few tables only machines write (MACHINE_TABLES,
//     each with its reason) — a table added later counts as a person's work
//     until someone argues otherwise there;
//   • any activity entry a person is the actor of, about the account, its
//     records or its stand-ins (a win-back, a trial or contract-end change, an
//     account edit, a channel added…). Reading an account (`*.view`) is not work;
//   • a stage move a person made (StatusChange.changedById);
//   • a deal value a person typed (RelationValue.source other than IMPORT);
//   • a channel changed after the account was created;
//   • contact-permission evidence (UWG § 7): a basis other than NONE, a
//     confirmation, an admin grant or a withdrawal — the owner's withdrawal
//     locks the row against every later write, and a re-created account would
//     start from NONE without it;
//   • another user attached to the account;
//   • a lead that is not one of this account's own stand-ins (a person, or a
//     record the source re-pointed): deleting the record would leave that
//     lead's overwritten fields and lost company link behind.
//   The verdict is read again inside each account's transaction, so work
//   added while a long run is going keeps that account.
//
// AND OUTSIDE THE ACCOUNTS
//   • this source's IntegrationEvent rows that name no account (recorded,
//     stale, unknown_account, …);
//   • its `integration.*` activity entries about an external id that no
//     surviving account carries.
//   What stays as evidence: every event and activity entry of an account that
//   is KEPT or that the source only MOVED (it did not create it). Those
//   accounts are left exactly as they are, so their events stay with them — a
//   replay therefore skips those event ids as duplicates rather than moving
//   the accounts a second time. The dry run lists the moved accounts and the
//   records the source opened on accounts it is not removing
//   (`integration.new_journey`), so an operator can look at each.
//   The IntegrationSource row, the lead Source rows and the org's settings are
//   never touched.
//
// Node 20 on the server cannot import TypeScript, so the few constants this
// needs are mirrored: NO_LOGIN_PASSWORD and PLACEHOLDER_EMAIL_DOMAIN
// (src/lib/menteeAccount.ts) and the slug rule (normalizeSourceSlug, through
// prisma/register-integration-source.mjs). scripts/test/marketing-ops-clis.test.mjs
// compares them with the TS source — change both in one commit.
import { PrismaClient, Prisma } from '@prisma/client';
import { normalizeSourceSlug } from './register-integration-source.mjs';

/** MIRROR of NO_LOGIN_PASSWORD (src/lib/menteeAccount.ts): the sentinel a lead stand-in carries. */
export const LEAD_NO_LOGIN_PASSWORD = '!created-no-login';
/** MIRROR of PLACEHOLDER_EMAIL_DOMAIN (src/lib/menteeAccount.ts): the stand-in address domain. */
export const STAND_IN_EMAIL_DOMAIN = 'import.local';
/** Clock slack between the account insert and its lead's (same transaction, client-side timestamps). */
export const SAME_INSERT_SLACK_MS = 5_000;

/**
 * The tables with a foreign key to a funnel record or an account that only a
 * machine writes (or that this tool inspects on its own terms). A row in ANY
 * OTHER such table is a person's work and keeps the account — so a table added
 * later is protected until someone adds it here, with its reason.
 * Keyed by Prisma model name; scripts/test/marketing-ops-clis.test.mjs fails
 * on an entry the schema no longer has.
 */
export const MACHINE_TABLES = {
  MentorshipRelation: 'the records themselves (and the win-back/transfer chain between them)',
  StatusChange: "inspected on its own: only a move with changedById is a person's",
  RelationValue: "inspected on its own: only a value whose source is not IMPORT is a person's",
  TrialReminder: 'the trial reminder job',
  RelationHealthSnapshot: 'the nightly health snapshot',
  EvaluationDue: 'the evaluation schedule job (an evaluation itself is Evaluation)',
  WeeklyReportReminder: 'the weekly report reminder job',
  User: 'inspected on its own: stand-ins go with the account, any other user keeps it',
  ContactPermission: "inspected on its own: a NONE row with no evidence is the writer's",
  CompanyChannel: "inspected on its own: a channel changed after the account insert is a person's",
  CompanyUsage: 'the product usage sync',
  ExternalProfileLink: 'the pull connector\'s profile link (src/lib/klaviyoSync.ts), cascades with the account',
};

/** Spellings of an activity entry's target in use for an account / a record / a user. */
export const COMPANY_TARGET_TYPES = ['Company', 'company'];
export const RELATION_TARGET_TYPES = ['MentorshipRelation', 'relation'];
export const USER_TARGET_TYPES = ['User', 'user'];

const lowerFirst = (name) => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Every (table, foreign key) that points at a funnel record or an account and
 * is not a MACHINE_TABLES entry — the tables whose rows are a person's work.
 * Pure over the Prisma datamodel (`Prisma.dmmf.datamodel`).
 *
 * Returns { onRecord: [{ model, accessor, fk }], onAccount: [{ model, accessor, fk }] }.
 */
export function humanWorkTables(datamodel) {
  const out = { onRecord: [], onAccount: [] };
  for (const m of datamodel.models) {
    if (MACHINE_TABLES[m.name]) continue;
    for (const f of m.fields) {
      if (f.kind !== 'object' || !f.relationFromFields?.length) continue;
      const bucket = f.type === 'MentorshipRelation' ? out.onRecord : f.type === 'Company' ? out.onAccount : null;
      if (bucket) bucket.push({ model: m.name, accessor: lowerFirst(m.name), fk: f.relationFromFields[0] });
    }
  }
  return out;
}

/** Contact-permission rows that are evidence (UWG § 7), not the machine's NONE row. */
export const permissionEvidenceWhere = (companyId) => ({
  companyId,
  OR: [{ basis: { not: 'NONE' } }, { confirmedAt: { not: null } }, { grantedById: { not: null } }, { revokedAt: { not: null } }],
});

function activityTargets(companyId, relationIds, userIds) {
  return [
    { targetType: { in: COMPANY_TARGET_TYPES }, targetId: companyId },
    ...(relationIds.length ? [{ targetType: { in: RELATION_TARGET_TYPES }, targetId: { in: relationIds } }] : []),
    ...(userIds.length ? [{ targetType: { in: USER_TARGET_TYPES }, targetId: { in: userIds } }] : []),
  ];
}

/** An activity entry a person is the actor of, about the account, a record or a stand-in — and more than a read. */
export function personActivityWhere(companyId, relationIds, standInIds) {
  return {
    actorId: { not: null },
    NOT: { action: { endsWith: '.view' } },
    OR: activityTargets(companyId, relationIds, standInIds),
  };
}

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
 * Which leads on an account are its own stand-ins (created with it, password-
 * less, on the stand-in domain, with no record anywhere else) and which are
 * not. Pure. Returns { leadIds, keptLeadIds }.
 */
export function splitLeads({ account, relations, leads, orgId }) {
  const onAccount = new Set(relations.map((r) => r.id));
  const accountAt = new Date(account.createdAt).getTime();
  const leadIds = [];
  const keptLeadIds = [];
  for (const lead of leads) {
    const createdWithAccount = new Date(lead.createdAt).getTime() >= accountAt - SAME_INSERT_SLACK_MS;
    const onlyHere = lead.relationIds.every((id) => onAccount.has(id));
    if (isLeadStandIn(lead, orgId) && createdWithAccount && onlyHere) leadIds.push(lead.id);
    else keptLeadIds.push(lead.id);
  }
  return { leadIds, keptLeadIds };
}

/**
 * The verdict on ONE account the source created. Pure: the caller supplies
 * what the database holds.
 *
 *   account     { id, createdAt }
 *   relations   [{ id, menteeId, startDate }]  — every record on the account
 *   leads       [{ id, orgId, role, password, email, createdAt, relationIds: [ids of ALL its records] }]
 *   humanWork   { [label]: count }               — rows of a person's work (humanWorkTables,
 *                                                  person activity, manual values, …)
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
  const accountAt = new Date(account.createdAt).getTime();
  const { leadIds, keptLeadIds } = splitLeads({ account, relations, leads, orgId });
  const deletable = new Set(leadIds);
  // A record of a lead that existed before the account, started before it: the
  // feed attached the account to an existing record instead of creating one.
  const repointed = relations.filter(
    (r) => !deletable.has(r.menteeId) && new Date(r.startDate).getTime() < accountAt - SAME_INSERT_SLACK_MS,
  );
  if (repointed.length) reasons.push(`records that predate the account: ${repointed.length}`);
  // Any other lead is a person (or a record) that existed before: the writer
  // re-pointed its company link and may have overwritten its name and phone,
  // and deleting the record it was given would not undo either. Keep.
  if (keptLeadIds.length) reasons.push(`leads that are not this account's own stand-ins: ${keptLeadIds.length}`);

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

/** The activity actions the account-event writer records under "<slug>: …". */
export const SOURCE_ACTIONS = ['integration.event', 'integration.backward_refused', 'integration.new_journey'];

/** `field` is NULL or not one of `values` (a bare notIn drops the NULL rows in SQL). */
const nullOrNotIn = (field, values) => (values.length ? { OR: [{ [field]: null }, { [field]: { notIn: values } }] } : {});

/**
 * The activity entries an event of `slug` wrote about an external id rather
 * than a row (detail starts with "<slug>: ", so "feed" never matches
 * "feed-2"). An entry about a record goes with its account (activityWhereFor)
 * or stays with it; `keepExternalIds` — the external ids of the accounts that
 * survive (kept, or moved but not created) — leaves their entries in place as
 * evidence.
 */
export const sourceActivityWhere = (orgId, slug, keepExternalIds = []) => ({
  orgId,
  action: { in: SOURCE_ACTIONS },
  detail: { startsWith: `${slug}: ` },
  targetType: 'company_external_id',
  ...nullOrNotIn('targetId', keepExternalIds),
});

/**
 * The source's events that name no account. An event of a wiped account goes
 * with it; an event of a surviving account — kept, or moved but not created —
 * stays as the evidence of what the source did to it, including one recorded
 * before it was matched (same external id).
 */
export const sourceEventsWhere = (orgId, slug, keepExternalIds = []) => ({
  orgId,
  provider: slug,
  companyId: null,
  ...nullOrNotIn('externalId', keepExternalIds),
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
  const { leadIds: standInIds } = splitLeads({ account: company, relations, leads, orgId });

  const humanWork = {};
  const tables = humanWorkTables(Prisma.dmmf.datamodel);
  for (const { accessor, fk } of tables.onRecord) {
    if (!relationIds.length) continue;
    const n = await db[accessor].count({ where: { [fk]: { in: relationIds } } });
    if (n) humanWork[accessor] = (humanWork[accessor] ?? 0) + n;
  }
  for (const { accessor, fk } of tables.onAccount) {
    const n = await db[accessor].count({ where: { [fk]: company.id } });
    if (n) humanWork[accessor] = (humanWork[accessor] ?? 0) + n;
  }
  humanWork.activityByPerson = await db.activityLog.count({ where: personActivityWhere(company.id, relationIds, standInIds) });
  humanWork.statusChangeByPerson = relationIds.length
    ? await db.statusChange.count({ where: { relationId: { in: relationIds }, changedById: { not: null } } })
    : 0;
  humanWork.relationValueByPerson = relationIds.length
    ? await db.relationValue.count({ where: { relationId: { in: relationIds }, source: { not: 'IMPORT' } } })
    : 0;
  humanWork.contactPermissionEvidence = await db.contactPermission.count({ where: permissionEvidenceWhere(company.id) });
  humanWork.companyChannelChanged = await db.companyChannel.count({
    where: { companyId: company.id, updatedAt: { gt: new Date(new Date(company.createdAt).getTime() + SAME_INSERT_SLACK_MS) } },
  });
  humanWork.otherUsers = await db.user.count({ where: { companyId: company.id, id: { notIn: menteeIds } } });

  const activityWhere = activityWhereFor(orgId, company.id, relationIds, standInIds);
  const counts = {
    statusChanges: relationIds.length ? await db.statusChange.count({ where: { relationId: { in: relationIds } } }) : 0,
    contactPermissions: await db.contactPermission.count({ where: { companyId: company.id } }),
    companyChannels: await db.companyChannel.count({ where: { companyId: company.id } }),
    activityLogs: await db.activityLog.count({ where: activityWhere }),
    integrationEvents: await db.integrationEvent.count({ where: { orgId, provider: slug, companyId: company.id } }),
  };
  return { company, ...classifyAccount({ account: company, relations, leads, humanWork, counts, orgId }) };
}

// The account's own entries (the account, its records, its stand-ins, every
// targetType spelling). The target ids are this org's own rows, so an entry
// naming one is about it; an entry written without a bound tenant (orgId NULL)
// is included for that reason, another org's never is. Only reached for an
// account with no person's entry among them (activityByPerson is 0).
function activityWhereFor(orgId, companyId, relationIds, standInIds) {
  return {
    AND: [{ OR: [{ orgId }, { orgId: null }] }, { OR: activityTargets(companyId, relationIds, standInIds) }],
  };
}

async function externalIdsOf(db, orgId, companyIds) {
  if (!companyIds.length) return [];
  const rows = await db.company.findMany({ where: { orgId, id: { in: companyIds }, externalId: { not: null } }, select: { externalId: true } });
  return rows.map((r) => r.externalId);
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
  const keepExternalIds = await externalIdsOf(db, org.id, [...keptIds, ...touchedNotCreated]);

  // Records the source opened (a new journey) that this run does not remove:
  // on an account it only moved, or on a kept one. The activity entry is their
  // only link to the source, and it stays.
  const wipedRelationIds = new Set(accounts.filter((a) => a.action === 'wipe').flatMap((a) => a.relationIds));
  const journeys = await db.activityLog.findMany({
    where: { orgId: org.id, action: 'integration.new_journey', detail: { startsWith: `${slug}: ` }, targetType: 'MentorshipRelation' },
    select: { targetId: true },
  });
  const journeysNotWiped = [...new Set(journeys.map((j) => j.targetId).filter((id) => id && !wipedRelationIds.has(id)))];

  const sourceWide = {
    integrationEvents: await db.integrationEvent.count({ where: sourceEventsWhere(org.id, slug, keepExternalIds) }),
    activityLogs: await db.activityLog.count({ where: sourceActivityWhere(org.id, slug, keepExternalIds) }),
  };
  const totals = totalCounts(accounts, sourceWide);
  return { source, accounts, keptIds, createdIds: [...createdIds], touchedNotCreated, journeysNotWiped, sourceWide, totals };
}

class AccountChangedError extends Error {}

async function wipeAccount(prisma, orgId, slug, planned) {
  const { company } = planned;
  return prisma.$transaction(async (tx) => {
    // The verdict again, inside the transaction: work a person added since the
    // plan was read keeps the account, and the rows deleted are the rows that
    // are there now.
    const verdict = await inspectAccount(tx, orgId, slug, company);
    if (verdict.action !== 'wipe') {
      throw new AccountChangedError(`account ${company.id} changed since it was read and is now kept: ${verdict.reasons.join(', ')}`);
    }
    const { relationIds, leadIds } = verdict;
    const n = {};
    n.activityLogs = (await tx.activityLog.deleteMany({ where: activityWhereFor(orgId, company.id, relationIds, leadIds) })).count;
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
  }, { timeout: 60_000 });
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
  if (plan.journeysNotWiped.length) {
    console.log(`  records the source opened on accounts that stay (left as they are): ${plan.journeysNotWiped.length}`);
    for (const id of plan.journeysNotWiped.slice(0, 20)) console.log(`    ${id}`);
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
    // Source-wide rows last, against what is left: an account whose wipe
    // failed (or that turned out to be worked on) survives like a kept one,
    // and so do its events and entries.
    const failedIds = failed.map((f) => f.companyId);
    const keepExternalIds = await externalIdsOf(prisma, org.id, [...plan.keptIds, ...plan.touchedNotCreated, ...failedIds]);
    const ev = await prisma.integrationEvent.deleteMany({ where: sourceEventsWhere(org.id, slug, keepExternalIds) });
    const al = await prisma.activityLog.deleteMany({ where: sourceActivityWhere(org.id, slug, keepExternalIds) });
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
    journeysNotWiped: plan.journeysNotWiped,
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
