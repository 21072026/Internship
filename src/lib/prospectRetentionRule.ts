// Prospect retention (MKT-4) — the pure half, dependency-free apart from
// pure siblings, unit-tested in scripts/test/prospect-retention-rule.test.mjs.
//
// THE PROMISE. Every postal letter tells the prospect their data is kept
// "längstens 24 Monate nach dem letzten Kontakt" (`PROSPECT_RETENTION_MONTHS`,
// src/lib/postCampaignTemplates.ts). This module is what finds the accounts
// that promise has run out for. It decides; it never erases. Erasure is an
// admin's click on /admin/retention, one account at a time, through the
// existing contact erasure (src/lib/prospectRetention.ts) — there is no
// scheduled job and the Company row is never deleted.
//
// WHO IS A PROSPECT. A MARKETING-vertical account — the vertical that carries
// the sales surface (`hasSalesSurface`: the pipeline without mentorship) — that
// still holds a person's contact data and has neither of the two things that
// make keeping it lawful beyond the letter's promise:
//   • customer history: a funnel record that ever signed (`recordsEverWon()`,
//     the same answer the account-event ingest uses — no second stage list);
//   • a live contact permission: DOI_CONFIRMED or EXISTING_CUSTOMER_7_3
//     (`MARKETING_EMAIL_BASES`), not revoked, its subject not erased.
//
// LAST CONTACT. The newest of three signals: the funnel records' own last
// contact (src/lib/lastContact.ts, read as-is), the newest letter that went
// out to the account, and the newest web enquiry it arrived through. An
// account with no signal at all was never contacted; its data has been held
// since the account was created, so that date stands in (Varsayım: a
// never-contacted import is not kept longer than a contacted one).

import { PROSPECT_RETENTION_MONTHS } from './postCampaignTemplates';
import { MARKETING_EMAIL_BASES, type ContactBasis } from './contactPermissionRule';
import { addMonthsUtc } from './affiliateCommissionRule';
import { hasSalesSurface } from './salesSurface';
import type { VerticalCapability } from './verticals';

export { PROSPECT_RETENTION_MONTHS };

/** At most this many rows reach the review list; `total` still says how many there are. */
export const PROSPECT_REVIEW_LIMIT = 50;

/**
 * What a printed address block becomes once its person is erased. The column
 * is a required TEXT, so it cannot be nulled; the marker says what happened
 * and carries nothing of the person.
 */
export const ERASED_ADDRESS_BLOCK = '[erased]';

/** Does this org's vertical have prospects at all? The sales-surface vertical only. */
export function prospectRetentionApplies(capabilities: readonly VerticalCapability[]): boolean {
  return hasSalesSurface('ADMIN', capabilities);
}

/** Contact made before this instant is past the letter's promise. */
export function prospectRetentionCutoff(now: Date): Date {
  return addMonthsUtc(now, -PROSPECT_RETENTION_MONTHS);
}

export interface PermissionFacts {
  basis: ContactBasis | string;
  revokedAt: Date | null;
  subjectErasedAt?: Date | null;
}

/** A permission that makes keeping the contact lawful on its own — any channel. */
export function hasLivePermission(rows: readonly PermissionFacts[]): boolean {
  return rows.some(
    (r) => (MARKETING_EMAIL_BASES as readonly string[]).includes(r.basis) && !r.revokedAt && !r.subjectErasedAt,
  );
}

export interface ProspectFacts {
  companyId: string;
  name: string;
  createdAt: Date;
  /** Some funnel record of the account ever signed (`recordsEverWon`). */
  everWon: boolean;
  /** `hasLivePermission()` over the account's permission rows. */
  livePermission: boolean;
  /** Any personal contact data left (see `hasContactData`). */
  contactData: boolean;
  /** The funnel records' last contacts (src/lib/lastContact.ts), any of them null. */
  relationContacts: readonly (Date | null)[];
  /** Newest letter sent to the account. */
  lastLetterAt: Date | null;
  /** Newest web enquiry of the account. */
  lastInquiryAt: Date | null;
}

/** The newest of the three contact signals, or the creation date when there is none. */
export function prospectLastContact(f: Pick<ProspectFacts, 'createdAt' | 'relationContacts' | 'lastLetterAt' | 'lastInquiryAt'>): Date {
  let best: Date | null = null;
  for (const d of [...f.relationContacts, f.lastLetterAt, f.lastInquiryAt]) {
    if (d && (!best || d.getTime() > best.getTime())) best = d;
  }
  return best ?? f.createdAt;
}

export type ProspectVerdict =
  | { listed: true; lastContactAt: Date }
  | { listed: false; reason: 'customer' | 'permission' | 'erased' | 'recent'; lastContactAt: Date | null };

/** One account: is it on the review list, and if not, why not. */
export function judgeProspect(f: ProspectFacts, now: Date): ProspectVerdict {
  if (f.everWon) return { listed: false, reason: 'customer', lastContactAt: null };
  if (f.livePermission) return { listed: false, reason: 'permission', lastContactAt: null };
  if (!f.contactData) return { listed: false, reason: 'erased', lastContactAt: null };
  const lastContactAt = prospectLastContact(f);
  if (lastContactAt.getTime() >= prospectRetentionCutoff(now).getTime()) {
    return { listed: false, reason: 'recent', lastContactAt };
  }
  return { listed: true, lastContactAt };
}

export interface ProspectRow {
  companyId: string;
  name: string;
  lastContactAt: Date;
}

/** The review list: overdue accounts, longest-silent first, capped. */
export function overdueProspects(
  accounts: readonly ProspectFacts[],
  now: Date,
  limit = PROSPECT_REVIEW_LIMIT,
): { total: number; items: ProspectRow[] } {
  const rows: ProspectRow[] = [];
  for (const a of accounts) {
    const v = judgeProspect(a, now);
    if (v.listed) rows.push({ companyId: a.companyId, name: a.name, lastContactAt: v.lastContactAt });
  }
  rows.sort((x, y) => x.lastContactAt.getTime() - y.lastContactAt.getTime() || x.companyId.localeCompare(y.companyId));
  return { total: rows.length, items: rows.slice(0, Math.max(0, limit)) };
}

/**
 * Is any personal contact data left on the account? The primary contact
 * columns, a letter snapshot not yet blanked, an address-book entry, or an
 * enquiry that still names its sender. Once all three are gone the account leaves the list.
 */
export function hasContactData(input: {
  company: { contactEmail: string | null; contactName: string | null; contactPhone: string | null; contactPosition: string | null };
  /** Letter snapshots still carrying a name or a real address block. */
  liveLetterSnapshots: number;
  /** Address-book entries (CompanyContact) of the account. */
  addressBookEntries?: number;
  /** Enquiries of the account whose sender is not erased. */
  liveInquiries: number;
}): boolean {
  const c = input.company;
  return Boolean(c.contactEmail || c.contactName || c.contactPhone || c.contactPosition) ||
    input.liveLetterSnapshots > 0 ||
    (input.addressBookEntries ?? 0) > 0 ||
    input.liveInquiries > 0;
}

/** What a letter snapshot of an erased prospect is rewritten to. */
export function letterSnapshotErasureData() {
  return { recipientName: null, addressBlock: ERASED_ADDRESS_BLOCK };
}
