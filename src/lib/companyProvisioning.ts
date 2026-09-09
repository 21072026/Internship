// Turning an inbound enquiry into a real account (#1863).
//
// `/for-companies` captures demand, and until now that demand was re-keyed by
// hand across three screens: create the Company on /admin/companies, create a
// login for it, then come back and mark the enquiry closed. Three screens, three
// chances to stop halfway. This module is the one action that does all of it,
// and it is a library rather than a route-handler body because the ORDER of the
// steps is the whole point:
//
//   1. Refuse early, on facts retrying cannot fix — an enquiry that was already
//      converted, an address that already has an account.
//   2. Company + the login's invitation + the enquiry's stamp in ONE
//      transaction. A Company with no way to sign in to it is worse than no
//      Company: it looks done on the admin's screen and nobody can use it.
//   3. Mail, and the audit trail, AFTER the commit. An SMTP round-trip has no
//      business holding a database transaction open, and an `invite.created`
//      line for an invitation that got rolled back would be a lie in the one
//      record that has to be trustworthy.
//
// THE LOGIN IS AN INVITATION, not an account with a password. Nothing here ever
// sets a password, and nothing is ever mailed that an admin could read off their
// own screen: the invitee registers themselves through the ordinary
// `/auth/register?token=…` flow, which is also the only way a COMPANY user has
// ever been meant to be born (the CompanyInquiry model comment has said so since
// #1104). The token is emailed and NEVER returned to the caller — it is a live
// credential, and an HTTP response body means reverse-proxy logs, devtools and
// every screen share (#987, the decision recorded in docs/pii-access-lifecycle.md).
//
// The invitation carries `companyId`, so registration attaches the new user to
// the company this conversion created; without it a COMPANY account signs in to
// nothing.
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import {
  deliverInvitation,
  logInvitationCreated,
  persistInvitation,
  type CreateInvitationInput,
} from '@/lib/inviteCreate';

export interface ConvertInquiryInput {
  inquiryId: string;
  /** The acting admin — becomes the invitation's sender and the enquiry's handler. */
  actor: { id: string; email?: string | null };
  /**
   * The tenant BOTH new rows belong to (#1557, shipped in #2234). Required and
   * non-null on purpose: a public enquiry has no org of its own, and a Company
   * or an invitation created with a NULL orgId simply vanishes the day isolation
   * is enforced. The caller resolves it from the session (falling back to the
   * default org, exactly as registration does) rather than leaving it to the
   * middleware, which only stamps when enforcement is switched on.
   */
  orgId: string;
  companyName: string;
  /**
   * Who the enquiry came from. There is nowhere to *store* a name for an account
   * that does not exist yet — the invitee types their own at registration — so
   * it becomes the invitation's private label, which is how the admin recognises
   * the row on /admin/invitations later. Never shown to the invitee.
   */
  contactFullName: string;
  email: string;
  industry?: string | null;
  size?: string | null;
  /** Language the invitation mail is written in — the admin's, per #1720. */
  locale?: string | null;
  request?: Request;
}

export type ConvertInquiryRefusal =
  | { code: 'not_found' }
  /** Already converted — names what it became so the admin can go look at it. */
  | { code: 'already_converted'; companyId: string | null; companyName: string | null }
  /** The address has an account — names its company so the admin can link instead. */
  | { code: 'email_taken'; companyName: string | null };

export type ConvertInquiryResult =
  | {
      ok: true;
      companyId: string;
      companyName: string;
      /** The invitation row's id. The TOKEN is deliberately not returned. */
      invitationId: string;
      email: string;
      /**
       * Whether the transport actually reported a delivery — not "did not throw"
       * (#1431). False means the account exists and the person it is for has not
       * been told, which is exactly the state somebody will be trying to explain
       * later, so it is surfaced to the admin and written into the audit line.
       */
      emailSent: boolean;
    }
  | { ok: false; refusal: ConvertInquiryRefusal };

/** Thrown inside the transaction to roll the Company back; never escapes. */
class AlreadyClaimedError extends Error {}

