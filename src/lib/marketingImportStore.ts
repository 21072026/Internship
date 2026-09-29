// The Prisma side of the marketing account import (#2406).
//
// WHY THIS IS A SEPARATE FILE
//   `src/lib/marketingImport.ts` is the part that has to be unit-tested — the
//   match key and the diff are where the bugs live, and neither needs a database
//   to be wrong. So that module talks to ports (`MarketingTargetSnapshot`,
//   `MarketingAccountWriter`) and this file is the only implementation that
//   knows about Prisma. Same split as `rosterIngest.ts` / `rosterIngestStore.ts`.
//
// THE THREE THINGS THIS FILE IS RESPONSIBLE FOR
//   1. **The tenant context.** A CLI run has no session, so `withTenantScope` is
//      not available to it: the run binds the OWNER's org with
//      `runWithOrg(orgId, …)` and every query inside also carries `orgId`
//      explicitly, so the scoping is right whether or not MT_ENFORCE_ISOLATION
//      is on. There is no tenant column in the file, on purpose — one run is one
//      organization (docs/marketing-import.md).
//   2. **Three queries, not three per row.** The snapshot is loaded once for the
//      whole run: the org's companies, the lead users the file names, and those
//      users' relations. `normalizeNameKey()` is a JavaScript function and
//      cannot be expressed in SQL, so the name half of the match key is matched
//      in memory — a WHERE built from raw names would be a SECOND, weaker
//      normalizer, which is the failure #2405 exists to avoid.
//   3. **One transaction per ROW.** The roster feed uses one per chunk because
//      its resume checkpoint has to commit with the chunk; this importer has no
//      checkpoint, and the unit that must be all-or-nothing is the row — a row
//      writes up to four tables (Company, the lead User, the relation, a
//      StatusChange) and a refused one must leave none of them behind while the
//      other ninety-nine still land.

import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { randomUUID } from 'node:crypto';
import { runWithOrg } from './orgContext';
import { acquireLease, releaseLease, replicaId } from './jobs/lease';
import { logActivity } from './activity';
import { runImport, parseDelimited, type ImportReport, type ParsedTable } from './importPreview';
import { resolvePipelineStages } from './pipelineStages';
import { startStageKey } from './pipeline';
import { statusChangeData } from './stageChange';
import { trialLengthDaysFor } from './trialWindow';
import { NO_LOGIN_PASSWORD } from './menteeAccount';
import { normalizeEmailKey } from './duplicateDetection';
import { findUsersByEmail, worldOfOrg } from './userWorld';
import {
  AlreadyMentoredError,
  findActiveMentorship,
} from './activeMentorship';
import {
  applyPlannedAccounts,
  CONTACT_IN_FUNNEL,
  CONTACT_IS_USER,
  createOnlyPlan,
  createOnlyWriter,
  diffMarketingAccounts,
  funnelRelationCreateData,
  funnelRelationUpdateData,
  leadStandInEmail,
  makeMarketingValidator,
  manualAccountTable,
  previewWriter,
  type ManualAccountFields,
  type MarketingAccountRow,
  type MarketingAccountWriter,
  type MarketingPlanValue,
  type MarketingPlannedRow,
  type MarketingTargetSnapshot,
} from './marketingImport';

type TxClient = Prisma.TransactionClient;

export interface MarketingImportOwner {
  id: string;
  email: string;
  orgId: string | null;
  role: string;
}

export class MarketingImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MarketingImportError';
    this.code = code;
  }
}

/**
 * Resolve `--owner`. The run's organization is this user's organization — the
 * file never names one.
 *
 * ONE PERSON, TWO WORLDS (#2590). `User.email` is no longer unique: the same
 * mailbox can be an ADMIN in the internship product AND in the marketing
 * product, two rows in two organizations, and this CLI has no host or session
 * to say which one is meant. The lookup therefore has to look across worlds
 * (`findUsersByEmail` — its one legitimate use: the address is only the handle
 * for *choosing an organization*) and then decide, never guess:
 *   - one account holds the address: it is the owner, exactly as before (and
 *     the `owner_role` check below still names its role);
 *   - several do: this is the MARKETING account importer, so the owner is the
 *     one that lives in a marketing organization — and only when that is
 *     unambiguous. Anything else is `owner_ambiguous`, because importing a
 *     spreadsheet into the wrong product's tenant is not a mistake to make
 *     quietly.
 */
