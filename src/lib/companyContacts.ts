/**
 * The address book of an account (#2442) — the Prisma-aware half. The rule
 * (one primary by construction, the swap, the duplicate test) is
 * src/lib/companyContactsRule.ts; read its header first.
 *
 * Every write runs in ONE transaction that first takes the company row's lock
 * (`SELECT … FOR UPDATE`). Two concurrent "make primary" requests therefore
 * queue instead of interleaving, and neither can read a primary the other is
 * about to replace — the swap never loses or duplicates a person. A move locks
 * both companies, in id order, so two opposite moves cannot deadlock.
 *
 * Callers are the routes under src/app/api/companies/[id]/contacts, which
 * check the session, the ADMIN role, the `companies` capability and the tenant
 * before calling in; the company handed over is one they already found inside
 * the caller's tenant.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  PRIMARY_CONTACT_ID,
  contactAsPrimary,
  emailTaken,
  hasPrimary,
  primaryAsContact,
  primarySwap,
  type ContactFields,
  type PrimaryColumns,
} from '@/lib/companyContactsRule';

/** The address is already in this account's address book. */
export class ContactEmailTaken extends Error {
  constructor() {
    super('duplicate_email');
  }
}

export type CompanyRef = { id: string; orgId: string | null };

export const CONTACT_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PRIMARY_SELECT = {
  id: true,
  orgId: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  contactPosition: true,
} as const;

const CLEARED_PRIMARY: PrimaryColumns = {
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  contactPosition: null,
};

type Tx = Prisma.TransactionClient;

async function lock(tx: Tx, companyIds: string[]): Promise<void> {
  for (const id of [...new Set(companyIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM \`Company\` WHERE id = ${id} FOR UPDATE`;
  }
}

async function bookOf(tx: Tx, companyId: string) {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: PRIMARY_SELECT });
  const rows = await tx.companyContact.findMany({ where: { companyId }, select: { id: true, email: true } });
  return { company, rows };
}

/** A unique-index race the read above could not see is the same answer. */
function rethrowDuplicate(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ContactEmailTaken();
  throw e;
}

/** Put a person into an account: its primary when it has none, else a row. */
async function place(tx: Tx, target: { id: string; orgId: string | null } & PrimaryColumns, contact: ContactFields) {
  if (!hasPrimary(target)) {
    await tx.company.update({ where: { id: target.id }, data: contactAsPrimary(contact) });
    return PRIMARY_CONTACT_ID;
  }
  const row = await tx.companyContact.create({
    data: { ...contact, companyId: target.id, orgId: target.orgId },
    select: { id: true },
  });
  return row.id;
}

/** The primary first, then the other contacts by name. */
export async function listCompanyContacts(companyId: string) {
  const [company, rows] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: PRIMARY_SELECT }),
    prisma.companyContact.findMany({ where: { companyId }, select: CONTACT_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
  ]);
  const primary = hasPrimary(company) ? { id: PRIMARY_CONTACT_ID, isPrimary: true, ...primaryAsContact(company) } : null;
  return [...(primary ? [primary] : []), ...rows.map((r) => ({ ...r, isPrimary: false }))];
}

/** Add a contact. The first contact of an account becomes its primary. */
export async function createCompanyContact(company: CompanyRef, contact: ContactFields): Promise<string> {
  return prisma
    .$transaction(async (tx) => {
      await lock(tx, [company.id]);
      const book = await bookOf(tx, company.id);
      if (emailTaken(contact.email, book.company, book.rows)) throw new ContactEmailTaken();
      return place(tx, book.company, contact);
    })
    .catch(rethrowDuplicate);
}

