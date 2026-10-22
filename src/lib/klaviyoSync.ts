// The Klaviyo pull connector — the Prisma half and the ONLY writer of
// `ExternalConnection` / `ExternalProfileLink` (docs/integrations/klaviyo.md).
//
// WHAT A RUN DOES
//   Every 15 minutes (and on "Sync now"), per enabled connection whose backoff
//   has elapsed: read profile pages from the provider (GET only — the CRM never
//   writes to Klaviyo), and turn each page into leads through the SHARED import
//   engine — `runImport({ parse, validate, resolve, apply })`
//   (src/lib/importPreview.ts). A dry run (the admin screen's preview) is the
//   same call with a writer that does not write.
//
// WHERE A PROFILE GOES
//   1. a profile already linked (`ExternalProfileLink`) → that account: UPDATE
//      or UNCHANGED, never a second account;
//   2. else the address matches a lead of THIS org (its stand-in or its real
//      address) or exactly one account's contact e-mail → that account is
//      ADOPTED (linked, gaps filled);
//   3. else a NEW account + lead + funnel record at the org's first stage,
//      through the marketing import's own create-only writer
//      (`createMarketingAccountsBatch`) — one planning pass per page, so the
//      stand-in lead, the one-active-owner rule (#419), the machine-only NONE
//      contact permission and first-touch attribution stay in one place.
//
// WHAT A RE-SYNC MAY CHANGE
//   The account and lead fields go through the one overwrite policy
//   (`planFieldUpdates`, non-authoritative): a gap is filled, a value a person
//   typed is never overwritten — it is reported as withheld. The provider's
//   own data on the link (location, custom properties, consent summary) is the
//   provider's and is replaced on every sync. The consent summary is INFO: it
//   never becomes a contact permission (docs/contact-permission.md).
//
// QUIET FIRST IMPORT
//   Until the first full query completed (`initialSyncDoneAt`), a run is
//   silent: no bell, and one aggregated activity line when it completes. Later
//   runs ring the lead owner's bell once per run with the number of new leads.
//   No run ever mails a lead.
//
// TENANCY
//   A scheduled run has no session. The connection row says which tenant this
//   is; the run binds it with `runWithOrg(orgId, …)` and every query below also
//   carries `orgId` explicitly. One connection runs at a time (a JobLease per
//   connection); a failing or slow tenant never blocks another — each has its
//   own backoff and the tick catches per connection.
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { seal, open } from '@/lib/secretBox';
import { runWithOrg } from '@/lib/orgContext';
import { acquireLease, releaseLease, replicaId } from '@/lib/jobs/lease';
// The store is passed in, not left to `lease.ts`'s lazy `import('./leaseStore')`:
// the Playwright spec runner transforms static imports only, so under it that
// dynamic import fails, the lease reads as held, and the run is refused (#3145).
import { prismaLeaseStore } from '@/lib/jobs/leaseStore';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { findLeadOwner, resolveDefaultLeadOwner } from '@/lib/leadOwner';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { startStageKey } from '@/lib/pipeline';
import { verticalFor } from '@/lib/verticalContext';
import { leadSourceName } from '@/lib/leadSourceName';
import { findOrCreateSource } from '@/lib/leadSource';
import { planFieldUpdates } from '@/lib/externalSyncPolicy';
import { leadStandInEmail, CONTACT_IN_FUNNEL, type ManualAccountFields } from '@/lib/marketingImport';
import { normalizeNameKey } from '@/lib/duplicateDetection';
import { profileEmailHash } from '@/lib/externalProfileErasure';
import { createMarketingAccountsBatch, type MarketingImportOwner } from '@/lib/marketingImportStore';
import { runImport, emptyCounts, importErrorMessage, type ImportReport, type PlannedRow, type RowResult, type RowStatus } from '@/lib/importPreview';
import { fetchListNames, fetchProfilesPage, testKlaviyoKey, type KlaviyoClientOptions } from '@/lib/klaviyoClient';
import {
  KLAVIYO_PAGES_PER_MANUAL_RUN,
  KLAVIYO_PAGES_PER_RUN,
  KLAVIYO_PREVIEW_MAX,
  KLAVIYO_PROVIDER,
  KLAVIYO_REQUIRED_SCOPES,
  KLAVIYO_REVISION,
  KLAVIYO_SECRET_PURPOSE,
  afterPage,
  beginQuery,
  disambiguatedAccountName,
  isDue,
  keyLast4,
  mapProfile,
  nextAttemptDelayMs,
  restartQuery,
  type KlaviyoErrorCode,
  type KlaviyoLead,
  type ProfilesCursor,
} from '@/lib/klaviyoRule';

/** `Company.createdBySource` of an account this connector created (the rollback CLI reads it). */
export const KLAVIYO_CREATED_BY = KLAVIYO_PROVIDER;
/** One run holds its connection's lease at most this long; expiry frees a crashed run's. */
export const KLAVIYO_LEASE_TTL_MS = 10 * 60 * 1000;
/** A run stops starting new pages after this long, whatever its page budget. */
const RUN_TIME_BUDGET_MS = 4 * 60 * 1000;

export function klaviyoLeaseName(connectionId: string): string {
  return `klaviyo-sync:${connectionId}`;
}

// ── The connection row ───────────────────────────────────────────────────────

const VIEW_SELECT = {
  id: true,
  enabled: true,
  keyLast4: true,
  initialSyncDoneAt: true,
  lastSyncAt: true,
  lastSyncOkAt: true,
  lastStatus: true,
  lastErrorCode: true,
  failures: true,
  nextAttemptAt: true,
  lastCreated: true,
  lastUpdated: true,
  lastUnchanged: true,
  lastSkipped: true,
  lastErrors: true,
  totalCreated: true,
  createdAt: true,
} satisfies Prisma.ExternalConnectionSelect;

/**
 * What the admin screen reads. NEVER the key: only its last four characters,
 * the same way an API key is shown after creation.
 */
