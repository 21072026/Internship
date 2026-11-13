// Prospect retention (MKT-4) — the Prisma half. The rule, and why, is in
// src/lib/prospectRetentionRule.ts; this file only reads the facts it needs and
// performs the one manual erasure.
//
// Two things this file deliberately does NOT do:
//   • schedule anything. The review list is a report; the `prospectContact`
//     retention entry (src/lib/retentionEntries.ts) only counts. Erasure stays
//     an admin's click, one account at a time.
//   • delete a Company row, or touch the block list (`ContactSuppression`):
//     the account is the organisation's history, and an objection must outlive
//     the person's data.

import { randomUUID } from 'crypto';
import { prisma } from '@/lib/prisma';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { getLastContacts } from '@/lib/lastContact';
import { relationsEverWon } from '@/lib/wonHistory';
import { stampContactProofsErased } from '@/lib/contactPermission';
import { MARKETING_EMAIL_BASES } from '@/lib/contactPermissionRule';
import {
  accountlessTombstoneId,
  companyContactErasureData,
  inquiryErasureData,
  normalizeContactEmail,
} from '@/lib/companyContactErasure';
import { ERASED_EMAIL_DOMAIN } from '@/lib/menteeAccount';
import {
  ERASED_ADDRESS_BLOCK,
  PROSPECT_REVIEW_LIMIT,
  hasContactData,
  hasLivePermission,
  judgeProspect,
  letterSnapshotErasureData,
  overdueProspects,
  prospectRetentionApplies,
  prospectRetentionCutoff,
  type ProspectFacts,
  type ProspectRow,
  type ProspectVerdict,
} from '@/lib/prospectRetentionRule';

const CHUNK = 500;
const ERASED_INQUIRY_SUFFIX = `@${ERASED_EMAIL_DOMAIN}`;

/** Does this org have prospects at all (the sales-surface vertical)? */
export async function prospectRetentionAppliesTo(orgId: string): Promise<boolean> {
  return prospectRetentionApplies(await shellCapabilities(orgId));
}

/** A letter snapshot that still carries the person. */
const liveSnapshot = { OR: [{ recipientName: { not: null } }, { addressBlock: { not: ERASED_ADDRESS_BLOCK } }] };

/**
 * The DB pre-filter: an account of this org that no cheap signal already rules
 * out. Only ever NARROWS to what `judgeProspect()` would also exclude — the
 * rule itself runs over every row this returns.
 */
function candidateWhere(orgId: string, cutoff: Date, companyId?: string) {
  return {
    orgId,
    ...(companyId ? { id: companyId } : {}),
    // An account: it carries lead rows or their funnel records.
    OR: [{ mentorships: { some: {} } }, { users: { some: { role: 'MENTEE' as const } } }],
    // A live permission keeps it off the list (rule: hasLivePermission).
    contactPermissions: {
      none: { basis: { in: [...MARKETING_EMAIL_BASES] }, revokedAt: null, subjectErasedAt: null },
    },
    // A recent letter or enquiry keeps it off the list.
    postRecipients: { none: { sentAt: { gte: cutoff } } },
    fromInquiries: { none: { createdAt: { gte: cutoff } } },
  };
}

