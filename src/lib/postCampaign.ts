// Postal campaigns — the Prisma half (#2697). The rule is
// src/lib/postCampaignRule.ts; design in docs/marketing-vertical/postal-campaigns.md.
//
// Every write here passes `orgId` itself, and every read is narrowed by the
// caller's TenantWhere: the three models are in TENANT_MODELS, but the
// middleware stamps and filters nothing while MT_ENFORCE_ISOLATION is off
// (docs/agent-experience.md, 2026-09-30).

import { createHmac } from 'crypto';
import type { ContactChannel, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireServerSecret } from '@/lib/serverSecret';
import { logActivity } from '@/lib/activity';
import { revokeContactPermission } from '@/lib/contactPermission';
import { CONTACT_CHANNELS } from '@/lib/contactPermissionRule';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { addressBlock, postIneligibility, suppressionKeys, type PostIneligibility } from '@/lib/postCampaignRule';
import { defaultBalancingNote, resolveLetterBody } from '@/lib/postCampaignTemplates';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { verticalFor } from '@/lib/verticalContext';

/**
 * What a new campaign of this org starts from (#2927): its own saved letter or
 * the vertical's built-in one (`letterSource` says which), and the vertical's
 * balancing note. `orgId` is the settings org (`settingsOrgOf(session)`).
 */
export async function campaignDefaultsFor(orgId: string): Promise<{
  letterBody: string;
  letterSource: 'org' | 'builtin';
  balancingNote: string;
}> {
  const [vertical, stored] = await Promise.all([verticalFor(orgId), resolveSettingRaw('postLetterTemplate', { orgId })]);
  const { letterBody, source } = resolveLetterBody(stored, vertical);
  return { letterBody, letterSource: source, balancingNote: defaultBalancingNote(vertical) };
}

/**
 * The block-list hash of one key. Keyed with the server secret: an unkeyed hash
 * of a VAT id or an e-mail address is reversible by anyone holding a list of
 * them, and the block list must be able to say "blocked" and nothing else.
 */
export function suppressionHash(key: string): string {
  return createHmac('sha256', requireServerSecret()).update(`contact-suppression:${key}`).digest('hex');
}

type CompanyKeys = {
  id: string;
  name: string;
  vatId: string | null;
  country: string | null;
  contactEmail: string | null;
  address: string | null;
};

const COMPANY_KEY_SELECT = { id: true, name: true, vatId: true, country: true, contactEmail: true, address: true } as const;

/** The ids among `companies` that have any key on the block list for `channel`. */
export async function suppressedCompanyIds(
  tenant: TenantWhere,
  companies: CompanyKeys[],
  channel: ContactChannel = 'POST',
): Promise<Set<string>> {
  const byHash = new Map<string, string[]>();
  for (const c of companies) {
    for (const key of suppressionKeys(c)) {
      const h = suppressionHash(key);
      byHash.set(h, [...(byHash.get(h) ?? []), c.id]);
    }
  }
  if (byHash.size === 0) return new Set();
  const hits = await prisma.contactSuppression.findMany({
    where: withinTenant({ channel, keyHash: { in: [...byHash.keys()] } }, tenant),
    select: { keyHash: true },
  });
  return new Set(hits.flatMap((h) => byHash.get(h.keyHash) ?? []));
}

/**
 * The owner objected to direct marketing (Art. 21 Abs. 2 DSGVO) — by letter,
 * phone, e-mail, in whatever form; the law asks for none. An admin records it:
 * every channel is revoked as the OWNER's objection (`OBJECTION` locks the row
 * exactly like the opt-out link does), and every key of the account goes on the
 * block list, so that deleting the account later does not delete the objection.
 */
export async function recordMarketingObjection(input: {
  actor: { id: string; email: string | null };
  company: CompanyKeys & { orgId: string | null };
  request?: Request;
}): Promise<void> {
  const { company } = input;
  for (const channel of CONTACT_CHANNELS) {
    await revokeContactPermission({
      orgId: company.orgId,
      companyId: company.id,
      channel,
      via: 'OBJECTION',
      address: channel === 'EMAIL' ? company.contactEmail : null,
      actor: input.actor,
      request: input.request,
    });
  }
  const hashes = suppressionKeys(company).map(suppressionHash);
  if (hashes.length) {
    await prisma.contactSuppression.createMany({
      data: CONTACT_CHANNELS.flatMap((channel) => hashes.map((keyHash) => ({ orgId: company.orgId, channel, keyHash }))),
      skipDuplicates: true,
    });
  }
  await logActivity({
    action: 'contact.objection_recorded',
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    targetType: 'Company',
    targetId: company.id,
    detail: `keys=${hashes.length}`,
    ...(input.request ? { request: input.request } : {}),
  });
}