export async function klaviyoConnectionView(orgId: string) {
  const row = await prisma.externalConnection.findFirst({
    where: { orgId, provider: KLAVIYO_PROVIDER },
    select: VIEW_SELECT,
  });
  const linkedProfiles = row
    ? await prisma.externalProfileLink.count({ where: { orgId, connectionId: row.id, erasedAt: null } })
    : 0;
  return {
    connected: Boolean(row),
    connection: row,
    linkedProfiles,
    requiredScopes: [...KLAVIYO_REQUIRED_SCOPES],
    revision: KLAVIYO_REVISION,
  };
}

/**
 * Save (or replace) the org's key, sealed. Re-saving the SAME key keeps the
 * cursor. A DIFFERENT key starts the profile query over and makes it the quiet
 * first import again: the key cannot tell us whether it belongs to the same
 * provider account, and a key of another account must not inherit a cursor
 * that would skip every one of its profiles older than it. For a rotated key
 * of the same account that costs one re-read, in which every linked profile
 * comes back UNCHANGED. The links stay either way.
 */
export async function saveKlaviyoKey(orgId: string, key: string, actorId: string) {
  const existing = await prisma.externalConnection.findFirst({
    where: { orgId, provider: KLAVIYO_PROVIDER },
    select: { sealedKey: true },
  });
  const keyChanged = !existing || open(existing.sealedKey, KLAVIYO_SECRET_PURPOSE) !== key;
  const data = {
    sealedKey: seal(key, KLAVIYO_SECRET_PURPOSE),
    keyLast4: keyLast4(key),
    connectedById: actorId,
    enabled: true,
    failures: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    ...(keyChanged
      ? {
          profilesSince: null,
          profilesQueryStartedAt: null,
          profilesPageCursor: null,
          profilesErrorFloor: null,
          profilesErrorHolds: null,
          initialSyncDoneAt: null,
        }
      : {}),
  };
  return prisma.externalConnection.upsert({
    where: { orgId_provider: { orgId, provider: KLAVIYO_PROVIDER } },
    create: { orgId, provider: KLAVIYO_PROVIDER, ...data },
    update: data,
    select: VIEW_SELECT,
  });
}

export async function setKlaviyoEnabled(orgId: string, enabled: boolean): Promise<boolean> {
  const { count } = await prisma.externalConnection.updateMany({
    where: { orgId, provider: KLAVIYO_PROVIDER },
    // Switching back on clears the backoff so the next tick tries at once.
    data: enabled ? { enabled, failures: 0, nextAttemptAt: null } : { enabled },
  });
  return count > 0;
}

/**
 * Disconnect: the key and the live links go; the accounts and leads stay. An
 * erasure tombstone stays too (its connection is set null), so a later
 * reconnect still SKIPS the erased person's profile.
 */
export async function deleteKlaviyoConnection(orgId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.externalConnection.findFirst({ where: { orgId, provider: KLAVIYO_PROVIDER }, select: { id: true } });
    if (!row) return false;
    await tx.externalProfileLink.deleteMany({ where: { orgId, connectionId: row.id, erasedAt: null } });
    const { count } = await tx.externalConnection.deleteMany({ where: { id: row.id, orgId } });
    return count > 0;
  });
}

/** The org's saved key, opened — for "Test connection" without pasting it again. */
export async function savedKlaviyoKey(orgId: string): Promise<string | null> {
  const row = await prisma.externalConnection.findFirst({
    where: { orgId, provider: KLAVIYO_PROVIDER },
    select: { sealedKey: true },
  });
  return row ? open(row.sealedKey, KLAVIYO_SECRET_PURPOSE) : null;
}

export { testKlaviyoKey };

// ── One page through the import engine ───────────────────────────────────────

interface CompanyRow {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  country: string | null;
}

interface LeadRow {
  id: string;
  email: string;
  companyId: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  sourceId: string | null;
  referredById: string | null;
}

/** What the diff decided about one profile. */
export interface KlaviyoPlan {
  lead: KlaviyoLead;
  sourceName: string | null;
  /** The account a profile resolves to, when it already exists. */
  companyId: string | null;
  leadUserId: string | null;
  /** How it was found: 'link' | 'lead' | 'contact' | 'new'. */
  via: 'link' | 'lead' | 'contact' | 'new';
  linkId: string | null;
  companyChanges: Record<string, string>;
  leadChanges: Record<string, string>;
  /** The lead has no referrer yet, so the Source is written (first touch). */
  fillSource: boolean;
  linkChanged: boolean;
  withheld: string[];
}

interface PageContext {
  orgId: string;
  connectionId: string;
  owner: MarketingImportOwner;
  startStage: string;
  listNames: ReadonlyMap<string, string>;
}

function sourceNameOf(lead: KlaviyoLead): string | null {
  const result = leadSourceName(lead.sourceInput);
  return result.kind === 'unknown' ? null : result.name;
}

function consentText(lead: KlaviyoLead): string | null {
  return lead.consent ? JSON.stringify(lead.consent) : null;
}

/** The provider-owned columns of a link, as written. */
function linkData(plan: Pick<KlaviyoPlan, 'lead' | 'sourceName'>) {
  return {
    emailHash: profileEmailHash(plan.lead.email),
    sourceName: plan.sourceName,
    consent: consentText(plan.lead),
    attributes: plan.lead.attributesText,
    profileUpdatedAt: plan.lead.updatedAt,
  };
}

/** The fields of an account this connector may fill, by the one overwrite policy. */
function incomingCompany(lead: KlaviyoLead) {
  return {
    contactName: lead.fullName || undefined,
    contactEmail: lead.email || undefined,
    contactPhone: lead.phone || undefined,
    country: lead.country || undefined,
  };
}

function incomingLead(lead: KlaviyoLead) {
  return { phone: lead.phone || undefined, city: lead.city || undefined, country: lead.country || undefined };
}

/** The new-account row of the marketing import contract for one profile. */
function accountFields(plan: KlaviyoPlan, startStage: string, name: string): ManualAccountFields {
  const { lead } = plan;
  return {
    name,
    ...(lead.country ? { country: lead.country } : {}),
    ...(lead.fullName ? { contactName: lead.fullName } : {}),
    ...(lead.email ? { contactEmail: lead.email } : {}),
    ...(lead.phone ? { contactPhone: lead.phone } : {}),
    ...(lead.city ? { city: lead.city } : {}),
    ...(plan.sourceName ? { source: plan.sourceName } : {}),
    stage: startStage,
  };
}