/** Read the rule's facts for a set of accounts. */
async function factsFor(orgId: string, cutoff: Date, companyId?: string): Promise<ProspectFacts[]> {
  const out: ProspectFacts[] = [];
  let cursor: string | undefined;
  for (;;) {
    const companies = await prisma.company.findMany({
      where: candidateWhere(orgId, cutoff, companyId),
      orderBy: { id: 'asc' },
      take: CHUNK,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        createdAt: true,
        contactEmail: true,
        contactName: true,
        contactPhone: true,
        contactPosition: true,
        contactPermissions: { select: { basis: true, revokedAt: true, subjectErasedAt: true } },
        mentorships: { select: { id: true, menteeId: true, pipelineStatus: true } },
      },
    });
    if (companies.length === 0) break;
    cursor = companies[companies.length - 1].id;
    const ids = companies.map((c) => c.id);
    const relations = companies.flatMap((c) => c.mentorships);
    const contactEmails = [...new Set(companies.flatMap((c) => (c.contactEmail ? [normalizeContactEmail(c.contactEmail)] : [])))];

    const [won, lastContacts, letters, liveLetters, addressBook, inquiries] = await Promise.all([
      relationsEverWon(relations),
      getLastContacts(relations),
      prisma.postCampaignRecipient.groupBy({
        by: ['companyId'],
        where: { companyId: { in: ids }, sentAt: { not: null } },
        _max: { sentAt: true },
      }),
      prisma.postCampaignRecipient.groupBy({
        by: ['companyId'],
        where: { companyId: { in: ids }, ...liveSnapshot },
        _count: { _all: true },
      }),
      prisma.companyContact.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
      // The account's enquiries: the ones it was converted from, and the ones
      // its contact sent — the same address match the contact erasure uses.
      prisma.companyInquiry.findMany({
        where: {
          orgId,
          OR: [
            { convertedCompanyId: { in: ids } },
            ...(contactEmails.length ? [{ email: { in: contactEmails }, convertedCompanyId: null }] : []),
          ],
        },
        select: { convertedCompanyId: true, email: true, createdAt: true },
      }),
    ]);
    const letterAt = new Map(letters.map((l) => [l.companyId, l._max.sentAt]));
    const liveLetterCount = new Map(liveLetters.map((l) => [l.companyId, l._count._all]));
    const addressBookCount = new Map(addressBook.map((l) => [l.companyId, l._count._all]));

    for (const c of companies) {
      const own = c.contactEmail ? normalizeContactEmail(c.contactEmail) : null;
      const mine = inquiries.filter(
        (q) => q.convertedCompanyId === c.id || (q.convertedCompanyId === null && own !== null && normalizeContactEmail(q.email) === own),
      );
      const lastInquiryAt = mine.reduce<Date | null>((best, q) => (!best || q.createdAt > best ? q.createdAt : best), null);
      out.push({
        companyId: c.id,
        name: c.name,
        createdAt: c.createdAt,
        everWon: c.mentorships.some((r) => won.has(r.id)),
        livePermission: hasLivePermission(c.contactPermissions),
        contactData: hasContactData({
          company: c,
          liveLetterSnapshots: liveLetterCount.get(c.id) ?? 0,
          addressBookEntries: addressBookCount.get(c.id) ?? 0,
          liveInquiries: mine.filter((q) => !q.email.endsWith(ERASED_INQUIRY_SUFFIX)).length,
        }),
        relationContacts: c.mentorships.map((r) => lastContacts.get(r.id)?.at ?? null),
        lastLetterAt: letterAt.get(c.id) ?? null,
        lastInquiryAt,
      });
    }
    if (companies.length < CHUNK || companyId) break;
  }
  return out;
}

/** The review list of one org: overdue prospects, longest-silent first. */
export async function listOverdueProspects(
  orgId: string,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ applies: boolean; total: number; items: ProspectRow[] }> {
  if (!(await prospectRetentionAppliesTo(orgId))) return { applies: false, total: 0, items: [] };
  const now = opts.now ?? new Date();
  const facts = await factsFor(orgId, prospectRetentionCutoff(now));
  return { applies: true, ...overdueProspects(facts, now, opts.limit ?? PROSPECT_REVIEW_LIMIT) };
}

/** How many overdue prospects there are, across every sales-surface org (the retention entry's report). */
export async function countOverdueProspectsAllOrgs(now = new Date()): Promise<{ total: number; orgs: number }> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  let total = 0;
  let applying = 0;
  for (const o of orgs) {
    const r = await listOverdueProspects(o.id, { now, limit: 0 });
    if (r.applies) applying += 1;
    total += r.total;
  }
  return { total, orgs: applying };
}