export async function resolveImportOwner(email: string): Promise<MarketingImportOwner> {
  const accounts = await findUsersByEmail(email, { id: true, email: true, orgId: true, role: true });
  if (accounts.length === 0) throw new MarketingImportError('owner_not_found', `Owner not found: ${email}`);

  let owner = accounts[0];
  if (accounts.length > 1) {
    const worlds = await Promise.all(accounts.map((a) => worldOfOrg(a.orgId)));
    const marketing = accounts.filter((_, i) => worlds[i] === 'MARKETING');
    if (marketing.length !== 1) {
      throw new MarketingImportError(
        'owner_ambiguous',
        `${accounts.length} accounts use ${email} and ${marketing.length} of them are in a marketing organization — ` +
          'use an owner address that identifies exactly one organization',
      );
    }
    owner = marketing[0];
  }
  if (owner.role !== 'ADMIN' && owner.role !== 'MENTOR') {
    throw new MarketingImportError(
      'owner_role',
      `Owner must be ADMIN or MENTOR (${owner.email} is ${owner.role})`,
    );
  }
  return owner;
}

// ── The snapshot ─────────────────────────────────────────────────────────────

const ACCOUNT_SELECT = {
  id: true,
  name: true,
  vatId: true,
  country: true,
  industry: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  externalId: true,
} as const;

async function loadSnapshot(
  orgId: string | null,
  emailKeys: string[],
): Promise<MarketingTargetSnapshot> {
  // One query for every account of the org. The alternative — a WHERE built
  // from the file's raw names — cannot express `normalizeNameKey()`, so it
  // would silently miss exactly the İ/ı/ü/ß rows #2405 is about.
  const accounts = await prisma.company.findMany({ where: { orgId }, select: ACCOUNT_SELECT });

  // Every person lookup below carries `orgId` (#2590): the same address can be a
  // different person-record in the other world, and that one is neither a lead
  // to update nor a staff user to collide with.
  const leads = emailKeys.length
    ? await prisma.user.findMany({
        // MENTEE only: a staff user whose address is typed in as a contact is
        // never the lead (see `MarketingLeadTarget.role`). The diff enforces
        // the same rule on `role`, so a snapshot built elsewhere cannot slip one in.
        where: { orgId, email: { in: emailKeys }, role: 'MENTEE' },
        select: {
          id: true,
          role: true,
          email: true,
          fullName: true,
          phone: true,
          city: true,
          country: true,
          preferredLanguage: true,
          referralSource: true,
          companyId: true,
        },
      })
    : [];

  const relations = leads.length
    ? await prisma.mentorshipRelation.findMany({
        where: { menteeId: { in: leads.map((l) => l.id) } },
        select: {
          id: true,
          mentorId: true,
          menteeId: true,
          companyId: true,
          pipelineStatus: true,
          status: true,
          // The dates the file may fill in (#2554) — planned against these.
          trialStartedAt: true,
          trialEndsAt: true,
          startDate: true,
        },
      })
    : [];

  return { accounts, leads, relations };
}

// ── The writer ───────────────────────────────────────────────────────────────

interface WriterContext {
  orgId: string | null;
  /** Stage keys the org marks `isOffPath` — the same source `stageChange.ts` reads. */
  offPathStages: ReadonlySet<string>;
  /** The org's `trialLengthDays`, resolved once per run (#2551). */
  trialLengthDays: number;
}

/**
 * Why a stage move made by an import carries a drop-off reason.
 *
 * `validateDropoffReason()` refuses a move into an off-path stage without one,
 * so that a human dragging a card to "Lost" has to say why. A migration has no
 * such column — the spreadsheet's status IS the reason it knows — so the import
 * attaches a fixed, honest one rather than either bypassing the rule or
 * refusing to carry a lost deal across. `OTHER` + a note is exactly the shape
 * `validateDropoffReason` accepts.
 */
const IMPORT_REASON_CODE = 'OTHER';
const IMPORT_REASON_NOTE = 'Imported from the marketing account spreadsheet';

