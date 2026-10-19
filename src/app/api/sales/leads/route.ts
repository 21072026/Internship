import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope, runWithOrg } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { verticalFor } from '@/lib/verticalContext';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { logger } from '@/lib/logger';
import { createMarketingAccount } from '@/lib/marketingImportStore';
import { findLeadOwner } from '@/lib/leadOwner';
import { leadStandInEmail } from '@/lib/marketingImport';
import { normalizeEmailKey } from '@/lib/duplicateDetection';

// A sales rep types in their OWN lead (#2958) — the call, the trade-fair
// badge, the LinkedIn message — from the /sales surface.
//
// THE SAME WRITER AS THE ADMIN FORM. The body becomes one row of the marketing
// import contract and goes through `createMarketingAccount()` (create-only),
// exactly like POST /api/admin/marketing-accounts (#2562): the match key (VAT
// id, then name + country), the stand-in lead address, the "contact is staff"
// refusal and the one-active-owner rule (#419) live there and only there.
// Nothing about a lead is decided in this file.
//
// WHAT IS DIFFERENT FROM THE ADMIN PATH, AND WHY.
//   • The owner is ALWAYS the caller. The body has no `ownerId` field; one sent
//     anyway is stripped by the schema and never read — a rep places leads on
//     their own book, never on a colleague's. Same for any `orgId`: the org is
//     the session's, nothing else.
//   • WHO: whoever works on /sales (`hasSalesSurface` — a MENTOR, or an ADMIN in
//     sales mode, of a vertical with a pipeline and without mentorship), in a
//     MARKETING org. An INTERNSHIP mentor has the mentor shell instead and is
//     refused here (403 `vertical_unavailable`), like the admin route refuses
//     an INTERNSHIP admin.
//   • THE ANSWER NEVER POINTS AT SOMEBODY ELSE'S RECORD. "This account already
//     exists" / "this contact is already on the board" is the dedupe working,
//     and the rep must hear it — but the ids come back only when the existing
//     record is on the rep's own book. A colleague's account or lead is named
//     as existing and nothing more (no id that a later request could confirm).
//   • A COLLEAGUE'S CLOSED LEAD IS NOT PICKED UP HERE. The import's create-only
//     plan refuses a contact only while it has an ACTIVE record; a contact whose
//     only records are closed would be placed on the rep's book, re-using the
//     existing lead person — and the colleague's name, phone and company link
//     on it would open to the rep on /sales/leads/[id]. When such a person has
//     any record in the org owned by someone else, the rep hears
//     `contact_in_funnel` with `mine: false`; re-opening it is an admin's
//     transfer, not a fresh lead.
//
// Creating a lead mails nobody: the import writer sends nothing, and this
// route adds nothing (the e2e spec counts the mail queue and the mail log to
// keep it so).

const bodySchema = z.object({
  name: z.string().trim().min(1).max(TEXT_LIMITS.companyName),
  country: z.string().trim().max(TEXT_LIMITS.companyCountry).optional(),
  vatId: z.string().trim().max(TEXT_LIMITS.companyVatId).optional(),
  contactName: z.string().trim().max(TEXT_LIMITS.companyContactName).optional(),
  // Required for the same reason as on the admin route: the funnel record's
  // lead person is keyed by this address (stored on the account; the lead User
  // gets a generated stand-in, never this mailbox).
  contactEmail: z.string().trim().email().max(TEXT_LIMITS.companyContactEmail),
  contactPhone: z.string().trim().max(TEXT_LIMITS.companyContactPhone).optional(),
  source: z.string().trim().max(TEXT_LIMITS.profileShortText).optional(),
  stage: z.string().trim().max(TEXT_LIMITS.profileShortText).optional(),
});
// Not `.strict()`: an `ownerId` (or anything else) in the body is dropped, not
// refused — the form never sends one, and a scripted caller learns nothing.

