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
import { runWithOrg } from './orgContext';
import { logActivity } from './activity';
import { runImport, parseDelimited, type ImportReport } from './importPreview';
import { resolvePipelineStages } from './pipelineStages';
import { statusChangeData } from './stageChange';
import { NO_LOGIN_PASSWORD } from './menteeAccount';
import { normalizeEmailKey } from './duplicateDetection';
import {
  AlreadyMentoredError,
  findActiveMentorship,
} from './activeMentorship';
import {
  applyPlannedAccounts,
  diffMarketingAccounts,
  makeMarketingValidator,
  previewWriter,
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
 */
export async function resolveImportOwner(email: string): Promise<MarketingImportOwner> {
  const owner = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true, orgId: true, role: true },
  });
  if (!owner) throw new MarketingImportError('owner_not_found', `Owner not found: ${email}`);
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
} as const;

async function loadSnapshot(
  orgId: string | null,
  emailKeys: string[],
): Promise<MarketingTargetSnapshot> {
  // One query for every account of the org. The alternative — a WHERE built
  // from the file's raw names — cannot express `normalizeNameKey()`, so it
  // would silently miss exactly the İ/ı/ü/ß rows #2405 is about.
  const accounts = await prisma.company.findMany({ where: { orgId }, select: ACCOUNT_SELECT });

  const leads = emailKeys.length
    ? await prisma.user.findMany({
        where: { orgId, email: { in: emailKeys } },
        select: {
          id: true,
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
        select: { id: true, mentorId: true, menteeId: true, companyId: true, pipelineStatus: true, status: true },
      })
    : [];

  return { accounts, leads, relations };
}

// ── The writer ───────────────────────────────────────────────────────────────

interface WriterContext {
  orgId: string | null;
  /** Stage keys the org marks `isOffPath` — the same source `stageChange.ts` reads. */
  offPathStages: ReadonlySet<string>;
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
    // invited, `emailVerified` left at its default — exactly the row the
    // mentor-entered mentee and the public application already mint
    // (src/lib/menteeAccount.ts). Role MENTEE because the Role enum is frozen
    // (#2348) and MENTEE is the side of a relation a lead occupies.
    const created = await tx.user.create({
      data: {
        orgId: context.orgId,
        email: funnel.emailKey,
        password: NO_LOGIN_PASSWORD,
        role: 'MENTEE',
        fullName: funnel.leadChanges.fullName ?? funnel.emailKey,
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
    await tx.mentorshipRelation.create({
      data: {
        orgId: context.orgId,
        mentorId: funnel.ownerId,
        menteeId: leadId,
        companyId,
        pipelineStatus: funnel.toStage,
      },
    });
    // No StatusChange for a relation CREATED at this stage: `stageEnteredAt()`
    // already answers from `startDate` when there is no history
    // (src/lib/stageClock.ts), and a from→to row would record a move that never
    // happened and inflate every "stage moves" count.
    return;
  }

  const current = await tx.mentorshipRelation.findUnique({
    where: { id: active.id },
    select: { pipelineStatus: true, companyId: true },
  });
  const fromStatus = current?.pipelineStatus ?? funnel.fromStage ?? funnel.toStage;
  await tx.mentorshipRelation.update({
    where: { id: active.id },
    data: { pipelineStatus: funnel.toStage, companyId },
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
}

export interface MarketingImportRunResult {
  owner: MarketingImportOwner;
  report: ImportReport<MarketingPlanValue>;
  /** The org's stage keys, so the CLI can print what a bad `stage` may be. */
  stageKeys: string[];
}

/**
 * One import run. Dry run by default; `apply: true` is the same call with a
 * writer that writes — there is no `if (dryRun)` branch anywhere in the
 * planning path, which is the property the shared engine exists to guarantee.
 */
export async function runMarketingAccountImport(
  options: MarketingImportOptions,
): Promise<MarketingImportRunResult> {
  const owner = await resolveImportOwner(options.ownerEmail);
  const orgId = owner.orgId;

  return runWithOrg(orgId, async () => {
    const stages = await resolvePipelineStages(orgId);
    const stageKeys = stages.map((s) => s.key);
    const offPathStages = new Set(stages.filter((s) => s.isOffPath).map((s) => s.key));

    const validate = makeMarketingValidator({ stageKeys });
    const apply = options.apply === true;
    const writer = apply ? databaseWriter({ orgId, offPathStages }) : previewWriter;

    const report = await runImport<MarketingAccountRow, MarketingPlanValue>({
      parse: () => parseDelimited(options.text, { delimiter: options.delimiter }),
      validate,
      resolve: async (rows) => {
        const emailKeys = [
          ...new Set(rows.map((r) => normalizeEmailKey(r.value.contactEmail)).filter(Boolean)),
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
          authoritative: options.authoritative === true,
        });
      },
      apply: (chunk) => applyPlannedAccounts(chunk, writer),
      dryRun: !apply,
      ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}),
    });

    if (apply) {
      await logActivity({
        action: 'marketing.accounts.imported',
        actorId: owner.id,
        actorEmail: owner.email,
        targetType: 'Organization',
        targetId: orgId,
        detail: `rows=${report.total} ${Object.entries(report.counts)
          .map(([status, count]) => `${status}=${count}`)
          .join(' ')}`,
      });
    }

    return { owner, report, stageKeys };
  });
}