export interface PostCandidate {
  id: string;
  name: string;
  contactName: string | null;
  address: string | null;
  country: string | null;
  stage: string | null;
  lastSentAt: Date | null;
  ineligible: PostIneligibility | null;
}

/** Eligibility for a set of accounts, everything the rule needs fetched in three queries. */
async function eligibilityOf(
  tenant: TenantWhere,
  companies: (CompanyKeys & { contactName: string | null })[],
  now: Date,
): Promise<Map<string, { ineligible: PostIneligibility | null; lastSentAt: Date | null }>> {
  // `companies` were read through the caller's tenant, so their ids already
  // carry the scope; the block list is matched by hash and needs it explicitly.
  const ids = companies.map((c) => c.id);
  const [permissions, sent, suppressed] = await Promise.all([
    prisma.contactPermission.findMany({
      where: { companyId: { in: ids }, channel: 'POST' },
      select: { companyId: true, basis: true, revokedAt: true, revokedVia: true },
    }),
    prisma.postCampaignRecipient.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids }, sentAt: { not: null } },
      _max: { sentAt: true },
    }),
    suppressedCompanyIds(tenant, companies),
  ]);
  const permissionOf = new Map(permissions.map((p) => [p.companyId, p]));
  const lastSentOf = new Map(sent.map((s) => [s.companyId, s._max.sentAt]));
  return new Map(
    companies.map((c) => {
      const lastSentAt = lastSentOf.get(c.id) ?? null;
      return [
        c.id,
        {
          lastSentAt,
          ineligible: postIneligibility({
            address: c.address,
            postPermission: permissionOf.get(c.id) ?? null,
            suppressed: suppressed.has(c.id),
            lastSentAt,
            now,
          }),
        },
      ];
    }),
  );
}

/** How many accounts the picker lists at most; a search narrows it. */
export const CANDIDATE_LIMIT = 200;

/**
 * The accounts an admin may pick from, each with its eligibility. `stage`
 * filters on the account's current funnel stage (any of its relations),
 * `channel` on a sales channel it uses (#2408) — "every OTTO seller".
 */
export async function campaignCandidates(input: {
  tenant: TenantWhere;
  campaignId: string;
  q?: string;
  stage?: string;
  /** A sales-channel key (#2408): only accounts that USE it. */
  channel?: string;
  now?: Date;
}): Promise<PostCandidate[]> {
  const where: Prisma.CompanyWhereInput = withinTenant(
    {
      ...(input.q ? { name: { contains: input.q } } : {}),
      ...(input.stage ? { mentorships: { some: { pipelineStatus: input.stage } } } : {}),
      ...(input.channel ? { channels: { some: { channel: input.channel, status: 'USING' } } } : {}),
      postRecipients: { none: { campaignId: input.campaignId } },
    },
    input.tenant,
  );
  const companies = await prisma.company.findMany({
    where,
    orderBy: { name: 'asc' },
    take: CANDIDATE_LIMIT,
    select: {
      ...COMPANY_KEY_SELECT,
      contactName: true,
      mentorships: { orderBy: { startDate: 'desc' }, take: 1, select: { pipelineStatus: true } },
    },
  });
  const eligibility = await eligibilityOf(input.tenant, companies, input.now ?? new Date());
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    contactName: c.contactName,
    address: c.address,
    country: c.country,
    stage: c.mentorships[0]?.pipelineStatus ?? null,
    ...(eligibility.get(c.id) ?? { lastSentAt: null, ineligible: null }),
  }));
}

/**
 * Add accounts to a DRAFT campaign. Eligibility is decided again HERE, on the
 * server, whatever the picker showed — an objection recorded a minute ago wins.
 * The address block is snapshotted: the record is of the letter as printed.
 */