export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const role = session.user.role;
  if (role !== 'MENTOR' && role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const orgId = session.user.orgId ?? null;
  const denied =
    (await requireCapability(orgId, 'companies')) ?? (await requireCapability(orgId, 'pipeline'));
  if (denied) return denied;
  if (!orgId || (await verticalFor(orgId)) !== 'MARKETING') {
    return NextResponse.json(
      { code: 'vertical_unavailable', error: 'Creating your own leads is part of the marketing product only.' },
      { status: 403 },
    );
  }
  if (!hasSalesSurface(role, await shellCapabilities(orgId))) {
    return NextResponse.json({ code: 'vertical_unavailable', error: 'Forbidden' }, { status: 403 });
  }

  // The caller as a lead owner of THEIR org: an active ADMIN/MENTOR row of
  // `orgId`, compared explicitly (src/lib/leadOwner.ts). A deactivated account
  // whose session has not expired yet gets a 403, not a lead.
  const owner = await findLeadOwner(orgId, session.user.id);
  if (!owner) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ code: 'invalid', error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'invalid', error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const fields = parsed.data;

  return withTenantScope(session, async () => {
    try {
      if (await closedLeadOfColleague(orgId, owner.id, fields.contactEmail)) {
        return NextResponse.json({ code: 'contact_in_funnel', mine: false }, { status: 409 });
      }
      const outcome = await createMarketingAccount({
        owner,
        fields,
        request,
        origin: 'manual',
        actor: { id: session.user.id, email: session.user.email ?? null },
      });
      switch (outcome.kind) {
        case 'created': {
          const relationId = outcome.leadId ? await ownRelationOfLead(orgId, owner.id, outcome.leadId) : null;
          return NextResponse.json(
            { status: 'created', companyId: outcome.companyId, relationId, stage: outcome.stage, ownerId: owner.id },
            { status: 201 },
          );
        }
        case 'exists': {
          const mine = outcome.companyId ? await isOwnAccount(orgId, owner.id, outcome.companyId) : false;
          return NextResponse.json(
            mine ? { code: 'account_exists', mine: true, companyId: outcome.companyId } : { code: 'account_exists', mine: false },
            { status: 409 },
          );
        }
        case 'contact_in_funnel': {
          // Only the rep's ACTIVE record: the contact is in the funnel because
          // SOMEBODY holds it open, and an older closed record of the rep's
          // must not stand in for a colleague's open one.
          const relationId = outcome.leadId
            ? await ownRelationOfLead(orgId, owner.id, outcome.leadId, { activeOnly: true })
            : null;
          return NextResponse.json(
            relationId ? { code: 'contact_in_funnel', mine: true, relationId } : { code: 'contact_in_funnel', mine: false },
            { status: 409 },
          );
        }
        case 'contact_is_user':
          return NextResponse.json({ code: 'contact_is_user' }, { status: 409 });
        case 'already_mentored':
          return NextResponse.json({ code: 'already_mentored' }, { status: 409 });
        case 'ambiguous':
          // The admin route echoes the matcher's reason; it can name accounts,
          // and a rep's book is narrower than the tenant, so it stays here.
          return NextResponse.json({ code: 'account_ambiguous' }, { status: 409 });
        case 'write_failed':
          logger.error('sales.lead.create_failed', { reason: outcome.reason });
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        default:
          return NextResponse.json({ code: 'invalid', error: outcome.reason }, { status: 400 });
      }
    } catch (error) {
      logger.error('sales.lead.create_failed', { error: String(error) });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}

/** The rep's own funnel record for this lead person, inside the org — or null. */
async function ownRelationOfLead(
  orgId: string,
  ownerId: string,
  leadId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<string | null> {
  const relation = await runWithOrg(orgId, () =>
    prisma.mentorshipRelation.findFirst({
      where: { orgId, mentorId: ownerId, menteeId: leadId, ...(opts.activeOnly ? { status: 'ACTIVE' as const } : {}) },
      orderBy: { startDate: 'desc' },
      select: { id: true },
    }),
  );
  return relation?.id ?? null;
}

/** Whether an account of the org carries a record of the rep's — what /sales/accounts/[id] opens. */
async function isOwnAccount(orgId: string, ownerId: string, companyId: string): Promise<boolean> {
  const hit = await runWithOrg(orgId, () =>
    prisma.mentorshipRelation.findFirst({
      where: { orgId, mentorId: ownerId, companyId },
      select: { id: true },
    }),
  );
  return !!hit;
}

/**
 * Whether the contact's lead person — under either address the import keys it
 * by (the real one, or this org's stand-in) — has NO active record but at
 * least one record owned by someone other than the rep. That is the case the
 * create-only writer would otherwise place on the rep's book. A lead with an
 * active record is left to the writer (`contact_in_funnel` / `already_mentored`),
 * and a lead only the rep ever held may be re-opened by the rep.
 */
async function closedLeadOfColleague(orgId: string, ownerId: string, contactEmail: string): Promise<boolean> {
  const key = normalizeEmailKey(contactEmail);
  if (!key) return false;
  return runWithOrg(orgId, async () => {
    const leads = await prisma.user.findMany({
      where: { orgId, role: 'MENTEE', email: { in: [key, leadStandInEmail(key, orgId)] } },
      select: { id: true },
    });
    if (leads.length === 0) return false;
    const relations = await prisma.mentorshipRelation.findMany({
      where: { orgId, menteeId: { in: leads.map((l) => l.id) } },
      select: { mentorId: true, status: true },
    });
    if (relations.some((r) => r.status === 'ACTIVE')) return false;
    return relations.some((r) => r.mentorId !== ownerId);
  });
}