/** Edit a contact — a row, or the primary (`PRIMARY_CONTACT_ID`). */
export async function updateCompanyContact(companyId: string, contactId: string, contact: ContactFields): Promise<boolean> {
  return prisma
    .$transaction(async (tx) => {
      await lock(tx, [companyId]);
      const book = await bookOf(tx, companyId);
      if (contactId === PRIMARY_CONTACT_ID) {
        if (!hasPrimary(book.company)) return false;
        // The primary's own current address is not a collision with itself.
        if (emailTaken(contact.email, { ...book.company, contactEmail: null }, book.rows)) throw new ContactEmailTaken();
        await tx.company.update({ where: { id: companyId }, data: contactAsPrimary(contact) });
        return true;
      }
      if (!book.rows.some((r) => r.id === contactId)) return false;
      if (emailTaken(contact.email, book.company, book.rows, contactId)) throw new ContactEmailTaken();
      await tx.companyContact.update({ where: { id: contactId }, data: contact });
      return true;
    })
    .catch(rethrowDuplicate);
}

/** Remove a contact; removing the primary clears the four columns. */
export async function deleteCompanyContact(companyId: string, contactId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lock(tx, [companyId]);
    if (contactId === PRIMARY_CONTACT_ID) {
      const { company } = await bookOf(tx, companyId);
      if (!hasPrimary(company)) return false;
      await tx.company.update({ where: { id: companyId }, data: CLEARED_PRIMARY });
      return true;
    }
    const { count } = await tx.companyContact.deleteMany({ where: { id: contactId, companyId } });
    return count > 0;
  });
}

/**
 * Make a row the primary contact: the row's person moves into the columns and
 * the previous primary becomes a new row. Returns false when the row is not
 * (or no longer) in this account — e.g. a second, concurrent request for the
 * same row, which finds it already consumed by the first.
 */
export async function makeContactPrimary(companyId: string, contactId: string): Promise<boolean> {
  return prisma
    .$transaction(async (tx) => {
      await lock(tx, [companyId]);
      const row = await tx.companyContact.findFirst({ where: { id: contactId, companyId }, select: CONTACT_SELECT });
      if (!row) return false;
      const { company } = await bookOf(tx, companyId);
      const { primary, demoted } = primarySwap(company, row);
      await tx.companyContact.delete({ where: { id: row.id } });
      await tx.company.update({ where: { id: companyId }, data: primary });
      if (demoted) {
        await tx.companyContact.create({ data: { ...demoted, companyId, orgId: company.orgId } });
      }
      return true;
    })
    .catch(rethrowDuplicate);
}

/**
 * People change jobs: move a contact — a row, or the primary — to another
 * account of the same tenant (the route checks the tenant). At the target it
 * becomes the primary when the target has none. Returns the contact's id at
 * the target, or null when it is not in the source account.
 */
export async function moveCompanyContact(fromCompanyId: string, contactId: string, toCompanyId: string): Promise<string | null> {
  return prisma
    .$transaction(async (tx) => {
      await lock(tx, [fromCompanyId, toCompanyId]);
      const source = await bookOf(tx, fromCompanyId);
      let person: ContactFields;
      if (contactId === PRIMARY_CONTACT_ID) {
        if (!hasPrimary(source.company)) return null;
        person = primaryAsContact(source.company);
      } else {
        const row = await tx.companyContact.findFirst({ where: { id: contactId, companyId: fromCompanyId }, select: CONTACT_SELECT });
        if (!row) return null;
        person = { name: row.name, email: row.email, phone: row.phone, position: row.position };
      }
      const target = await bookOf(tx, toCompanyId);
      if (emailTaken(person.email, target.company, target.rows)) throw new ContactEmailTaken();
      // A row joining an account that already has a primary keeps its id and
      // its createdAt: the same person, re-homed.
      if (contactId !== PRIMARY_CONTACT_ID && hasPrimary(target.company)) {
        await tx.companyContact.update({
          where: { id: contactId },
          data: { companyId: toCompanyId, orgId: target.company.orgId },
        });
        return contactId;
      }
      if (contactId === PRIMARY_CONTACT_ID) {
        await tx.company.update({ where: { id: fromCompanyId }, data: CLEARED_PRIMARY });
      } else {
        await tx.companyContact.delete({ where: { id: contactId } });
      }
      return place(tx, target.company, person);
    })
    .catch(rethrowDuplicate);
}