export async function addRecipients(input: {
  campaign: { id: string; orgId: string | null };
  tenant: TenantWhere;
  companyIds: string[];
  countryName?: (code: string) => string;
  now?: Date;
}): Promise<{ added: number; refused: { companyId: string; reason: PostIneligibility | 'not_found' }[] }> {
  const ids = [...new Set(input.companyIds)];
  const companies = await prisma.company.findMany({
    where: withinTenant({ id: { in: ids } }, input.tenant),
    select: { ...COMPANY_KEY_SELECT, contactName: true },
  });
  const found = new Set(companies.map((c) => c.id));
  const refused: { companyId: string; reason: PostIneligibility | 'not_found' }[] = ids
    .filter((id) => !found.has(id))
    .map((companyId) => ({ companyId, reason: 'not_found' as const }));
  const eligibility = await eligibilityOf(input.tenant, companies, input.now ?? new Date());
  const rows: Prisma.PostCampaignRecipientCreateManyInput[] = [];
  for (const c of companies) {
    const reason = eligibility.get(c.id)?.ineligible ?? null;
    const block = addressBlock({ companyName: c.name, contactName: c.contactName, address: c.address, country: c.country, countryName: input.countryName });
    if (reason || !block) {
      refused.push({ companyId: c.id, reason: reason ?? 'no_address' });
      continue;
    }
    rows.push({
      orgId: input.campaign.orgId,
      campaignId: input.campaign.id,
      companyId: c.id,
      recipientName: c.contactName,
      addressBlock: block.join('\n'),
    });
  }
  const { count } = rows.length ? await prisma.postCampaignRecipient.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
  return { added: count, refused };
}

/**
 * The campaign went out. One conditional update (DRAFT → SENT), so two clicks
 * cannot both stamp it, then every recipient gets the same sentAt. Recipients
 * whose account was objected to between print and post are NOT marked: the
 * letter may already be in the box, but we do not claim to have sent it under
 * a basis that no longer held — the admin sees the count that differs.
 */
export async function markCampaignSent(input: {
  campaign: { id: string; orgId: string | null };
  tenant: TenantWhere;
  actor: { id: string; email: string | null };
  request?: Request;
  now?: Date;
}): Promise<{ ok: true; sent: number; skipped: number } | { ok: false; code: 'not_draft' | 'empty' }> {
  const now = input.now ?? new Date();
  const recipients = await prisma.postCampaignRecipient.findMany({
    where: { campaignId: input.campaign.id, orgId: input.campaign.orgId },
    select: { id: true, companyId: true, company: { select: { ...COMPANY_KEY_SELECT, contactName: true } } },
  });
  if (recipients.length === 0) return { ok: false, code: 'empty' };
  // The cooldown is about OTHER campaigns: ignore this one's own (unsent) rows.
  const eligibility = await eligibilityOf(input.tenant, recipients.map((r) => r.company), now);
  const sendable = recipients.filter((r) => {
    const reason = eligibility.get(r.companyId)?.ineligible ?? null;
    return reason === null || reason === 'recently_mailed';
  });
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.postCampaign.updateMany({
      where: { id: input.campaign.id, orgId: input.campaign.orgId, status: 'DRAFT' },
      data: { status: 'SENT', sentAt: now },
    });
    if (claimed.count === 0) return null;
    await tx.postCampaignRecipient.updateMany({ where: { id: { in: sendable.map((r) => r.id) } }, data: { sentAt: now } });
    return sendable.length;
  });
  if (result === null) return { ok: false, code: 'not_draft' };
  await logActivity({
    action: 'post_campaign.sent',
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    targetType: 'PostCampaign',
    targetId: input.campaign.id,
    detail: `sent=${result} skipped=${recipients.length - result}`,
    ...(input.request ? { request: input.request } : {}),
  });
  return { ok: true, sent: result, skipped: recipients.length - result };
}

/**
 * What the campaign brought in: demo requests that arrived through its link
 * (utm_medium=post, utm_campaign=<code>) and how many of those became accounts.
 */
export async function campaignResults(tenant: TenantWhere, code: string): Promise<{ inquiries: number; converted: number }> {
  const where = withinTenant({ utmMedium: 'post', utmCampaign: code }, tenant);
  const [inquiries, converted] = await Promise.all([
    prisma.companyInquiry.count({ where }),
    prisma.companyInquiry.count({ where: { ...where, convertedCompanyId: { not: null } } }),
  ]);
  return { inquiries, converted };
}

/** One campaign of the caller's tenant, or null (another tenant's id is the same 404). */
export async function findCampaign(tenant: TenantWhere, id: string) {
  return prisma.postCampaign.findFirst({
    where: withinTenant({ id }, tenant),
    select: {
      id: true,
      orgId: true,
      name: true,
      code: true,
      status: true,
      sentAt: true,
      dataSource: true,
      balancingNote: true,
      letterBody: true,
      createdAt: true,
    },
  });
}
