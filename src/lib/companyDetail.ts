// The account detail read (#2560), shared by the ADMIN page
// (/admin/companies/[id]) and the sales rep's own view of it
// (/sales/accounts/[id], #2580).
//
// A SERVER read, so nothing here passes through an API route's filters. Every
// query therefore carries the tenant filter by hand (`withinTenant`, #2542):
// another tenant's company id comes back as `null` — the caller answers 404, the
// same as an id that does not exist.
//
// `ownerId` is the rep's row scope. Without it (the ADMIN page) the queries are
// exactly the ones #2560 shipped. With it:
//   - the company is found only when at least one relation of THIS owner, in
//     this tenant, points at it — the MENTOR `company` scope of
//     src/lib/authzScope.ts narrowed to the owner side (a sales rep is never the
//     mentee of a record);
//   - the funnel table lists only that owner's relations, and the interaction
//     list only interactions on them — a rep who shares an account with a
//     colleague never reads the colleague's leads or notes;
//   - the chain of earlier owners stays: it is the history of the rep's OWN
//     record (who worked it before), read through the tenant filter.
// Opening the page is a read of the customer record either way, so both write
// the same `company.view` ActivityLog entry as GET /api/companies/[id] (#2433).

import { usageSeries } from '@/lib/usageRule';
import { profileInfo } from '@/lib/klaviyoRule';
import { endedByChurn } from '@/lib/relationLifecycle';
import type { Session } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { logViewActivity } from '@/lib/activity';
import { CONTACT_SELECT } from '@/lib/companyContacts';
import type { HeaderSource } from '@/lib/clientIp';

/** Days of product usage the account page charts (#2448). */
const USAGE_DAYS = 90;

/** How many funnel records and interactions the page lists. An account holds a
 *  handful of each; the bound only keeps a pathological one from rendering
 *  thousands of rows. */
const RELATION_LIMIT = 100;
const INTERACTION_LIMIT = 10;
/** How far back the "continues an earlier pairing" chain is followed. */
const CHAIN_DEPTH_LIMIT = 10;

