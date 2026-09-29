// A MARKETING demo request becomes a funnel record (#2569).
//
// In the internship product an enquiry converts into a Company plus an invited
// COMPANY login (src/lib/companyProvisioning.ts, #1863). A marketing tenant
// sells to that company instead of placing people at it, so the same button
// produces the marketing record: an account (`Company`), a stand-in lead person
// and a funnel record at the org's first stage — docs/marketing-vertical/
// pipeline-record.md. No login is created and nobody is e-mailed.
//
// THERE IS NO THIRD LEAD WRITER. The enquiry is handed to
// `createMarketingAccount()` — the one-row, create-only run of the marketing
// import (#2562) — so the stand-in address, the account match key, the
// one-active-owner rule (#419) and the start stage are the import's, exactly as
// for a lead typed in by hand.
//
// IDEMPOTENCE. The import writes in its own per-row transaction, so the
// enquiry cannot be claimed inside it the way companyProvisioning claims it.
// It is claimed BEFORE instead: a conditional UPDATE sets `convertedAt` on a
// row whose `convertedCompanyId` is still null and which nobody else is
// converting, so of two concurrent clicks exactly one proceeds and the other is
// told what the enquiry became (or that it is being converted right now). On
// success `convertedCompanyId` is written; on any refusal or error the claim is
// released. A claim older than CLAIM_STALE_MS without a company is a crashed
// attempt and may be taken over — `convertedAt` alone never blocks forever.

import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import {
  createMarketingAccount,
  type ManualAccountOutcome,
  type MarketingImportOwner,
} from '@/lib/marketingImportStore';
import { leadSourceName } from '@/lib/leadSourceName';

export const CLAIM_STALE_MS = 10 * 60 * 1000;

/** What `referralSource` says for a lead that came in through the web form. */
export const WEB_FORM_SOURCE = 'Website demo form';

export type InquiryLeadOutcome =
  | { kind: 'converted'; companyId: string; leadId: string | null; stage: string; ownerId: string }
  | { kind: 'not_found' }
  | { kind: 'already_converted'; companyId: string | null; companyName: string | null }
  | { kind: 'in_progress' }
  | Exclude<ManualAccountOutcome, { kind: 'created' }>;

export async function convertInquiryToMarketingLead(input: {
  inquiryId: string;
  /** The inquiry's org. Every query below carries it explicitly. */
  orgId: string;
  /** Who owns the funnel record (its `mentorId`). */
  owner: MarketingImportOwner;
  /** Who pressed the button; null when the default owner received a web request. */
  actor: { id: string; email: string | null } | null;
  request?: Request;
}): Promise<InquiryLeadOutcome> {
  const { inquiryId, orgId } = input;
  return runWithOrg(orgId, async () => {
    const inquiry = await prisma.companyInquiry.findFirst({
      where: { id: inquiryId, orgId },
      select: {
        id: true,
        companyName: true,
        contactName: true,
        email: true,
        phone: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        convertedCompanyId: true,
        convertedCompany: { select: { name: true } },
      },
    });
    if (!inquiry) return { kind: 'not_found' };
    if (inquiry.convertedCompanyId) {
      return {
        kind: 'already_converted',
        companyId: inquiry.convertedCompanyId,
        companyName: inquiry.convertedCompany?.name ?? null,
      };
    }

    const claimedAt = new Date();
    const claim = await prisma.companyInquiry.updateMany({
      where: {
        id: inquiryId,
        orgId,
        convertedCompanyId: null,
        OR: [{ convertedAt: null }, { convertedAt: { lt: new Date(claimedAt.getTime() - CLAIM_STALE_MS) } }],
      },
      data: { convertedAt: claimedAt },
    });
    if (claim.count !== 1) {
      const now = await prisma.companyInquiry.findFirst({
        where: { id: inquiryId, orgId },
        select: { convertedCompanyId: true, convertedCompany: { select: { name: true } } },
      });
      if (now?.convertedCompanyId) {
        return {
          kind: 'already_converted',
          companyId: now.convertedCompanyId,
          companyName: now.convertedCompany?.name ?? null,
        };
      }
      return { kind: 'in_progress' };
    }

    // Released on every path that does not end in a conversion. Scoped to OUR
    // claim (`convertedAt: claimedAt`), so a slow attempt that was taken over as
    // stale cannot release its successor's claim.
    const release = () =>
      prisma.companyInquiry.updateMany({
        where: { id: inquiryId, orgId, convertedCompanyId: null, convertedAt: claimedAt },
        data: { convertedAt: null },
      });

    let outcome: ManualAccountOutcome;
    try {
      outcome = await createMarketingAccount({
        owner: input.owner,
        fields: {
          name: inquiry.companyName,
          contactName: inquiry.contactName,
          contactEmail: inquiry.email,
          ...(inquiry.phone ? { contactPhone: inquiry.phone } : {}),
          // The campaign, when the visitor arrived with one; otherwise the form
          // itself. Free text on the lead (`referralSource`), unchanged.
          source: inquiry.utmSource ?? WEB_FORM_SOURCE,
        },
        // The `Source` row is decided by the ONE attribution rule (#2570,
        // src/lib/leadSourceName.ts) — `utm:<source>/<medium>/<campaign>`, or
        // unknown (no Source, the report's `unsourced` bucket) when the visitor
        // carried no utm_source. "Website demo form" says HOW they reached us,
        // not which channel sent them, so it is not a Source.
        leadSourceName: (() => {
          const r = leadSourceName({
            utmSource: inquiry.utmSource,
            utmMedium: inquiry.utmMedium,
            utmCampaign: inquiry.utmCampaign,
          });
          return r.kind === 'unknown' ? null : r.name;
        })(),
        request: input.request,
        origin: 'inquiry',
        actor: input.actor,
      });
    } catch (error) {
      await release();
      throw error;
    }

    if (outcome.kind !== 'created') {
      await release();
      return outcome;
    }

    const doneAt = new Date();
    await prisma.companyInquiry.updateMany({
      where: { id: inquiryId, orgId, convertedAt: claimedAt },
      data: {
        convertedCompanyId: outcome.companyId,
        convertedAt: doneAt,
        // Converted IS handled — the same rule the internship conversion uses.
        status: 'CLOSED',
        handledAt: doneAt,
        handledById: input.actor?.id ?? input.owner.id,
      },
    });
    await logActivity({
      action: 'company.inquiry.converted',
      actorId: input.actor?.id ?? null,
      actorEmail: input.actor?.email ?? null,
      targetType: 'company_inquiry',
      targetId: inquiryId,
      detail: `lead company=${outcome.companyId} owner=${input.owner.id}${input.actor ? '' : ' (default owner)'}`,
      ...(input.request ? { request: input.request } : {}),
    });
    return {
      kind: 'converted',
      companyId: outcome.companyId,
      leadId: outcome.leadId,
      stage: outcome.stage,
      ownerId: input.owner.id,
    };
  });
}