function accountCreateData(row: MarketingPlannedRow, orgId: string | null) {
  const { changes } = row.value.account;
  return {
    orgId,
    name: changes.name ?? row.value.input.name,
    vatId: changes.vatId ?? null,
    country: changes.country ?? null,
    industry: changes.industry ?? null,
    contactName: changes.contactName ?? null,
    contactEmail: changes.contactEmail ?? null,
    contactPhone: changes.contactPhone ?? null,
    externalId: changes.externalId ?? null,
  };
}

/**
 * Place the row's lead person and funnel record. Runs inside the row's own
 * transaction, after the Company is written, so `companyId` is known.
 */
async function placeOnFunnel(
  tx: TxClient,
  row: MarketingPlannedRow,
  companyId: string,
  context: WriterContext,
): Promise<void> {
  const funnel = row.value.funnel;
  if (!funnel || !funnel.pending) return;

  let leadId = funnel.leadId;
  if (!leadId) {
    // The lead person: a record, never an account. Password-less
    // (`NO_LOGIN_PASSWORD`, which `bcrypt.compare` can never match), never
    // invited, and — the part that actually makes it a record rather than a
    // login — on a GENERATED STAND-IN ADDRESS, not the merchant's mailbox, so
    // the `/api/auth/forgot` → `/api/auth/reset` path has nowhere to mail
    // (src/lib/menteeAccount.ts names that as the precondition; see
    // "The lead person's address" in ./marketingImport.ts). The real address is
    // on `Company.contactEmail`, which is where #2407 asks for it.
    // Role MENTEE because the Role enum is frozen (#2348) and MENTEE is the
    // side of a relation a lead occupies.
    //
    // No `emailTakenInOrgWorld()` call before this create (#2590), on purpose:
    // the stand-in address is hashed together with the organization's id
    // (`leadStandInEmail(key, orgKey)`) on the `import.local` domain, so the
    // only account that can already hold it is THIS org's own earlier run — and
    // that one was loaded into the snapshot by `loadSnapshot` (`funnel.leadId`
    // is set, so this branch is not reached). The merchant's real mailbox,
    // which could collide with an account in either world, is never used as a
    // login address here.
    const created = await tx.user.create({
      data: {
        orgId: context.orgId,
        email: funnel.leadEmail,
        password: NO_LOGIN_PASSWORD,
        role: 'MENTEE',
        fullName: funnel.leadChanges.fullName ?? funnel.leadEmail,
        skills: [],
        companyId,
        phone: funnel.leadChanges.phone ?? null,
        city: funnel.leadChanges.city ?? null,
        country: funnel.leadChanges.country ?? null,
        preferredLanguage: funnel.leadChanges.preferredLanguage ?? null,
        referralSource: funnel.leadChanges.referralSource ?? null,
      },
      select: { id: true },
    });
    leadId = created.id;
  } else if (funnel.leadChanged.length > 0) {
    await tx.user.update({ where: { id: leadId }, data: { ...funnel.leadChanges, companyId } });
  }

  // ONE mentee, at most one ACTIVE mentor (#419) — asked through the shared
  // helper inside the transaction, never a hand-rolled findFirst.
  const active = await findActiveMentorship(tx, leadId);
  if (active && active.mentorId !== funnel.ownerId) {
    // Refused, not re-pointed: changing `mentorId` in place would re-attribute
    // the other owner's work (docs/mentor-transfer.md). The row is reported as
    // an ERROR and the operator decides.
    throw new AlreadyMentoredError(leadId, active.id);
  }

  if (!active) {
    // A record created straight into TRIAL_ACTIVE gets its trial window in the
    // same insert (#2551) — see funnelRelationCreateData().
    await tx.mentorshipRelation.create({
      data: funnelRelationCreateData(funnel, leadId, {
        orgId: context.orgId,
        companyId,
        now: new Date(),
        trialLengthDays: context.trialLengthDays,
      }),
    });
    // No StatusChange for a relation CREATED at this stage: `stageEnteredAt()`
    // already answers from `startDate` when there is no history
    // (src/lib/stageClock.ts), and a from→to row would record a move that never
    // happened and inflate every "stage moves" count.
    return;
  }

  const current = await tx.mentorshipRelation.findUnique({
    where: { id: active.id },
    select: { pipelineStatus: true, companyId: true, trialStartedAt: true, trialEndsAt: true },
  });
  const fromStatus = current?.pipelineStatus ?? funnel.fromStage ?? funnel.toStage;
  await tx.mentorshipRelation.update({
    where: { id: active.id },
    data: funnelRelationUpdateData(funnel, current, {
      companyId,
      now: new Date(),
      trialLengthDays: context.trialLengthDays,
    }),
  });

  // Stage history for a marketing account lives HERE — one `StatusChange` on
  // the funnel record — and nowhere else (#2406's open decision). See
  // docs/marketing-vertical/pipeline-record.md: the account (`Company`) is
  // master data and does not move; the relation is what moves, and it already
  // has the table, the SLA clock, the aging report and the board reading it. A
  // `StatusChange.companyId` variant or a Company-level history table would be a
  // second stage history that every one of those readers would have to learn.
  const data = statusChangeData({
    relationId: active.id,
    fromStatus,
    toStatus: funnel.toStage,
    changedById: funnel.ownerId,
    ...(context.offPathStages.has(funnel.toStage)
      ? { reasonCode: IMPORT_REASON_CODE, reasonNote: IMPORT_REASON_NOTE }
      : {}),
  });
  if (data) await tx.statusChange.create({ data });
}