export async function loadCompanyDetail({
  session,
  id,
  tenant,
  headers,
  ownerId,
}: {
  session: Session;
  id: string;
  tenant: TenantWhere;
  headers: HeaderSource['headers'];
  ownerId?: string;
}) {
  const ownRelations: Prisma.MentorshipRelationWhereInput = ownerId ? { mentorId: ownerId } : {};
  return withTenantScope(session, async () => {
    const company = await prisma.company.findFirst({
      where: withinTenant(
        ownerId ? { id, mentorships: { some: withinTenant(ownRelations, tenant) } } : { id },
        tenant,
      ),
      include: {
        needs: true,
        // The address book beyond the primary contact (#2442). Each row carries
        // its own orgId: filtered on it like the relations below.
        contacts: {
          where: withinTenant({}, tenant),
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: CONTACT_SELECT,
        },
        // The marketplaces, shop systems and carriers it works on (#2408).
        channels: {
          where: withinTenant({}, tenant),
          orderBy: { channel: 'asc' },
          select: { channel: true, status: true },
        },
        // May we contact this account, and the proof (#2577). The row carries
        // its own orgId: filtered on it like the relations below.
        contactPermissions: {
          where: withinTenant({}, tenant),
          orderBy: { channel: 'asc' },
          select: {
            channel: true,
            basis: true,
            source: true,
            address: true,
            textVersion: true,
            textLocale: true,
            requestedAt: true,
            confirmedAt: true,
            reason: true,
            revokedAt: true,
            revokedVia: true,
            updatedAt: true,
          },
        },
        mentorships: {
          // The relation carries its own orgId: filtered on it too, so a
          // relation of another tenant pointing at this company (a bad import)
          // is not shown here.
          where: withinTenant(ownRelations, tenant),
          orderBy: { startDate: 'desc' },
          take: RELATION_LIMIT,
          select: {
            id: true,
            status: true,
            pipelineStatus: true,
            startDate: true,
            trialStartedAt: true,
            trialEndsAt: true,
            nextActionAt: true,
            nextActionNote: true,
            // The chain link is resolved below, through the tenant filter —
            // not via the `previousRelation` include, which would follow the
            // foreign key into whatever tenant it points at.
            previousRelationId: true,
            mentor: { select: { id: true, fullName: true } },
            mentee: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    if (!company) return null;

    // "Continues an earlier pairing with X, Y" (#2289): the whole
    // previousRelationId chain, newest predecessor first. mentorTransfer only
    // chains relations inside one org, but a chain written by a bad import must
    // not print another tenant's mentor name here, so every earlier relation is
    // read with the same tenant filter as every other row on the page — a link
    // that leaves the tenant simply ends the chain. One query per hop, capped:
    // a reassignment chain is a handful long, and the cap also stops a cycle.
    const chainRows = new Map<string, { mentorName: string; previousRelationId: string | null; churned: boolean }>();
    let frontier = [
      ...new Set(company.mentorships.map((r) => r.previousRelationId).filter((v): v is string => !!v)),
    ];
    for (let hop = 0; hop < CHAIN_DEPTH_LIMIT && frontier.length > 0; hop++) {
      const rows = await prisma.mentorshipRelation.findMany({
        where: withinTenant({ id: { in: frontier } }, tenant),
        select: { id: true, previousRelationId: true, lifecycleState: true, mentor: { select: { fullName: true } } },
      });
      for (const row of rows) {
        chainRows.set(row.id, { mentorName: row.mentor.fullName, previousRelationId: row.previousRelationId, churned: endedByChurn(row) });
      }
      frontier = [
        ...new Set(
          rows.map((row) => row.previousRelationId).filter((v): v is string => !!v && !chainRows.has(v)),
        ),
      ];
    }
    const relations = company.mentorships.map((r) => {
      // The chain says WHY each link exists (#2842): an owner change lists the
      // earlier owners; a churned journey makes this one a win-back. Two
      // labels, because "continues a pairing with X" is false for a customer
      // who left and came back.
      const earlierMentors: string[] = [];
      let wonBack = false;
      const seen = new Set<string>();
      let cursor = r.previousRelationId;
      while (cursor && !seen.has(cursor) && seen.size < CHAIN_DEPTH_LIMIT) {
        seen.add(cursor);
        const row = chainRows.get(cursor);
        if (!row) break;
        if (row.churned) wonBack = true;
        else earlierMentors.push(row.mentorName);
        cursor = row.previousRelationId;
      }
      return { ...r, earlierMentors, wonBack };
    });

    const interactions = await prisma.interactionLog.findMany({
      where: {
        relation: withinTenant(ownerId ? { companyId: company.id, mentorId: ownerId } : { companyId: company.id }, tenant),
      },
      orderBy: { date: 'desc' },
      take: INTERACTION_LIMIT,
      select: {
        id: true,
        date: true,
        type: true,
        subject: true,
        notes: true,
        relation: { select: { mentee: { select: { id: true, fullName: true } } } },
      },
    });

    // Product usage, last 90 days (#2448): read from the (companyId, date)
    // unique index. Rows only — a day without a row stays "no data" in
    // usageSeries(), never a zero.
    const usageFrom = new Date(Date.now() - USAGE_DAYS * 24 * 60 * 60 * 1000);
    const usageRows = await prisma.companyUsage.findMany({
      where: { companyId: company.id, date: { gte: usageFrom } },
      select: { date: true, transactions: true },
      orderBy: { date: 'asc' },
    });
    const usage = usageSeries(usageRows, new Date(), USAGE_DAYS);

    // What a pull connector knows about this account (docs/integrations/klaviyo.md):
    // information only, shown as the provider sent it on its last sync.
    const externalProfiles = (
      await prisma.externalProfileLink.findMany({
        where: { companyId: company.id },
        select: { provider: true, sourceName: true, consent: true, attributes: true, profileUpdatedAt: true },
        orderBy: { createdAt: 'asc' },
        take: 5,
      })
    ).map(profileInfo);

    await logViewActivity({
      action: 'company.view',
      reader: session.user,
      targetType: 'company',
      targetId: company.id,
      request: { headers },
    });

    return { company: { ...company, mentorships: relations }, interactions, usage, externalProfiles };
  });
}

export type CompanyDetailData = NonNullable<Awaited<ReturnType<typeof loadCompanyDetail>>>;