export type ProspectEraseResult =
  | { kind: 'not_found' }
  | { kind: 'not_overdue'; reason: Exclude<ProspectVerdict, { listed: true }>['reason'] }
  | { kind: 'erased'; companies: number; inquiries: number; contacts: number; letters: number };

/**
 * Erase the contact data of ONE overdue prospect, at an admin's request.
 *
 * Refuses (`not_found`) an account outside `orgId` — including any account at
 * all when the org has no prospects — and (`not_overdue`) one the review list
 * would not show, so the button cannot be pointed at a customer or a fresh
 * lead by id. Then, in one transaction, the contact erasure's own rules
 * (src/lib/companyContactErasure.ts, #2434) applied to THIS account:
 *   1. its UWG § 7 proofs are stamped erased (the evidence clock starts);
 *   2. its contact columns are cleared (`companyContactErasureData`) — the
 *      Company row, its name and its history stay;
 *   3. its enquiries — the ones it was converted from, and unconverted ones
 *      its contact sent — get `inquiryErasureData`;
 *   4. its address-book entries go (an entry is nothing but the person);
 *   5. its letter snapshots: `recipientName` null, `addressBlock` the marker.
 * Confined to the account on purpose (Varsayım): the same address on ANOTHER
 * account of the org — a customer, say — has its own basis and is not this
 * prospect's data to erase. The block list (`ContactSuppression`) is not
 * touched. One AuditLog row records the click.
 */
export async function eraseProspectContact(
  orgId: string,
  companyId: string,
  actorId: string,
  now = new Date(),
): Promise<ProspectEraseResult> {
  if (!(await prospectRetentionAppliesTo(orgId))) return { kind: 'not_found' };
  const company = await prisma.company.findFirst({ where: { id: companyId, orgId }, select: { id: true, contactEmail: true } });
  if (!company) return { kind: 'not_found' };

  const [facts] = await factsFor(orgId, prospectRetentionCutoff(now), companyId);
  // Not a candidate at all (a live permission, a recent letter or enquiry, no
  // lead rows): the pre-filter already said no.
  if (!facts) return { kind: 'not_overdue', reason: 'recent' };
  const verdict = judgeProspect(facts, now);
  if (!verdict.listed) return { kind: 'not_overdue', reason: verdict.reason };

  const own = company.contactEmail ? normalizeContactEmail(company.contactEmail) : null;
  const tombstone = accountlessTombstoneId(randomUUID());
  const [, companies, inquiries, contacts, letters] = await prisma.$transaction([
    stampContactProofsErased({ companyId, orgId }, now),
    prisma.company.updateMany({ where: { id: companyId, orgId }, data: companyContactErasureData() }),
    prisma.companyInquiry.updateMany({
      where: {
        orgId,
        NOT: { email: { endsWith: ERASED_INQUIRY_SUFFIX } },
        OR: [{ convertedCompanyId: companyId }, ...(own ? [{ email: own, convertedCompanyId: null }] : [])],
      },
      data: inquiryErasureData(tombstone),
    }),
    prisma.companyContact.deleteMany({ where: { companyId } }),
    prisma.postCampaignRecipient.updateMany({ where: { companyId, ...liveSnapshot }, data: letterSnapshotErasureData() }),
  ]);
  // The privileged-action trail, with the org stamped so the tenant's audit
  // drain carries it. Counts and dates only — the erased data never lands here.
  await prisma.auditLog.create({
    data: {
      orgId,
      actorId,
      action: 'prospect.contact_erased',
      targetId: companyId,
      detail: JSON.stringify({
        lastContactAt: verdict.lastContactAt.toISOString(),
        companies: companies.count,
        inquiries: inquiries.count,
        contacts: contacts.count,
        letters: letters.count,
      }),
    },
  });

  return { kind: 'erased', companies: companies.count, inquiries: inquiries.count, contacts: contacts.count, letters: letters.count };
}
