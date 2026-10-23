// The lookups behind the customer-mail lock (src/lib/customerMailLockRule.ts
// says what is locked and why). Server-only.
//
// A mail is locked when ANY of its recipients is a non-staff recipient of a
// MARKETING organization. A recipient is placed through, in order:
//   • the mail's own account (`userId`) — its role and its org;
//   • the mail's org (`orgId`), and the address inside it: an account, a
//     company contact, an account's contact e-mail;
//   • and when the mail names no org at all, the address across every
//     MARKETING organization — a sender that forgot its `orgId` must not be
//     the hole a mail to a lead leaves through.
// FAILS CLOSED: a lookup that throws locks the mail (it is recorded SKIPPED,
// never sent), because "could not tell" must not mean "sent to a customer".
import addressparser from 'nodemailer/lib/addressparser';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runUnscoped } from '@/lib/tenantAmbient';
import { verticalFor } from '@/lib/verticalContext';
import {
  customerMailUnlocked,
  recipientKindOfRole,
  recipientLocked,
  type LockFacts,
} from '@/lib/customerMailLockRule';

export interface LockableMail {
  to: string;
  userId?: string | null;
  orgId?: string | null;
}

function addressesOf(to: string): string[] {
  try {
    return addressparser(to, { flatten: true })
      .map((a) => (typeof a.address === 'string' ? a.address.trim().toLowerCase() : ''))
      .filter(Boolean);
  } catch {
    return [to.trim().toLowerCase()];
  }
}

async function factsInOrg(orgId: string, address: string): Promise<LockFacts> {
  const vertical = (await verticalFor(orgId)) ?? null;
  if (vertical !== 'MARKETING') return { vertical, kind: 'other' };
  const account = await runUnscoped(() =>
    prisma.user.findFirst({ where: { orgId, email: address }, select: { role: true } }),
  );
  if (account) return { vertical, kind: recipientKindOfRole(account.role) };
  // Not an account of the org: a contact, a customer's mailbox, or a stranger —
  // none of them is staff.
  return { vertical, kind: 'contact' };
}

/** An address no org was named for: is it a non-staff recipient of ANY marketing org? */
async function lockedAnywhere(address: string): Promise<boolean> {
  const marketing = { org: { vertical: 'MARKETING' as const } };
  const [user, contact, company] = await Promise.all([
    runUnscoped(() =>
      prisma.user.findFirst({ where: { email: address, role: { notIn: ['ADMIN', 'MENTOR'] }, ...marketing }, select: { id: true } }),
    ),
    runUnscoped(() => prisma.companyContact.findFirst({ where: { email: address, ...marketing }, select: { id: true } })),
    runUnscoped(() => prisma.company.findFirst({ where: { contactEmail: address, ...marketing }, select: { id: true } })),
  ]);
  return Boolean(user || contact || company);
}

/** Is this mail locked by the customer-mail lock? Never throws. */
export async function customerMailLocked(mail: LockableMail): Promise<boolean> {
  if (customerMailUnlocked(process.env)) return false;
  try {
    const addresses = addressesOf(mail.to);
    let orgId = mail.orgId ?? null;
    if (mail.userId) {
      const user = await runUnscoped(() =>
        prisma.user.findUnique({ where: { id: mail.userId! }, select: { role: true, orgId: true } }),
      );
      if (user?.orgId) {
        const vertical = (await verticalFor(user.orgId)) ?? null;
        if (recipientLocked({ vertical, kind: recipientKindOfRole(user.role) }, false)) return true;
        orgId = orgId ?? user.orgId;
      }
    }
    for (const address of addresses) {
      if (orgId) {
        if (recipientLocked(await factsInOrg(orgId, address), false)) return true;
      } else if (await lockedAnywhere(address)) {
        return true;
      }
    }
    return false;
  } catch (e) {
    logger.error('customer_mail_lock.check_failed', { error: e instanceof Error ? e.name : 'unknown' });
    return true;
  }
}
