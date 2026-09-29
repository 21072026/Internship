import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { verticalFor } from '@/lib/verticalContext';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { logger } from '@/lib/logger';
import { createMarketingAccount } from '@/lib/marketingImportStore';
import { findLeadOwner, resolveDefaultLeadOwner } from '@/lib/leadOwner';

// One lead / account typed in by hand (#2562) — the phone call, the trade-fair
// badge, the LinkedIn message.
//
// THERE IS NO SECOND LEAD WRITER HERE. The body becomes ONE row of the
// marketing import contract and is run through the import itself
// (`createMarketingAccount` → `runImport` with the import's validator, match
// key, diff and database writer, src/lib/marketingImportStore.ts), in a
// create-only mode: a row the match key resolves to an EXISTING account
// (VAT id first, then name + country) is answered "this account already
// exists" and nothing is written. So the stand-in lead address, the
// one-active-owner rule (#419) and the account master rules stay in one place.
//
// WHO. ADMIN only (a sales-rep role is #2580's decision), in a MARKETING org
// only: INTERNSHIP carries `companies` and `pipeline` as well, but there a
// "lead" is an applicant with a university, and that product already has its
// own intake paths. The capability gates are asked anyway so a future vertical
// without the funnel is refused by the same rule every other writer uses.
//
// WHOSE LEAD (#2580 item 3). The funnel record's owner is `ownerId` when the
// body names one (an active ADMIN/MENTOR of the caller's org, else 400), else
// the org's default lead owner (`defaultLeadOwnerId`), else the admin typing it
// in. The last fallback is the one place "no default owner" does not mean
// "unowned": a funnel record cannot exist without an owner, and — unlike a web
// request, which waits in the unowned list — a hand-typed lead has a person in
// front of it who is, at that moment, working it.

// Generous caps: the import validator enforces the real per-column limits
// (src/lib/textLimits.ts through FIELD_LIMITS) and reports the field by name.
const bodySchema = z.object({
  name: z.string().trim().min(1).max(TEXT_LIMITS.companyName),
  country: z.string().trim().max(TEXT_LIMITS.companyCountry).optional(),
  vatId: z.string().trim().max(TEXT_LIMITS.companyVatId).optional(),
  contactName: z.string().trim().max(TEXT_LIMITS.companyContactName).optional(),
  // Required: the funnel record's `menteeId` is a required FK, and the lead
  // person is keyed by this address (the import places no funnel record for a
  // row without one). The address itself is stored on `Company.contactEmail`;
  // the lead User gets a generated stand-in, never this mailbox.
  contactEmail: z.string().trim().email().max(TEXT_LIMITS.companyContactEmail),
  contactPhone: z.string().trim().max(TEXT_LIMITS.companyContactPhone).optional(),
  source: z.string().trim().max(TEXT_LIMITS.profileShortText).optional(),
  stage: z.string().trim().max(TEXT_LIMITS.profileShortText).optional(),
  ownerId: z.string().trim().min(1).max(64).optional(),
});

export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const orgId = session.user.orgId ?? null;
  const denied =
    (await requireCapability(orgId, 'companies')) ?? (await requireCapability(orgId, 'pipeline'));
  if (denied) return denied;
  if (!orgId || (await verticalFor(orgId)) !== 'MARKETING') {
    return NextResponse.json(
      { code: 'vertical_unavailable', error: 'Manual lead creation is part of the marketing product only.' },
      { status: 403 },
    );
  }

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

  const { ownerId, ...fields } = parsed.data;
  let owner = ownerId ? await findLeadOwner(orgId, ownerId) : null;
  if (ownerId && !owner) {
    return NextResponse.json(
      { code: 'invalid_owner', error: 'Owner is not an active admin or rep of this organization' },
      { status: 400 },
    );
  }
  owner ??= await resolveDefaultLeadOwner(orgId);
  owner ??= { id: session.user.id, email: session.user.email ?? '', orgId, role: session.user.role };

  return withTenantScope(session, async () => {
    try {
      const outcome = await createMarketingAccount({
        owner,
        fields,
        request,
        // The typist is the actor even when the lead goes to somebody else.
        actor: { id: session.user.id, email: session.user.email ?? null },
      });
      switch (outcome.kind) {
        case 'created':
          return NextResponse.json(
            { status: 'created', companyId: outcome.companyId, leadId: outcome.leadId, stage: outcome.stage, ownerId: owner.id },
            { status: 201 },
          );
        case 'exists':
          return NextResponse.json(
            { code: 'account_exists', companyId: outcome.companyId, leadId: outcome.leadId },
            { status: 409 },
          );
        case 'contact_in_funnel':
          return NextResponse.json({ code: 'contact_in_funnel', leadId: outcome.leadId }, { status: 409 });
        case 'contact_is_user':
          return NextResponse.json({ code: 'contact_is_user' }, { status: 409 });
        case 'already_mentored':
          return NextResponse.json({ code: 'already_mentored' }, { status: 409 });
        case 'ambiguous':
          return NextResponse.json({ code: 'account_ambiguous', error: outcome.reason }, { status: 409 });
        case 'write_failed':
          logger.error('marketing.account.create_failed', { reason: outcome.reason });
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        default:
          return NextResponse.json({ code: 'invalid', error: outcome.reason }, { status: 400 });
      }
    } catch (error) {
      logger.error('marketing.account.create_failed', { error: String(error) });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
