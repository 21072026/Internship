// The lead's contact, as the sales rep sees and corrects it (#3655,
// docs/marketing-vertical/pipeline-record.md § The lead's contact).
//
// WHERE THE CONTACT LIVES. A marketing lead's User row is a stand-in: an
// `@import.local` address that can neither sign in nor be mailed
// (src/lib/marketingImportStore.ts, src/lib/leadEmail.ts). The person the rep
// calls is the ACCOUNT's primary contact — the four `Company.contact*` columns
// (#2407, #2442). So "edit the lead's contact" writes those columns, and never
// `User.email`: a login identity is not something a rep may change, and leaving
// it alone removes the takeover a writable login address would open.
//
// WHAT ELSE MOVES WITH IT. The lead's name and phone on the User row are the
// same person's: the page heading and the board card read `User.fullName`, and
// the Klaviyo matcher reads the lead's phone. They follow the contact in the
// same transaction, so the two can never disagree after a correction.
//
// ONE WRITER. The account's columns are written through
// `writePrimaryContactTx()` (src/lib/companyContacts.ts) inside this
// transaction: the same row lock as a concurrent "make primary", and the same
// duplicate test against the account's address book (409 `duplicate_email`).
//
// NOT AFFECTED. Contact permission is bound to an ADDRESS
// (docs/contact-permission.md): a new address starts with no basis, the old
// address keeps its own row. Nothing is sent to anybody by a correction —
// phase 1 of the sales CRM manages lead data only. External feeds fill an empty
// column but never overwrite a typed-in one (src/lib/externalSyncPolicy.ts,
// incomingCompany() in src/lib/klaviyoSync.ts), so a correction survives the
// next sync.
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { normalizeContact, type ContactFields } from '@/lib/companyContactsRule';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { asContactEmailTaken, ContactEmailTaken, writePrimaryContactTx } from '@/lib/companyContacts';

export { ContactEmailTaken };

export const leadContactSchema = z.object({
  name: z.string().trim().min(1).max(TEXT_LIMITS.companyContactName),
  email: z.string().trim().max(TEXT_LIMITS.companyContactEmail).pipe(z.email()).or(z.literal('')).nullable().optional(),
  phone: z.string().trim().max(TEXT_LIMITS.companyContactPhone).nullable().optional(),
  position: z.string().trim().max(TEXT_LIMITS.companyContactPosition).nullable().optional(),
});

export function parseLeadContact(raw: unknown): ContactFields | null {
  const parsed = leadContactSchema.safeParse(raw);
  return parsed.success ? normalizeContact(parsed.data) : null;
}

const FIELDS = [
  ['name', 'contactName'],
  ['email', 'contactEmail'],
  ['phone', 'contactPhone'],
  ['position', 'contactPosition'],
] as const;

export type LeadContactResult =
  | { ok: true; changed: string[]; leadRow: string[]; contact: ContactFields }
  | { ok: false; code: 'not_found' | 'no_account' };

/**
 * Writes the contact of ONE funnel record. The caller has already decided who
 * may: `ownerId` narrows to the rep's own record, null means any record of the
 * tenant (an admin holding `company.write`). `tenant` is the same filter the
 * page reads with, so another tenant's record is the same `not_found` as one
 * that does not exist. Throws `ContactEmailTaken` for an address another
 * contact of the account holds.
 *
 * `changed` names the account fields that moved; `leadRow` the lead-row fields
 * that were synced. The lead row is compared on its own, so a contact that was
 * already right still brings a stale heading back in step.
 */
export async function updateLeadContact(input: {
  relationId: string;
  ownerId: string | null;
  tenant: TenantWhere;
  orgId: string | null;
  actorId: string;
  fields: ContactFields;
}): Promise<LeadContactResult> {
  const { fields } = input;
  return prisma
    .$transaction(async (tx) => {
      const relation = await tx.mentorshipRelation.findFirst({
        where: withinTenant({ id: input.relationId, ...(input.ownerId ? { mentorId: input.ownerId } : {}) }, input.tenant),
        select: { id: true, companyId: true, menteeId: true, mentee: { select: { fullName: true, phone: true } } },
      });
      if (!relation) return { ok: false as const, code: 'not_found' as const };
      // A record with no account has no contact to correct (the stand-in row is
      // not a contact). Reached only for a hand-made record; the page shows no editor then.
      const company = relation.companyId
        ? await tx.company.findFirst({ where: withinTenant({ id: relation.companyId }, input.tenant), select: { id: true, orgId: true } })
        : null;
      if (!company) return { ok: false as const, code: 'no_account' as const };

      const { before } = await writePrimaryContactTx(tx, company.id, fields);
      const changed = FIELDS.filter(([field, column]) => (before[column] ?? null) !== fields[field]).map(([field]) => field);

      // The same person on the record's lead row: heading, board card, phone matcher.
      const leadData: { fullName?: string; phone?: string | null } = {};
      if (relation.mentee.fullName !== fields.name) leadData.fullName = fields.name;
      if ((relation.mentee.phone ?? null) !== fields.phone) leadData.phone = fields.phone;
      const leadRow = [...(leadData.fullName !== undefined ? ['name'] : []), ...('phone' in leadData ? ['phone'] : [])];
      if (leadRow.length > 0) await tx.user.update({ where: { id: relation.menteeId }, data: leadData });

      if (changed.length > 0 || leadRow.length > 0) {
        await tx.auditLog.create({
          data: {
            orgId: company.orgId ?? input.orgId,
            actorId: input.actorId,
            action: 'sales.lead.contact.update',
            targetId: relation.id,
            // Which fields changed, never their values (a named person's direct line).
            detail: JSON.stringify({ companyId: company.id, changed, leadRow }),
          },
        });
      }
      return { ok: true as const, changed, leadRow, contact: fields };
    })
    .catch(asContactEmailTaken);
}