/** Why a tombstoned profile is skipped (src/lib/externalProfileErasure.ts). */
export const ERASED_REASON = 'the person this profile describes was erased';

/**
 * Whether a profile speaks for an existing account's contact. `named`: the
 * account's contact address IS this profile's, so its record's lead is this
 * person. `mayFill`: the profile may fill the account's empty contact columns —
 * it is the contact, or the account names nobody (a scrubbed or a typed-in
 * account), in which case this person becomes its contact.
 */
function isAccountContact(company: CompanyRow, email: string): { named: boolean; mayFill: boolean } {
  const theirs = (company.contactEmail ?? '').trim().toLowerCase();
  const named = Boolean(email && theirs && theirs === email);
  return { named, mayFill: named || !theirs };
}

async function resolvePage(
  ctx: PageContext,
  rows: { row: number; key: string; value: KlaviyoLead }[],
): Promise<{ plan: PlannedRow<KlaviyoPlan>[]; absent: string[] }> {
  const { orgId } = ctx;
  const ids = rows.map((r) => r.value.profileId);
  const emails = [...new Set(rows.map((r) => r.value.email).filter(Boolean))];
  const standIns = emails.map((e) => leadStandInEmail(e, orgId));

  const [links, leadsByEmail, companiesByEmail] = await Promise.all([
    prisma.externalProfileLink.findMany({
      // This connection's links, plus the org's erasure tombstones from any
      // connection (one made before a disconnect has none).
      where: {
        orgId,
        provider: KLAVIYO_PROVIDER,
        externalId: { in: ids },
        OR: [{ connectionId: ctx.connectionId }, { erasedAt: { not: null } }],
      },
      select: {
        id: true,
        externalId: true,
        companyId: true,
        leadUserId: true,
        sourceName: true,
        consent: true,
        attributes: true,
        emailHash: true,
        erasedAt: true,
      },
    }),
    emails.length
      ? prisma.user.findMany({
          where: { orgId, role: 'MENTEE', email: { in: [...emails, ...standIns] } },
          select: { id: true, email: true, companyId: true },
        })
      : Promise.resolve([] as { id: string; email: string; companyId: string | null }[]),
    emails.length
      ? prisma.company.findMany({ where: { orgId, contactEmail: { in: emails } }, select: { id: true, contactEmail: true } })
      : Promise.resolve([] as { id: string; contactEmail: string | null }[]),
  ]);
  const linkById = new Map<string, (typeof links)[number]>();
  for (const l of links) {
    // A tombstone wins over a live link of the same profile.
    if (!linkById.get(l.externalId)?.erasedAt) linkById.set(l.externalId, l);
  }
  const leadByEmail = new Map(leadsByEmail.map((u) => [u.email.toLowerCase(), u]));
  const companiesForEmail = new Map<string, string[]>();
  for (const c of companiesByEmail) {
    const k = (c.contactEmail ?? '').toLowerCase();
    companiesForEmail.set(k, [...(companiesForEmail.get(k) ?? []), c.id]);
  }

  // First pass: which account each profile resolves to.
  const resolved = rows.map((r) => {
    const lead = r.value;
    const link = linkById.get(lead.profileId) ?? null;
    // The person was erased (src/lib/externalProfileErasure.ts): never again.
    if (link?.erasedAt) return { r, link, companyId: null, leadUserId: null, via: 'erased' as const };
    if (link?.companyId) return { r, link, companyId: link.companyId, leadUserId: link.leadUserId, via: 'link' as const };
    if (lead.email) {
      const person = leadByEmail.get(leadStandInEmail(lead.email, orgId)) ?? leadByEmail.get(lead.email);
      if (person?.companyId) return { r, link, companyId: person.companyId, leadUserId: person.id, via: 'lead' as const };
      const byContact = companiesForEmail.get(lead.email) ?? [];
      if (byContact.length === 1) return { r, link, companyId: byContact[0], leadUserId: person?.id ?? null, via: 'contact' as const };
    }
    return { r, link, companyId: null, leadUserId: null, via: 'new' as const };
  });

  const companyIds = [...new Set(resolved.map((x) => x.companyId).filter((id): id is string => Boolean(id)))];
  const companies: CompanyRow[] = companyIds.length
    ? await prisma.company.findMany({
        where: { orgId, id: { in: companyIds } },
        select: { id: true, name: true, contactName: true, contactEmail: true, contactPhone: true, country: true },
      })
    : [];
  const companyById = new Map(companies.map((c) => [c.id, c]));
  // The lead of an adopted account that the address did not name: its active
  // record's lead, else none (only the account is then filled).
  const missingLead = resolved.filter((x) => x.companyId && !x.leadUserId).map((x) => x.companyId as string);
  const relationLeads = missingLead.length
    ? await prisma.mentorshipRelation.findMany({
        where: { orgId, companyId: { in: missingLead }, status: 'ACTIVE' },
        select: { companyId: true, menteeId: true },
      })
    : [];
  const leadOfCompany = new Map(relationLeads.map((r) => [r.companyId as string, r.menteeId]));
  const leadIds = [
    ...new Set(
      resolved
        .map((x) => x.leadUserId ?? (x.companyId ? leadOfCompany.get(x.companyId) ?? null : null))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const leadUsers: LeadRow[] = leadIds.length
    ? await prisma.user.findMany({
        where: { orgId, id: { in: leadIds } },
        select: { id: true, email: true, companyId: true, phone: true, city: true, country: true, sourceId: true, referredById: true },
      })
    : [];
  const leadById = new Map(leadUsers.map((u) => [u.id, u]));

  const seen = new Set<string>();
  const plan: PlannedRow<KlaviyoPlan>[] = [];
  for (const x of resolved) {
    const lead = x.r.value;
    const sourceName = sourceNameOf(lead);
    const base: KlaviyoPlan = {
      lead,
      sourceName,
      companyId: x.companyId,
      leadUserId: null,
      via: x.via === 'erased' ? 'link' : x.via,
      linkId: x.link?.id ?? null,
      companyChanges: {},
      leadChanges: {},
      fillSource: false,
      linkChanged: true,
      withheld: [],
    };
    if (seen.has(lead.profileId)) {
      plan.push({ row: x.r.row, key: x.r.key, status: 'SKIP', reason: 'the same profile appears twice in one page', value: base });
      continue;
    }
    seen.add(lead.profileId);
    if (x.via === 'erased') {
      plan.push({ row: x.r.row, key: x.r.key, status: 'SKIP', reason: ERASED_REASON, value: { ...base, via: 'link', companyId: null } });
      continue;
    }

    const company = x.companyId ? companyById.get(x.companyId) : undefined;
    if (!x.companyId || !company) {
      plan.push({ row: x.r.row, key: x.r.key, status: 'CREATE', value: { ...base, via: 'new', companyId: null } });
      continue;
    }
    // Is this profile the account's own contact? A second person of the same
    // organization (linked by the account's NAME) is not: their profile must
    // never fill the contact's line, nor the lead and first touch of the
    // account's record — that lead is somebody else.
    const contact = isAccountContact(company, lead.email);
    const leadUserId = x.leadUserId ?? (contact.named ? (leadOfCompany.get(company.id) ?? null) : null);
    const leadUser = leadUserId ? leadById.get(leadUserId) : undefined;

    const companyPlan = contact.mayFill
      ? planFieldUpdates<Record<string, string | null>>(
          { contactName: company.contactName, contactEmail: company.contactEmail, contactPhone: company.contactPhone, country: company.country },
          incomingCompany(lead),
          { authoritative: false },
        )
      : { changes: {}, changed: [] as string[], withheld: [] as string[] };
    const leadPlan = leadUser
      ? planFieldUpdates<Record<string, string | null>>(
          { phone: leadUser.phone, city: leadUser.city, country: leadUser.country },
          incomingLead(lead),
          { authoritative: false },
        )
      : { changes: {}, changed: [] as string[], withheld: [] as string[] };
    const fillSource = Boolean(leadUser && sourceName && !leadUser.sourceId && !leadUser.referredById);
    const wanted = linkData({ lead, sourceName });
    const linkChanged =
      !x.link ||
      x.link.companyId !== company.id ||
      (x.link.leadUserId ?? null) !== (leadUser?.id ?? null) ||
      x.link.sourceName !== wanted.sourceName ||
      x.link.consent !== wanted.consent ||
      x.link.attributes !== wanted.attributes ||
      (x.link.emailHash ?? null) !== wanted.emailHash;

    const changed = [
      ...companyPlan.changed.map((f) => `account.${f}`),
      ...leadPlan.changed.map((f) => `lead.${f}`),
      ...(fillSource ? ['lead.source'] : []),
      ...(linkChanged ? ['profile'] : []),
    ];
    const withheld = [...companyPlan.withheld.map((f) => `account.${f}`), ...leadPlan.withheld.map((f) => `lead.${f}`)];
    const reasons = [
      x.via === 'lead' ? 'matched an existing lead by e-mail' : x.via === 'contact' ? 'matched an existing account by contact e-mail' : '',
      contact.mayFill ? '' : 'another contact of this account',
      withheld.length ? `left alone: ${withheld.join(', ')}` : '',
    ].filter(Boolean);
    plan.push({
      row: x.r.row,
      key: x.r.key,
      status: changed.length ? 'UPDATE' : 'UNCHANGED',
      changed,
      targetId: company.id,
      ...(reasons.length ? { reason: reasons.join('; ') } : {}),
      value: {
        ...base,
        companyId: company.id,
        leadUserId: leadUser?.id ?? null,
        companyChanges: companyPlan.changes as Record<string, string>,
        leadChanges: leadPlan.changes as Record<string, string>,
        fillSource,
        linkChanged,
        withheld,
      },
    });
  }
  return { plan, absent: [] };
}

/** Write (or re-point) a profile's link, inside the caller's transaction or not. */
async function upsertLink(
  db: Prisma.TransactionClient | typeof prisma,
  ctx: PageContext,
  plan: KlaviyoPlan,
  companyId: string,
  leadUserId: string | null,
) {
  const data = { companyId, leadUserId, ...linkData(plan) };
  await db.externalProfileLink.upsert({
    where: { connectionId_externalId: { connectionId: ctx.connectionId, externalId: plan.lead.profileId } },
    create: { orgId: ctx.orgId, connectionId: ctx.connectionId, provider: KLAVIYO_PROVIDER, externalId: plan.lead.profileId, ...data },
    update: data,
  });
}

/** An existing account: gap-fill, first-touch source, link — one transaction. */
async function applyUpdate(ctx: PageContext, row: PlannedRow<KlaviyoPlan>): Promise<void> {
  const plan = row.value;
  const companyId = plan.companyId;
  if (!companyId) throw new Error('an UPDATE row reached the writer without an account');
  // Resolved outside the transaction (findOrCreateSource answers its own
  // unique-index race); a rolled-back row leaves at most an unused Source.
  const sourceId = plan.fillSource && plan.sourceName ? (await findOrCreateSource(ctx.orgId, plan.sourceName)).id : null;
  await prisma.$transaction(async (tx) => {
    if (Object.keys(plan.companyChanges).length) {
      await tx.company.updateMany({ where: { id: companyId, orgId: ctx.orgId }, data: plan.companyChanges });
    }
    if (plan.leadUserId && Object.keys(plan.leadChanges).length) {
      await tx.user.updateMany({ where: { id: plan.leadUserId, orgId: ctx.orgId }, data: plan.leadChanges });
    }
    if (sourceId && plan.leadUserId) {
      // First touch (#2570): conditional, so a referrer set meanwhile wins.
      await tx.user.updateMany({
        where: { id: plan.leadUserId, orgId: ctx.orgId, sourceId: null, referredById: null },
        data: { sourceId },
      });
    }
    if (plan.linkChanged) await upsertLink(tx, ctx, plan, companyId, plan.leadUserId);
  });
}

/** The lead (stand-in) a just-created account received, by its derived address. */
async function standInLeads(orgId: string, emails: string[]): Promise<Map<string, string>> {
  if (!emails.length) return new Map();
  const standIns = emails.map((e) => leadStandInEmail(e, orgId));
  const users = await prisma.user.findMany({
    where: { orgId, role: 'MENTEE', email: { in: standIns } },
    select: { id: true, email: true, companyId: true },
  });
  const byStandIn = new Map(users.map((u) => [u.email, u]));
  const out = new Map<string, string>();
  for (const e of emails) {
    const u = byStandIn.get(leadStandInEmail(e, orgId));
    if (u) out.set(e, u.id);
  }
  return out;
}

/** At most this many writer passes per chunk; what is left is an ERROR, retried next query. */
const MAX_CREATE_PASSES = 8;

/**
 * The CREATE rows of one chunk, through the marketing import's create-only
 * writer, pass by pass:
 *   • ONE row per account name goes into a pass. The writer refuses a second
 *     row for the same account in one file ("duplicate account in file"), and
 *     two people of the same organization signing up between two syncs are
 *     exactly that — so the second waits for the next pass, where the first
 *     one's account exists and the name match links them to it.
 *   • a person-only account whose plain name is already another contact's is
 *     retried once under a disambiguated name (two "Jane Doe"s are two leads).
 * Nothing is dropped silently: a row still unplaced after the last pass is an
 * ERROR, which holds the cursor so the next query reads it again.
 */
async function applyCreates(
  ctx: PageContext,
  rows: PlannedRow<KlaviyoPlan>[],
  dryRun: boolean,
): Promise<RowResult<KlaviyoPlan>[]> {
  type Pending = { row: PlannedRow<KlaviyoPlan>; name: string; disambiguated: boolean };
  const results = new Map<number, RowResult<KlaviyoPlan>>();
  let pending: Pending[] = rows.map((row) => ({ row, name: row.value.lead.accountName, disambiguated: false }));
  // A dry run writes nothing, so a later pass cannot find the account an
  // earlier pass "created": remember them by name key and answer the way the
  // real run's next pass would (link to it, or retry under a person's name).
  const plannedByName = new Map<string, string>();
  const link = (plan: KlaviyoPlan, companyId: string, leadUserId: string | null) =>
    dryRun ? Promise.resolve() : upsertLink(prisma, ctx, plan, companyId, leadUserId).then(() => undefined);

  for (let pass = 0; pass < MAX_CREATE_PASSES && pending.length; pass++) {
    const batch: Pending[] = [];
    const deferred: Pending[] = [];
    const names = new Set<string>();
    for (const p of pending) {
      const k = normalizeNameKey(p.name);
      const plannedContact = plannedByName.get(k);
      if (plannedContact !== undefined) {
        const plan = p.row.value;
        if (plan.lead.accountNameIsOrganization || !plannedContact || plannedContact === plan.lead.email) {
          results.set(p.row.row, {
            row: p.row.row,
            key: p.row.key,
            status: 'UPDATE',
            targetId: null,
            reason: 'matched an account this sync creates',
            value: { ...plan, companyId: null, leadUserId: null },
          });
        } else if (!p.disambiguated) {
          deferred.push({ row: p.row, name: disambiguatedAccountName(plan.lead), disambiguated: true });
        } else {
          results.set(p.row.row, { row: p.row.row, key: p.row.key, status: 'ERROR', targetId: null, reason: 'an account of this name already exists for another contact', value: plan });
        }
        continue;
      }
      if (names.has(k)) deferred.push(p);
      else {
        names.add(k);
        batch.push(p);
      }
    }
    const report = await createMarketingAccountsBatch({
      owner: ctx.owner,
      rows: batch.map((p) => accountFields(p.row.value, ctx.startStage, p.name)),
      createdBySource: KLAVIYO_CREATED_BY,
      dryRun,
    });
    const leadIds = await standInLeads(
      ctx.orgId,
      batch.map((p) => p.row.value.lead.email).filter(Boolean),
    );
    const retry: Pending[] = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const { row } = item;
      const plan = row.value;
      const outcome = report.rows.find((r) => r.row === i + 1);
      const leadUserId = plan.lead.email ? (leadIds.get(plan.lead.email) ?? null) : null;
      const done = (status: RowStatus, companyId: string | null, reason?: string) =>
        results.set(row.row, {
          row: row.row,
          key: row.key,
          status,
          targetId: companyId,
          ...(reason ? { reason } : {}),
          value: { ...plan, companyId, leadUserId },
        });
      if (!outcome) {
        done('ERROR', null, 'the account writer reported nothing for this profile');
        continue;
      }
      const marketReason = outcome.reason;
      if (outcome.status === 'CREATE' && dryRun) {
        plannedByName.set(normalizeNameKey(item.name), plan.lead.email ?? '');
        done('CREATE', null, marketReason);
        continue;
      }
      if (outcome.status === 'CREATE' && outcome.targetId) {
        await link(plan, outcome.targetId, leadUserId);
        done('CREATE', outcome.targetId, marketReason);
        continue;
      }
      if ((outcome.status === 'UPDATE' || outcome.status === 'UNCHANGED') && outcome.targetId) {
        // The match key found an existing account by its name (or VAT). The
        // same organization name is the same company: link to it. A person's
        // name is not an identity — two "Jane Doe"s are two leads. A link made
        // for ANOTHER person of that company carries no lead of its own, and
        // resolvePage() never lets it fill the account's contact or record.
        const existing = await prisma.company.findFirst({
          where: { id: outcome.targetId, orgId: ctx.orgId },
          select: { contactEmail: true },
        });
        const sameContact = !existing?.contactEmail || existing.contactEmail.toLowerCase() === plan.lead.email;
        if (plan.lead.accountNameIsOrganization || sameContact) {
          await link(plan, outcome.targetId, leadUserId);
          done('UPDATE', outcome.targetId, 'matched an existing account by name');
        } else if (!item.disambiguated) {
          retry.push({ row, name: disambiguatedAccountName(plan.lead), disambiguated: true });
        } else {
          done('ERROR', null, 'an account of this name already exists for another contact');
        }
        continue;
      }
      if (outcome.status === 'SKIP' && outcome.reason === CONTACT_IN_FUNNEL) {
        // Raced in since the plan: the contact is on the funnel now. Link to the
        // account its record is on rather than open a second record.
        const leadId = outcome.value?.funnel?.leadId ?? leadUserId;
        const lead = leadId
          ? await prisma.user.findFirst({ where: { id: leadId, orgId: ctx.orgId }, select: { companyId: true } })
          : null;
        if (lead?.companyId) {
          await link(plan, lead.companyId, leadId);
          done('UPDATE', lead.companyId, 'matched an existing lead by e-mail');
        } else {
          done('SKIP', null, CONTACT_IN_FUNNEL);
        }
        continue;
      }
      if (outcome.status === 'SKIP' && (marketReason ?? '').startsWith('duplicate account in file')) {
        // The writer's account key is looser than the name key above (VAT,
        // country): same treatment — the next pass, once the first one exists.
        retry.push(item);
        continue;
      }
      done(outcome.status === 'SKIP' ? 'SKIP' : 'ERROR', null, marketReason ?? 'refused by the account writer');
    }
    pending = [...retry, ...deferred];
  }
  for (const { row } of pending) {
    results.set(row.row, {
      row: row.row,
      key: row.key,
      status: 'ERROR',
      targetId: null,
      reason: 'not placed in this run; the next sync reads it again',
      value: row.value,
    });
  }
  return rows.map((row) => results.get(row.row) as RowResult<KlaviyoPlan>);
}

/**
 * One page of profiles through the shared engine. `dryRun` = the same plan and
 * the same report, and a writer that writes nothing.
 */
export async function syncProfilesPage(
  ctx: PageContext,
  profiles: unknown[],
  options: { dryRun: boolean },
): Promise<ImportReport<KlaviyoPlan>> {
  return runImport<KlaviyoLead, KlaviyoPlan>({
    // The page IS the table: one row per profile, the provider's JSON as its
    // only cell. The mapping is the validator's job, so a dry run and an
    // apply read a profile identically.
    parse: () => ({
      header: ['profile'],
      rows: profiles.map((p, i) => ({ row: i + 1, values: [JSON.stringify(p ?? null)] })),
      delimiter: ',',
    }),
    validate: (row) => {
      let resource: unknown;
      try {
        resource = JSON.parse(row.values[0] ?? 'null');
      } catch {
        return { ok: false, row: row.row, key: '?', status: 'ERROR', reason: 'unreadable profile' };
      }
      const mapped = mapProfile(resource, ctx.listNames);
      if (!mapped.ok) return { ok: false, row: row.row, key: mapped.key, status: 'SKIP', reason: mapped.reason };
      return { ok: true, row: row.row, key: mapped.lead.profileId, value: mapped.lead };
    },
    resolve: (rows) => resolvePage(ctx, rows),
    // ONE writer for the run and the preview (#1432): creates go through the
    // same account writer in its preview mode, so a profile that the real run
    // would link to an existing account by name previews as that UPDATE too.
    apply: async (chunk, { dryRun }) => {
      const creates = chunk.filter((r) => r.status === 'CREATE');
      const created = creates.length ? await applyCreates(ctx, creates, dryRun) : [];
      const createdByRow = new Map(created.map((r) => [r.row, r]));
      const out: RowResult<KlaviyoPlan>[] = [];
      for (const row of chunk) {
        if (row.status === 'CREATE') {
          out.push(createdByRow.get(row.row) as RowResult<KlaviyoPlan>);
          continue;
        }
        if (row.status === 'UPDATE') {
          try {
            if (!dryRun) await applyUpdate(ctx, row);
            out.push({ row: row.row, key: row.key, status: 'UPDATE', targetId: row.targetId ?? null, changed: row.changed ?? [], ...(row.reason ? { reason: row.reason } : {}), value: row.value });
          } catch (error) {
            out.push({ row: row.row, key: row.key, status: 'ERROR', reason: importErrorMessage(error), value: row.value });
          }
          continue;
        }
        out.push({ row: row.row, key: row.key, status: row.status, targetId: row.targetId ?? null, ...(row.reason ? { reason: row.reason } : {}), value: row.value });
      }
      return out;
    },
    dryRun: options.dryRun,
  });
}

// ── The run ──────────────────────────────────────────────────────────────────

export type KlaviyoRunOutcome =
  | 'ok'
  | 'partial'
  | 'error'
  /** Another run of this connection holds the lease. */
  | 'busy'
  | 'disabled'
  | 'missing';

export interface KlaviyoRunResult {
  outcome: KlaviyoRunOutcome;
  code?: KlaviyoErrorCode;
  pages: number;
  counts: Record<RowStatus, number>;
  /** This run was (part of) the silent first import. */
  initial: boolean;
  /** The first import finished in this run. */
  initialCompleted: boolean;
}

/** The oldest provider `updated` among a page's ERROR rows, or null. */
function oldestErrored(rows: RowResult<KlaviyoPlan>[]): Date | null {
  let oldest: Date | null = null;
  for (const r of rows) {
    const at = r.status === 'ERROR' ? r.value?.lead.updatedAt : null;
    if (at && (!oldest || at < oldest)) oldest = at;
  }
  return oldest;
}

/** Who owns a new lead: the org's default lead owner, else the admin who connected. */
async function leadOwnerFor(orgId: string, connectedById: string | null): Promise<MarketingImportOwner | null> {
  return (await resolveDefaultLeadOwner(orgId)) ?? (connectedById ? await findLeadOwner(orgId, connectedById) : null);
}

/**
 * One sync of one connection: up to `maxPages` pages, each applied and its
 * cursor committed before the next is read, so a run cut off anywhere resumes
 * at the next page. Never throws for a provider failure — it records a code
 * and a backoff on the connection.
 */
export async function runKlaviyoSync(
  connectionId: string,
  opts: { trigger: 'schedule' | 'manual'; maxPages?: number; now?: () => Date; client?: KlaviyoClientOptions } = { trigger: 'schedule' },
): Promise<KlaviyoRunResult> {
  const counts = emptyCounts();
  const empty = (outcome: KlaviyoRunOutcome): KlaviyoRunResult => ({ outcome, pages: 0, counts, initial: false, initialCompleted: false });
  const lease = klaviyoLeaseName(connectionId);
  const holder = `${replicaId().slice(0, 150)}:${randomUUID()}`;
  if (!(await acquireLease(lease, holder, KLAVIYO_LEASE_TTL_MS, { store: prismaLeaseStore() }))) return empty('busy');
  try {
    const row = await runWithOrg(null, () =>
      prisma.externalConnection.findUnique({
        where: { id: connectionId },
        select: {
          id: true,
          orgId: true,
          enabled: true,
          sealedKey: true,
          connectedById: true,
          profilesSince: true,
          profilesQueryStartedAt: true,
          profilesPageCursor: true,
          profilesErrorFloor: true,
          profilesErrorHolds: true,
          initialSyncDoneAt: true,
          failures: true,
          totalCreated: true,
        },
      }),
    );
    if (!row) return empty('missing');
    if (!row.enabled) return empty('disabled');
    return await runWithOrg(row.orgId, () => runLocked(row, opts, counts));
  } finally {
    await releaseLease(lease, holder, { store: prismaLeaseStore() });
  }
}

async function runLocked(
  row: {
    id: string;
    orgId: string;
    sealedKey: string;
    connectedById: string | null;
    profilesSince: Date | null;
    profilesQueryStartedAt: Date | null;
    profilesPageCursor: string | null;
    profilesErrorFloor: Date | null;
    profilesErrorHolds: number | null;
    initialSyncDoneAt: Date | null;
    failures: number;
    totalCreated: number;
  },
  opts: { trigger: 'schedule' | 'manual'; maxPages?: number; now?: () => Date; client?: KlaviyoClientOptions },
  counts: Record<RowStatus, number>,
): Promise<KlaviyoRunResult> {
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock();
  const { orgId } = row;
  const initial = !row.initialSyncDoneAt;
  let pages = 0;
  let initialCompleted = false;

  const fail = async (code: KlaviyoErrorCode, retryAfter: number | null = null): Promise<KlaviyoRunResult> => {
    const failures = row.failures + 1;
    const at = clock();
    await prisma.externalConnection.updateMany({
      where: { id: row.id, orgId, sealedKey: row.sealedKey },
      data: {
        lastSyncAt: at,
        lastStatus: 'error',
        lastErrorCode: code,
        failures,
        nextAttemptAt: new Date(at.getTime() + nextAttemptDelayMs(failures, retryAfter)),
        lastCreated: counts.CREATE,
        lastUpdated: counts.UPDATE,
        lastUnchanged: counts.UNCHANGED,
        lastSkipped: counts.SKIP,
        lastErrors: counts.ERROR,
        totalCreated: row.totalCreated + counts.CREATE,
      },
    });
    logger.warning('klaviyo sync failed', { connectionId: row.id, orgId, code, pages });
    return { outcome: 'error', code, pages, counts, initial, initialCompleted };
  };

  // The connector serves the MARKETING product only; an org moved to another
  // vertical keeps its row but imports nothing.
  if ((await verticalFor(orgId)) !== 'MARKETING') return { outcome: 'disabled', pages: 0, counts, initial, initialCompleted };

  const key = open(row.sealedKey, KLAVIYO_SECRET_PURPOSE);
  if (!key) return fail('key_unreadable');
  const owner = await leadOwnerFor(orgId, row.connectedById);
  if (!owner) return fail('no_owner');

  try {
    const stages = await resolvePipelineStages(orgId);
    const listNames = await fetchListNames(key, opts.client);
    const ctx: PageContext = { orgId, connectionId: row.id, owner, startStage: startStageKey(stages), listNames };
    let cursor: ProfilesCursor = beginQuery(
      {
        since: row.profilesSince,
        queryStartedAt: row.profilesQueryStartedAt,
        pageCursor: row.profilesPageCursor,
        errorFloor: row.profilesErrorFloor,
        errorHolds: row.profilesErrorHolds,
      },
      startedAt,
    );
    const maxPages = opts.maxPages ?? (opts.trigger === 'manual' ? KLAVIYO_PAGES_PER_MANUAL_RUN : KLAVIYO_PAGES_PER_RUN);
    let restarted = false;

    while (pages < maxPages && clock().getTime() - startedAt.getTime() < RUN_TIME_BUDGET_MS) {
      const page = await fetchProfilesPage(key, { since: cursor.since, cursor: cursor.pageCursor }, opts.client);
      if (!page.ok) {
        // A stale page cursor: restart the open query from its `since`. Every
        // profile re-read comes back UNCHANGED, so nothing is lost or doubled.
        if (page.code === 'bad_request' && cursor.pageCursor && !restarted) {
          restarted = true;
          cursor = restartQuery(cursor);
          continue;
        }
        return fail(page.code, page.retryAfterMs ?? null);
      }
      const report = await syncProfilesPage(ctx, page.data.profiles, { dryRun: false });
      for (const [status, n] of Object.entries(report.counts)) counts[status as RowStatus] += n;
      pages += 1;
      // A row that failed is read again by the next query (afterPage), so it is
      // retried rather than left behind the cursor for good.
      const step = afterPage(cursor, page.data.nextCursor, oldestErrored(report.rows));
      cursor = step.cursor;
      const completesInitial = step.queryDone && initial;
      // Guarded on the key this run opened: a key saved (or the connection
      // dropped) mid-run reset the cursor, and this run must not write the
      // old account's position over that reset — it stops instead.
      const { count: kept } = await prisma.externalConnection.updateMany({
        where: { id: row.id, orgId, sealedKey: row.sealedKey },
        data: {
          profilesSince: cursor.since,
          profilesQueryStartedAt: cursor.queryStartedAt,
          profilesPageCursor: cursor.pageCursor,
          profilesErrorFloor: cursor.errorFloor ?? null,
          profilesErrorHolds: cursor.errorHolds ?? null,
          ...(completesInitial ? { initialSyncDoneAt: clock() } : {}),
        },
      });
      if (kept === 0) return { outcome: 'missing', pages, counts, initial, initialCompleted: false };
      if (completesInitial) initialCompleted = true;
      if (step.queryDone) break;
    }
  } catch (error) {
    // The error's name only: a Prisma error's message can quote the call's
    // arguments, which here carry a lead's address and phone.
    logger.error('klaviyo sync threw', { connectionId: row.id, orgId, error: error instanceof Error ? error.name : 'unknown' });
    return fail('internal');
  }

  const outcome: KlaviyoRunOutcome = counts.ERROR > 0 ? 'partial' : 'ok';
  const at = clock();
  await prisma.externalConnection.updateMany({
    where: { id: row.id, orgId, sealedKey: row.sealedKey },
    data: {
      lastSyncAt: at,
      lastSyncOkAt: at,
      lastStatus: outcome,
      lastErrorCode: null,
      failures: 0,
      nextAttemptAt: null,
      lastCreated: counts.CREATE,
      lastUpdated: counts.UPDATE,
      lastUnchanged: counts.UNCHANGED,
      lastSkipped: counts.SKIP,
      lastErrors: counts.ERROR,
      totalCreated: row.totalCreated + counts.CREATE,
    },
  });

  // One aggregated activity line — counts only, never a name or an address.
  // The silent first import writes it once, when it completes.
  const total = row.totalCreated + counts.CREATE;
  if (initial ? initialCompleted : counts.CREATE + counts.UPDATE + counts.ERROR > 0) {
    await logActivity({
      action: initial ? 'integration.klaviyo.initial_import' : 'integration.klaviyo.sync',
      orgId,
      actorId: null,
      targetType: 'ExternalConnection',
      targetId: row.id,
      detail: initial
        ? `created=${total} (first import complete)`
        : `trigger=${opts.trigger} pages=${pages} ${Object.entries(counts).map(([s, n]) => `${s}=${n}`).join(' ')}`,
    });
  }
  // The owner's bell, once per run — never during the silent first import.
  if (!initial && counts.CREATE > 0) {
    // An ADMIN reads the filtered accounts list; a sales rep (MENTOR, the other
    // lead-owner role) has no admin shell — their door is their own accounts.
    const href = owner.role === 'ADMIN' ? '/admin/companies?source=klaviyo' : '/sales/accounts';
    await notify(owner.id, 'integration.newLeads', { count: counts.CREATE, provider: 'Klaviyo' }, href);
  }
  return { outcome, pages, counts, initial, initialCompleted };
}

/** The admin screen's preview: the first profiles mapped by the same engine, nothing written. */
export async function previewKlaviyo(orgId: string, opts: { client?: KlaviyoClientOptions } = {}) {
  return runWithOrg(orgId, async () => {
    const row = await prisma.externalConnection.findFirst({
      where: { orgId, provider: KLAVIYO_PROVIDER },
      select: { id: true, sealedKey: true, connectedById: true },
    });
    if (!row) return { ok: false as const, code: 'not_connected' };
    const key = open(row.sealedKey, KLAVIYO_SECRET_PURPOSE);
    if (!key) return { ok: false as const, code: 'key_unreadable' };
    const owner = await leadOwnerFor(orgId, row.connectedById);
    if (!owner) return { ok: false as const, code: 'no_owner' };
    const page = await fetchProfilesPage(key, { since: null, cursor: null, pageSize: KLAVIYO_PREVIEW_MAX }, opts.client);
    if (!page.ok) return { ok: false as const, code: page.code };
    const stages = await resolvePipelineStages(orgId);
    const listNames = await fetchListNames(key, opts.client);
    const report = await syncProfilesPage(
      { orgId, connectionId: row.id, owner, startStage: startStageKey(stages), listNames },
      page.data.profiles,
      { dryRun: true },
    );
    return {
      ok: true as const,
      counts: report.counts,
      rows: report.rows.map((r) => ({
        row: r.row,
        status: r.status,
        reason: r.reason ?? null,
        changed: r.changed ?? [],
        accountName: r.value?.lead.accountName ?? null,
        contactName: r.value?.lead.fullName || null,
        email: r.value?.lead.email || null,
        source: r.value?.sourceName ?? null,
        consent: r.value?.lead.consent?.email?.consent ?? null,
      })),
    };
  });
}

// ── The schedule ─────────────────────────────────────────────────────────────

/**
 * One tick: every enabled connection whose backoff has elapsed, one after the
 * other, each in its own try — a connection that throws is logged and the next
 * one runs. Counters only in the return value.
 */
export async function runKlaviyoTick(opts: { now?: () => Date; client?: KlaviyoClientOptions } = {}) {
  const clock = opts.now ?? (() => new Date());
  const rows = await runWithOrg(null, () =>
    prisma.externalConnection.findMany({
      where: { provider: KLAVIYO_PROVIDER, enabled: true },
      select: { id: true, nextAttemptAt: true },
      orderBy: { lastSyncAt: 'asc' },
    }),
  );
  const tick = { connections: rows.length, due: 0, ok: 0, failed: 0, busy: 0, created: 0 };
  const started = clock().getTime();
  for (const row of rows) {
    if (!isDue(row.nextAttemptAt, clock())) continue;
    // Bounded tick: what does not fit runs on the next one.
    if (clock().getTime() - started > 10 * 60 * 1000) break;
    tick.due += 1;
    try {
      const r = await runKlaviyoSync(row.id, { trigger: 'schedule', ...(opts.now ? { now: opts.now } : {}), ...(opts.client ? { client: opts.client } : {}) });
      if (r.outcome === 'busy') tick.busy += 1;
      else if (r.outcome === 'error') tick.failed += 1;
      else tick.ok += 1;
      tick.created += r.counts.CREATE;
    } catch (e) {
      tick.failed += 1;
      logger.error('klaviyo sync crashed', { connectionId: row.id, error: e instanceof Error ? e.name : 'unknown' });
    }
  }
  return tick;
}

// Scheduled as the queued job `klaviyo.sync` (src/lib/jobs/schedules.ts,
// handler in src/jobs/platform.ts, #1677): only the 'scheduler' lease holder
// enqueues it, and the per-connection lease makes a second runner harmless
// anyway — it answers `busy` and moves on.