export async function convertInquiryToCompanyAccount(
  input: ConvertInquiryInput,
): Promise<ConvertInquiryResult> {
  const email = input.email.trim().toLowerCase();

  const inquiry = await prisma.companyInquiry.findUnique({
    where: { id: input.inquiryId },
    select: {
      id: true,
      orgId: true,
      convertedCompanyId: true,
      convertedCompany: { select: { id: true, name: true } },
    },
  });
  if (!inquiry) return { ok: false, refusal: { code: 'not_found' } };
  if (inquiry.convertedCompanyId) {
    return {
      ok: false,
      refusal: {
        code: 'already_converted',
        companyId: inquiry.convertedCompanyId,
        companyName: inquiry.convertedCompany?.name ?? null,
      },
    };
  }

  // An address that already signs in cannot be invited again — and the useful
  // answer is not "taken", it is WHICH company already has it, so the admin can
  // link the enquiry to that account instead of inventing a second one.
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, company: { select: { name: true } } },
  });
  if (existingUser) {
    return { ok: false, refusal: { code: 'email_taken', companyName: existingUser.company?.name ?? null } };
  }

  const invitationInput: CreateInvitationInput = {
    actor: input.actor,
    orgId: input.orgId,
    email,
    label: input.contactFullName.trim() || null,
    role: 'COMPANY',
    locale: input.locale ?? null,
    request: input.request,
  };

  const now = new Date();
  let created: {
    companyId: string;
    companyName: string;
    invitationId: string;
    token: string;
    tokenLocale: string | null;
  };
  try {
    created = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          orgId: input.orgId,
          name: input.companyName,
          contactEmail: email,
          industry: input.industry?.trim() || null,
          size: input.size?.trim() || null,
        },
        select: { id: true, name: true },
      });

      // The idempotence key, and the reason a double-click cannot produce two
      // companies: the enquiry is CLAIMED by a conditional update, so of two
      // concurrent conversions exactly one matches `convertedCompanyId: null`
      // and the loser rolls its own Company back on the way out. The pre-flight
      // read above cannot do this on its own — both requests would pass it.
      const claimed = await tx.companyInquiry.updateMany({
        where: { id: input.inquiryId, convertedCompanyId: null },
        data: {
          convertedCompanyId: company.id,
          convertedAt: now,
          // Converted IS handled: the enquiry has had its answer, and the point
          // of the list is what is still unanswered. It is never deleted, though
          // — it is the record of where this relationship came from.
          status: 'CLOSED',
          handledAt: now,
          handledById: input.actor.id,
          // A public enquiry arrives org-less. Whoever converts it is the tenant
          // that now owns the relationship; an enquiry that already had an org
          // keeps it.
          orgId: inquiry.orgId ?? input.orgId,
        },
      });
      if (claimed.count !== 1) throw new AlreadyClaimedError();

      const persisted = await persistInvitation({ ...invitationInput, companyId: company.id }, tx);

      return {
        companyId: company.id,
        companyName: company.name,
        invitationId: persisted.invitationId,
        token: persisted.token,
        tokenLocale: persisted.locale,
      };
    });
  } catch (error) {
    if (!(error instanceof AlreadyClaimedError)) throw error;
    // Lost the race. Re-read so the refusal can still name what the enquiry
    // became, which is the only thing the admin wants to know at this point.
    const winner = await prisma.companyInquiry.findUnique({
      where: { id: input.inquiryId },
      select: { convertedCompanyId: true, convertedCompany: { select: { name: true } } },
    });
    return {
      ok: false,
      refusal: {
        code: 'already_converted',
        companyId: winner?.convertedCompanyId ?? null,
        companyName: winner?.convertedCompany?.name ?? null,
      },
    };
  }

  await logInvitationCreated({ ...invitationInput, companyId: created.companyId }, created.invitationId);
  const { emailSent } = await deliverInvitation(invitationInput, {
    invitationId: created.invitationId,
    token: created.token,
    locale: created.tokenLocale,
  });
  await logActivity({
    action: 'company.inquiry.converted',
    level: 'warning',
    actorId: input.actor.id,
    actorEmail: input.actor.email ?? null,
    targetType: 'company_inquiry',
    targetId: input.inquiryId,
    detail: emailSent
      ? `${created.companyName} · invited ${email}`
      : `${created.companyName} · invitation email to ${email} failed to send`,
    request: input.request,
  });

  return {
    ok: true,
    companyId: created.companyId,
    companyName: created.companyName,
    invitationId: created.invitationId,
    email,
    emailSent,
  };
}