function databaseWriter(context: WriterContext): MarketingAccountWriter {
  return {
    async createAccount(row) {
      return prisma.$transaction(async (tx) => {
        const company = await tx.company.create({
          data: accountCreateData(row, context.orgId),
          select: { id: true },
        });
        await placeOnFunnel(tx, row, company.id, context);
        return company.id;
      });
    },
    async updateAccount(row) {
      const targetId = row.value.account.targetId;
      if (!targetId) throw new Error('an UPDATE row reached the writer without a target id');
      return prisma.$transaction(async (tx) => {
        if (row.value.account.changed.length > 0) {
          await tx.company.update({ where: { id: targetId }, data: row.value.account.changes });
        }
        await placeOnFunnel(tx, row, targetId, context);
        return targetId;
      });
    },
  };
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface MarketingImportOptions {
  /** The delimited text of the file. */
  text: string;
  /** `--owner`: the run's default funnel owner, and the organization. */
  ownerEmail: string;
  /** Dry run unless this is true — `--apply` on the CLI. */
  apply?: boolean;
  /** `--authoritative`: overwrite a value the file disagrees with. */
  authoritative?: boolean;
  /** `--delimiter`; sniffed from the header line when omitted. */
  delimiter?: string;
  chunkSize?: number;
  /**
   * The owner, already resolved — the admin panel (#2552) resolves it from the
   * session, or from an owner the admin picked in the same org, so no e-mail
   * lookup is needed. When set, `ownerEmail` is ignored.
   */
  owner?: MarketingImportOwner;
  /** Who ran it, for the activity log, when that is not the owner. Defaults to the owner. */
  actor?: { id: string; email: string | null };
  /** The request, so the activity row carries its IP/user agent like other admin writes. */
  request?: Request;
  /**
   * Refuse a file with more data rows than this (`too_many_rows`) before
   * anything is planned. The panel sets it; the CLI does not.
   */
  maxRows?: number;
}

export interface MarketingImportRunResult {
  owner: MarketingImportOwner;
  report: ImportReport<MarketingPlanValue>;
  /** The org's stage keys, so the CLI can print what a bad `stage` may be. */
  stageKeys: string[];
}

/**
 * How long one apply may hold its organization's import lease. Far above a
 * worst-case run (MARKETING_IMPORT_MAX_ROWS rows, one short transaction each);
 * a run that somehow outlives it loses only the exclusivity, and a crashed one
 * frees the lease by expiry — the JobLease rule, never a `finally` alone.
 */
export const MARKETING_IMPORT_LEASE_TTL_MS = 30 * 60 * 1000;

/** One lease per organization: two orgs import in parallel, one org one at a time. */
export function marketingImportLeaseName(orgId: string | null): string {
  return `marketing-import:${orgId ?? 'default'}`;
}

/**
 * One import run. Dry run by default; `apply: true` is the same call with a
 * writer that writes — there is no `if (dryRun)` branch anywhere in the
 * planning path, which is the property the shared engine exists to guarantee.
 *
 * An apply holds the organization's import lease (#2552 review) for the whole
 * run: two applies at once would each plan against a snapshot taken before
 * the other wrote, and `externalId` / name+country carry no unique index, so a
 * VAT-less account would be created twice and one external id could land on
 * two accounts. A second apply while one runs is refused (`import_running`).
 * The holder is unique per RUN, not per process — two tabs on one replica are
 * two contenders. A preview writes nothing and takes no lease.
 */
export async function runMarketingAccountImport(
  options: MarketingImportOptions,
): Promise<MarketingImportRunResult> {
  const owner = options.owner ?? (await resolveImportOwner(options.ownerEmail));
  if (options.apply !== true) return runMarketingAccountImportLocked(options, owner);
  const lease = marketingImportLeaseName(owner.orgId);
  const holder = `${replicaId().slice(0, 150)}:${randomUUID()}`;
  if (!(await acquireLease(lease, holder, MARKETING_IMPORT_LEASE_TTL_MS))) {
    throw new MarketingImportError(
      'import_running',
      'Another marketing account import is being applied in this organization; wait for it to finish',
    );
  }
  try {
    return await runMarketingAccountImportLocked(options, owner);
  } finally {
    // An optimisation only: expiry is what frees a lease a crashed run held.
    await releaseLease(lease, holder);
  }
}

async function runMarketingAccountImportLocked(
  options: MarketingImportOptions,
  owner: MarketingImportOwner,
): Promise<MarketingImportRunResult> {
  const orgId = owner.orgId;
  const apply = options.apply === true;
  const { maxRows } = options;

  const { report, stageKeys } = await runMarketingRows({
    owner,
    parse: () => {
      // The same parser either way; the cap is a check on its output, so a
      // bounded run cannot read the file differently from an unbounded one.
      const table = parseDelimited(options.text, { delimiter: options.delimiter });
      if (maxRows !== undefined && table.rows.length > maxRows) {
        throw new MarketingImportError('too_many_rows', `The file has ${table.rows.length} rows; at most ${maxRows} per run`);
      }
      return table;
    },
    mode: apply ? 'database' : 'preview',
    authoritative: options.authoritative,
    chunkSize: options.chunkSize,
  });

  if (apply) {
    // Counts only — never a name, an address or a row (#2552: the panel's run
    // is logged like the CLI's, and the activity log is read by every admin).
    await runWithOrg(orgId, () =>
      logActivity({
        action: 'marketing.accounts.imported',
        actorId: options.actor?.id ?? owner.id,
        actorEmail: options.actor ? options.actor.email : owner.email,
        targetType: 'Organization',
        targetId: orgId,
        detail: `rows=${report.total} ${Object.entries(report.counts)
          .map(([status, count]) => `${status}=${count}`)
          .join(' ')}${options.authoritative ? ' authoritative' : ''}`,
        ...(options.request ? { request: options.request } : {}),
      }),
    );
  }

  return { owner, report, stageKeys };
}

/** Which writer a planned run applies with — the ONLY thing that differs between modes. */
type WriterMode = 'preview' | 'database' | 'createOnly';

interface MarketingRunCore {
  owner: MarketingImportOwner;
  parse: () => ParsedTable;
  mode: WriterMode;
  authoritative?: boolean;
  chunkSize?: number;
}

/**
 * The planning + apply half shared by every entry point: the CLI's file import
 * and the one-row create (#2562). One validator, one match key, one diff, one
 * writer — the manual form is a file of one row, never a second lead writer.
 */
async function runMarketingRows(core: MarketingRunCore) {
  const { owner } = core;
  const orgId = owner.orgId;

  return runWithOrg(orgId, async () => {
    const stages = await resolvePipelineStages(orgId);
    const stageKeys = stages.map((s) => s.key);
    const offPathStages = new Set(stages.filter((s) => s.isOffPath).map((s) => s.key));

    const validate = makeMarketingValidator({ stageKeys });
    const trialLengthDays = await trialLengthDaysFor(orgId);
    const database = databaseWriter({ orgId, offPathStages, trialLengthDays });
    // Create-only: a CREATE is written through the import's own writer; an
    // UPDATE is what an existing account WOULD receive, so it is reported and
    // not written — "this account already exists" is the answer, not a merge.
    const writer: MarketingAccountWriter =
      core.mode === 'database'
        ? database
        : core.mode === 'createOnly'
          ? createOnlyWriter(database)
          : previewWriter;

    const report = await runImport<MarketingAccountRow, MarketingPlanValue>({
      parse: core.parse,
      validate,
      resolve: async (rows) => {
        const contactKeys = [
          ...new Set(rows.map((r) => normalizeEmailKey(r.value.contactEmail)).filter(Boolean)),
        ];
        // Both addresses a lead of this file could be stored under: the real
        // one (an applicant, or a mentor-entered mentee) and the stand-in a
        // previous run of this importer created for the same contact.
        const emailKeys = [
          ...contactKeys,
          ...contactKeys.map((k) => leadStandInEmail(k, orgId ?? '')),
        ];
        const ownerEmails = [...new Set(rows.map((r) => r.value.ownerEmail).filter(Boolean))];
        const [snapshot, owners] = await Promise.all([
          loadSnapshot(orgId, emailKeys),
          ownerEmails.length
            ? prisma.user.findMany({
                where: { orgId, email: { in: ownerEmails }, role: { in: ['ADMIN', 'MENTOR'] } },
                select: { id: true, email: true },
              })
            : Promise.resolve([] as { id: string; email: string }[]),
        ]);
        return diffMarketingAccounts(rows, snapshot, {
          defaultOwnerId: owner.id,
          defaultOwnerEmail: owner.email,
          ownerIdByEmail: new Map(owners.map((o) => [o.email.toLowerCase(), o.id])),
          orgKey: orgId ?? '',
          authoritative: core.authoritative === true,
          trialLengthDays,
        });
      },
      apply: (chunk) =>
        applyPlannedAccounts(core.mode === 'createOnly' ? createOnlyPlan(chunk) : chunk, writer),
      dryRun: core.mode === 'preview',
      ...(core.chunkSize ? { chunkSize: core.chunkSize } : {}),
    });

    return { report, stages, stageKeys };
  });
}

// ── One account, typed in by hand (#2562) ────────────────────────────────────

export type ManualAccountOutcome =
  | { kind: 'created'; companyId: string; leadId: string | null; stage: string }
  /** The match key found an account: nothing was written. */
  | { kind: 'exists'; companyId: string; leadId: string | null }
  /** Several accounts share the name and neither side names a country or VAT. */
  | { kind: 'ambiguous'; reason: string }
  /** The contact address is a staff user of this org (see CONTACT_IS_USER). */
  | { kind: 'contact_is_user' }
  /** The contact already has an active funnel record (see CONTACT_IN_FUNNEL). */
  | { kind: 'contact_in_funnel'; leadId: string | null }
  /** The contact is another owner's lead (#419) — transfer, do not duplicate. */
  | { kind: 'already_mentored' }
  /** The import's own validator refused the row (country, VAT, length, stage). */
  | { kind: 'invalid'; reason: string }
  /** The writer failed (rolled back): an internal error, not the caller's input. */
  | { kind: 'write_failed'; reason: string };

/**
 * Create one marketing account + lead + funnel record through the import's
 * writer, create-only (#2562). The owner is the acting user; the stage
 * defaults to the org's start stage (`startStageKey`, the rule every create
 * path shares through `resolveStartStage`).
 *
 * No marketing-consent record is written: a hand-typed lead has given none
 * (#2577 — the manual source is NONE), and the importer writes none either.
 */
export async function createMarketingAccount(input: {
  owner: MarketingImportOwner;
  fields: ManualAccountFields;
  request?: Request;
  /**
   * Where the row came from, for the activity log: `manual` (the form on
   * /admin/companies, #2562) or `inquiry` (a demo request from the public
   * marketing form, converted by an admin or by the default owner, #2569).
   * Same writer either way — only the log line differs.
   */
  origin?: 'manual' | 'inquiry';
  /**
   * Who did it, when that is not the owner — an admin typing a lead in for the
   * org's default owner (#2580), or a web request placed on the default
   * owner's funnel (actor = null: nobody signed in did it). Defaults to the owner.
   */
  actor?: { id: string; email: string | null } | null;
}): Promise<ManualAccountOutcome> {
  const { owner, fields } = input;
  const stages = await runWithOrg(owner.orgId, () => resolvePipelineStages(owner.orgId));
  const stage = fields.stage?.trim() || startStageKey(stages);
  // A new lead starts on the path. A "lost" card that was never open is not a
  // lead, and the off-path stages demand a drop-off reason this form has no
  // field for — the import attaches a fixed one; a person should not.
  if (stages.find((s) => s.key === stage)?.isOffPath) {
    return { kind: 'invalid', reason: `stage "${stage}" is off the funnel path` };
  }

  // A staff address typed in as the contact — the admin's own, a colleague's —
  // is refused before anything is planned (CONTACT_IS_USER). The import would
  // create a separate stand-in lead for it; a form asks the person instead.
  //
  // "Staff" means staff OF THIS ORGANIZATION, and the `orgId` in the filter is
  // what keeps it that way (#2590): the same mailbox can also be an account in
  // the internship world — a different person-record in another tenant — and
  // typing the admin's own address as a lead's contact is only a collision when
  // the account is in THIS org. An other-world account is not `contact_is_user`.
  const contactKey = normalizeEmailKey(fields.contactEmail ?? '');
  if (contactKey) {
    const staff = await runWithOrg(owner.orgId, () =>
      prisma.user.findFirst({
        where: { orgId: owner.orgId, email: contactKey, role: { not: 'MENTEE' } },
        select: { id: true },
      }),
    );
    if (staff) return { kind: CONTACT_IS_USER };
  }

  const { report } = await runMarketingRows({
    owner,
    parse: () => manualAccountTable({ ...fields, stage }),
    mode: 'createOnly',
  });
  const row = report.rows[0];
  if (!row) return { kind: 'invalid', reason: 'empty row' };
  const funnel = row.value?.funnel ?? null;

  switch (row.status) {
    case 'CREATE': {
      const companyId = row.targetId;
      if (!companyId) return { kind: 'invalid', reason: 'the account was not written' };
      let leadId = funnel?.leadId ?? null;
      if (!leadId && funnel) {
        // The lead this run just created, found by its stand-in address INSIDE
        // the owner's org (#2590): the address is no longer globally unique, so
        // a bare lookup by it could return another world's row.
        const lead = await runWithOrg(owner.orgId, () =>
          prisma.user.findFirst({ where: { orgId: owner.orgId, email: funnel.leadEmail }, select: { id: true } }),
        );
        leadId = lead?.id ?? null;
      }
      await runWithOrg(owner.orgId, () =>
        logActivity({
          action: 'marketing.account.created',
          actorId: input.actor === undefined ? owner.id : (input.actor?.id ?? null),
          actorEmail: input.actor === undefined ? owner.email : (input.actor?.email ?? null),
          targetType: 'Company',
          targetId: companyId,
          detail: `${input.origin ?? 'manual'} stage=${stage}${leadId ? ` lead=${leadId}` : ''}`,
          ...(input.request ? { request: input.request } : {}),
        }),
      );
      return { kind: 'created', companyId, leadId, stage };
    }
    case 'UPDATE':
    case 'UNCHANGED':
      return { kind: 'exists', companyId: row.targetId ?? '', leadId: funnel?.leadId ?? null };
    case 'SKIP':
      if (row.reason === CONTACT_IN_FUNNEL) return { kind: 'contact_in_funnel', leadId: funnel?.leadId ?? null };
      return { kind: 'ambiguous', reason: row.reason ?? '' };
    default:
      if (row.reason?.includes('already_mentored')) return { kind: 'already_mentored' };
      // A refusal the diff made (an external-id conflict, #2554) is about the
      // input, not a failed write. The form sends no external id today, so this
      // is defensive — but it must not read as a 500.
      if (row.value?.refused) return { kind: 'invalid', reason: row.value.refused };
      // A row the VALIDATOR refused carries no plan value; one that reached the
      // writer and failed there does. The first is the caller's input and is
      // worth echoing; the second is ours (a unique index, a dropped
      // connection) and is logged, not shown.
      if (row.value) return { kind: 'write_failed', reason: row.reason ?? 'write failed' };
      return { kind: 'invalid', reason: row.reason ?? 'refused' };
  }
}
