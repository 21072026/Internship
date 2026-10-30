// Automatic affiliate attribution (#3354) — the rule, dependency-free.
//
// An account event that carries `referral_code` links the account's customer
// row to the partner whose `code` it names. This module decides WHAT happens;
// the Prisma half is `attributeToAffiliate()` in src/lib/accountEventIngest.ts
// (it reads the partner and the existing link, asks this function, writes).
//
// The rules, in order:
//   1. No code, or an external id that cannot be a customer reference
//      (empty, longer than the `externalRef` column): nothing to do.
//   2. The customer is already linked: FIRST LINK WINS. The same partner is a
//      no-op (an event sent twice, or a second event of the same account); a
//      DIFFERENT active partner is reported (`kept_first`) so the ingest can
//      leave a line, and the link is never re-pointed.
//   3. No partner of the org has that code: nothing (the lead source the
//      ingest already writes is the only trace).
//   4. Only a partner that could still bring a NEW customer gets a link, by the
//      same test as the payment writer (src/lib/affiliatePaymentWriter.ts):
//      ACTIVE does; SUSPENDED never does; TERMINATED does only while the event
//      is dated BEFORE the termination's `noticeEffectiveAt` (the notice period
//      still brings customers). A terminated partner with no effective date is
//      refused here: the link is permanent, so the conservative answer wins.
import { MAX_REF_LENGTH } from './affiliateCommissionSync';

/** The longest partner code: AffiliatePartner.code is VarChar(100), PARTNER_CODE_RE allows 1 + 99. */
export const PARTNER_CODE_MAX = 100;

export type AffiliatePartnerState = 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';

export interface AttributionInput {
  /** The event's `referral_code`, as sent. */
  referralCode: string | null | undefined;
  /** The event's `external_id` (already trimmed and lower-cased by the envelope). */
  externalId: string;
  /** The org's partner whose code matches, or null. */
  partner: { id: string; status: AffiliatePartnerState; noticeEffectiveAt?: Date | null } | null;
  /** When the event happened (`occurred_at` on a replay, else now): judged against a termination date. */
  eventAt: Date;
  /** The org's existing customer row for the external id, or null. */
  existing: { partnerId: string } | null;
}

export type AttributionPlan =
  | { kind: 'none'; reason: 'no_code' | 'bad_external_id' | 'no_partner' | 'partner_inactive' }
  | { kind: 'link'; partnerId: string; externalRef: string }
  | { kind: 'already_linked'; partnerId: string }
  | { kind: 'kept_first'; keptPartnerId: string; offeredPartnerId: string };

/** The code to look a partner up by, or null when the event names none. */
export function referralCodeKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  return code.length > 0 ? code : null;
}

/** The customer reference an event's external id becomes, or null when it cannot be one. */
export function customerRefFor(externalId: string): string | null {
  const ref = typeof externalId === 'string' ? externalId.trim() : '';
  return ref.length > 0 && ref.length <= MAX_REF_LENGTH ? ref : null;
}

function mayLink(partner: NonNullable<AttributionInput['partner']>, eventAt: Date): boolean {
  if (partner.status === 'ACTIVE') return true;
  if (partner.status !== 'TERMINATED' || !partner.noticeEffectiveAt) return false;
  return eventAt.getTime() < partner.noticeEffectiveAt.getTime();
}

export function planAffiliateAttribution(input: AttributionInput): AttributionPlan {
  if (!referralCodeKey(input.referralCode)) return { kind: 'none', reason: 'no_code' };
  const externalRef = customerRefFor(input.externalId);
  if (!externalRef) return { kind: 'none', reason: 'bad_external_id' };

  const { partner, existing } = input;
  if (existing) {
    if (partner && partner.id === existing.partnerId) return { kind: 'already_linked', partnerId: existing.partnerId };
    // Only a code that WOULD have linked is worth a line; an unknown or
    // inactive one attempts nothing.
    if (partner && mayLink(partner, input.eventAt)) {
      return { kind: 'kept_first', keptPartnerId: existing.partnerId, offeredPartnerId: partner.id };
    }
    return { kind: 'none', reason: partner ? 'partner_inactive' : 'no_partner' };
  }
  if (!partner) return { kind: 'none', reason: 'no_partner' };
  if (!mayLink(partner, input.eventAt)) return { kind: 'none', reason: 'partner_inactive' };
  return { kind: 'link', partnerId: partner.id, externalRef };
}
