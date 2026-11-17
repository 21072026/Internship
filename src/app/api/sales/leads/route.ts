import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRoleOrPermission } from '@/lib/authz';
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
import { leadContactKey, leadStandInEmail } from '@/lib/marketingImport';
import { normalizePhoneKey } from '@/lib/duplicateDetection';
import { resolveNewLeadNames } from '@/lib/newLeadNameRule';

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
//   • E-MAIL OR PHONE (#3647). A lead from a trade-fair stand or a cold call
//     often has only a number. At least one of the two is required; without
//     an address the lead person is keyed on the normalized phone
//     (`leadContactKey`, the import's own key with its phone fallback on), so
//     the same number typed twice meets the same dedupe as the same address.
//   • COMPANY OR CONTACT (#3821). One of the two names is required; a contact
//     alone names the account too, a company alone leaves the contact empty
//     (`resolveNewLeadNames`, the dialog's own rule). 400 `name_required`.
//   • WHOSE IT IS. A refusal that points at a colleague's account or record
//     names its owner (`ownerName`) — never the record's id, never the lead's
//     own contact details — so the rep knows whom to ask.
//
// Creating a lead mails nobody: the import writer sends nothing, and this
// route adds nothing (the e2e spec counts the mail queue and the mail log to
// keep it so).

const bodySchema = z
  .object({
  // Company OR contact name (#3821): checked below through `resolveNewLeadNames`.
  name: z.string().trim().max(TEXT_LIMITS.companyName).optional(),
  country: z.string().trim().max(TEXT_LIMITS.companyCountry).optional(),
  vatId: z.string().trim().max(TEXT_LIMITS.companyVatId).optional(),
  contactName: z.string().trim().max(TEXT_LIMITS.companyContactName).optional(),
  // E-mail OR phone (#3647): the lead person is keyed by the address, else by
  // the normalized phone (stored on the account; the lead User gets a
  // generated stand-in, never this mailbox).
  contactEmail: z.string().trim().email().max(TEXT_LIMITS.companyContactEmail).optional(),
  contactPhone: z.string().trim().max(TEXT_LIMITS.companyContactPhone).optional(),
  source: z.string().trim().max(TEXT_LIMITS.profileShortText).optional(),
  stage: z.string().trim().max(TEXT_LIMITS.profileShortText).optional(),
  })
  .superRefine((v, ctx) => {
    if (!resolveNewLeadNames(v).ok) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'name_required' });
    }
    if (v.contactEmail) return;
    if (!v.contactPhone) {
      ctx.addIssue({ code: 'custom', path: ['contactEmail'], message: 'contact_required' });
    } else if (!normalizePhoneKey(v.contactPhone)) {
      ctx.addIssue({ code: 'custom', path: ['contactPhone'], message: 'phone_invalid' });
    }
  });
// Not `.strict()`: an `ownerId` (or anything else) in the body is dropped, not
// refused — the form never sends one, and a scripted caller learns nothing.

export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const role = session.user.role;

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
    // The name and contact rules get a code the form can word; anything else is "invalid".
    if (parsed.error.issues.some((i) => i.message === 'name_required')) {
      return NextResponse.json({ code: 'name_required', error: 'A company name or a contact name is required' }, { status: 400 });
    }
    const contactIssue = parsed.error.issues.find((i) => i.message === 'contact_required' || i.message === 'phone_invalid');
    if (contactIssue) return NextResponse.json({ code: contactIssue.message, error: 'An e-mail address or a phone number is required' }, { status: 400 });
    return NextResponse.json(
      { code: 'invalid', error: 'Validation failed', details: z.flattenError(parsed.error) },
      { status: 400 },
    );
  }
  const names = resolveNewLeadNames(parsed.data);
  if (!names.ok) return NextResponse.json({ code: names.code }, { status: 400 });
  const fields = { ...parsed.data, name: names.name, contactName: names.contactName };

  return withTenantScope(session, async () => {
    try {
      const colleague = await closedLeadOfColleague(orgId, owner.id, fields);
      if (colleague) {
        return NextResponse.json({ code: 'contact_in_funnel', mine: false, ownerName: colleague.ownerName }, { status: 409 });
      }
      const outcome = await createMarketingAccount({
        owner,
        fields,
        phoneLeadKey: true,
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
            mine
              ? { code: 'account_exists', mine: true, companyId: outcome.companyId }
              : { code: 'account_exists', mine: false, ownerName: outcome.companyId ? await accountOwnerName(orgId, outcome.companyId) : null },
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
            relationId
              ? { code: 'contact_in_funnel', mine: true, relationId }
              : { code: 'contact_in_funnel', mine: false, ownerName: outcome.leadId ? await leadOwnerName(orgId, outcome.leadId) : null },
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
 * Whether the contact's lead person — under either key the import finds it by
 * (the real address, or this org's stand-in for the address or, without one,
 * the phone; `leadContactKey`) — has NO active record but at least one record
 * owned by someone other than the rep. That is the case the create-only writer
 * would otherwise place on the rep's book. A lead with an active record is
 * left to the writer (`contact_in_funnel` / `already_mentored`), and a lead
 * only the rep ever held may be re-opened by the rep. Returns the colleague's
 * name (the newest such record's owner), or null.
 */
async function closedLeadOfColleague(
  orgId: string,
  ownerId: string,
  contact: { contactEmail?: string; contactPhone?: string },
): Promise<{ ownerName: string | null } | null> {
  const key = leadContactKey(contact, true);
  if (!key) return null;
  return runWithOrg(orgId, async () => {
    const leads = await prisma.user.findMany({
      where: { orgId, role: 'MENTEE', email: { in: [key, leadStandInEmail(key, orgId)] } },
      select: { id: true },
    });
    if (leads.length === 0) return null;
    const relations = await prisma.mentorshipRelation.findMany({
      where: { orgId, menteeId: { in: leads.map((l) => l.id) } },
      orderBy: { startDate: 'desc' },
      select: { mentorId: true, status: true, mentor: { select: { fullName: true } } },
    });
    if (relations.some((r) => r.status === 'ACTIVE')) return null;
    const other = relations.find((r) => r.mentorId !== ownerId);
    return other ? { ownerName: other.mentor?.fullName ?? null } : null;
  });
}

/** The name of whoever holds the lead's open record in the org — or null. Never the lead's own details. */
async function leadOwnerName(orgId: string, leadId: string): Promise<string | null> {
  const relation = await runWithOrg(orgId, () =>
    prisma.mentorshipRelation.findFirst({
      where: { orgId, menteeId: leadId, status: 'ACTIVE' },
      orderBy: { startDate: 'desc' },
      select: { mentor: { select: { fullName: true } } },
    }),
  );
  return relation?.mentor?.fullName ?? null;
}

/** The name of the owner of the account's newest open record in the org — or null. */
async function accountOwnerName(orgId: string, companyId: string): Promise<string | null> {
  const relation = await runWithOrg(orgId, () =>
    prisma.mentorshipRelation.findFirst({
      where: { orgId, companyId, status: 'ACTIVE' },
      orderBy: { startDate: 'desc' },
      select: { mentor: { select: { fullName: true } } },
    }),
  );
  return relation?.mentor?.fullName ?? null;
}
