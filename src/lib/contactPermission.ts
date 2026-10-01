// Contact permission — the ONE writer (#2577). docs/contact-permission.md.
//
// Every write of a `ContactPermission` row goes through `writeContactPermission`
// (or one of the named paths below, which call it), and every write asks the
// rule first (src/lib/contactPermissionRule.ts). A caller cannot hand in a basis
// its writer may not produce: the rule refuses it and this file THROWS — a
// machine path that tried to write DOI_CONFIRMED is a bug, and a bug that is
// silently coerced to NONE would never be found.
//
// SESSIONLESS WRITERS. Three of the paths here have no session — the DOI click,
// the opt-out click and a web request placed on a default owner's funnel — and
// the import runs from a CLI or a form. `ContactPermission` is registered in
// TENANT_MODELS, and the middleware fills `orgId` in only from a BOUND context,
// so every create below passes `orgId` itself and every lookup filters on it.
//
// NO IP ADDRESS is written anywhere on these paths, including the activity log
// (no `request` is passed to logActivity from a public click): the demo form's
// privacy section promises the form keeps none, and the DOI proof here is the
// signed link bound to the address plus the two timestamps.

import type { Prisma, ContactPermissionSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import {
  MARKETING_EMAIL_BASES,
  marketingEmailAllowed,
  normalizeAddress,
  refuseWrite,
  writeReplaces,
  type ContactBasis,
  type ContactChannel,
  type ContactPermissionWriter,
  type MachineWriter,
  type RuleRefusal,
} from '@/lib/contactPermissionRule';

type Client = Prisma.TransactionClient | typeof prisma;

// No constructor parameter property (`readonly code` in the signature): this
// module is loaded by the marketing import CLI under
// `node --experimental-strip-types`, which refuses that syntax outright.
export class ContactPermissionRuleError extends Error {
  readonly code: RuleRefusal;

  constructor(code: RuleRefusal, writer: ContactPermissionWriter, basis: ContactBasis) {
    super(`contact permission: writer "${writer}" may not write ${basis} (${code})`);
    this.code = code;
    this.name = 'ContactPermissionRuleError';
  }
}

const SOURCE_FOR: Record<ContactPermissionWriter, ContactPermissionSource> = {
  import: 'IMPORT',
  ingest: 'INGEST',
  'salevali-newsletter': 'INGEST',
  doi: 'DOI_LINK',
  inquiry: 'INQUIRY',
  admin: 'ADMIN',
};

export interface PermissionWrite {
  writer: ContactPermissionWriter;
  orgId: string | null;
  companyId: string;
  channel: ContactChannel;
  basis: ContactBasis;
  address?: string | null;
  textVersion?: string | null;
  textLocale?: string | null;
  requestedAt?: Date | null;
  confirmedAt?: Date | null;
  inquiryId?: string | null;
  grantedById?: string | null;
  reason?: string | null;
}

/**
 * Write (or decline to write) one account × channel permission. Returns
 * whether the stored row changed. Throws `ContactPermissionRuleError` when the
 * rule refuses the write itself.
 */
export async function writeContactPermission(input: PermissionWrite, client: Client = prisma): Promise<boolean> {
  const refusal = refuseWrite(input);
  if (refusal) throw new ContactPermissionRuleError(refusal, input.writer, input.basis);

  const key = { companyId_channel: { companyId: input.companyId, channel: input.channel } };
  const existing = await client.contactPermission.findUnique({
    where: key,
    select: { basis: true, revokedAt: true, revokedVia: true, orgId: true },
  });
  // A row of another tenant under this company id would mean the company id
  // itself crossed a tenant; refuse rather than overwrite.
  if (existing && existing.orgId !== input.orgId) return false;
  if (!writeReplaces(input.writer, input.basis, existing, input.confirmedAt)) return false;

  const evidence = {
    basis: input.basis,
    source: SOURCE_FOR[input.writer],
    address: input.address ? normalizeAddress(input.address).slice(0, 320) : null,
    textVersion: input.textVersion ?? null,
    textLocale: input.textLocale ? input.textLocale.slice(0, 5) : null,
    requestedAt: input.requestedAt ?? null,
    confirmedAt: input.confirmedAt ?? null,
    inquiryId: input.inquiryId ?? null,
    grantedById: input.grantedById ?? null,
    reason: input.reason?.trim() || null,
    revokedAt: null,
    revokedVia: null,
  };
  await client.contactPermission.upsert({
    where: key,
    create: { orgId: input.orgId, companyId: input.companyId, channel: input.channel, ...evidence },
    update: evidence,
  });
  return true;
}

/**
 * What an import / feed may record about a new account: that it knows of the
 * address, with NO basis. Create-only — see `writeReplaces`: a re-run never
 * erases a confirmation or un-revokes an opt-out.
 */
export async function recordMachineContactPermission(
  client: Client,
  input: { writer: MachineWriter; orgId: string | null; companyId: string; address?: string | null },
): Promise<void> {
  await writeContactPermission(
    { writer: input.writer, orgId: input.orgId, companyId: input.companyId, channel: 'EMAIL', basis: 'NONE', address: input.address },
    client,
  );
}

/**
 * Revoke one account × channel permission. The basis and its evidence stay on
 * the row (what was revoked, and when); only `revokedAt` makes it ineffective.
 * With no row yet, a NONE row is created already revoked — the objection is
 * itself the record, and it stops a later enquiry conversion from writing a
 * basis over it (`writeReplaces` never revives a revoked row).
 */
export async function revokeContactPermission(input: {
  orgId: string | null;
  companyId: string;
  channel: ContactChannel;
  via: 'LINK' | 'ADMIN';
  address?: string | null;
  inquiryId?: string | null;
  actor?: { id: string; email: string | null } | null;
  request?: Request;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const key = { companyId_channel: { companyId: input.companyId, channel: input.channel } };
  const existing = await prisma.contactPermission.findUnique({
    where: key,
    select: { orgId: true, revokedAt: true, revokedVia: true },
  });
  if (existing && existing.orgId !== input.orgId) return;
  if (existing?.revokedAt) {
    // Already revoked. An ADMIN revocation that the address owner then objects
    // to through the link must still RECORD the owner's objection: it is what
    // locks the row (`ownerObjected`), and an admin revocation is not one — an
    // admin could otherwise write § 7(3) over it later. Keep the earlier
    // revocation's date (that is when the permission stopped); only the "who"
    // becomes the person. Anything else is already as revoked as it gets.
    if (input.via !== 'LINK' || existing.revokedVia === 'LINK') return;
    await prisma.contactPermission.update({ where: key, data: { revokedVia: 'LINK' } });
  } else if (existing) {
    await prisma.contactPermission.update({ where: key, data: { revokedAt: now, revokedVia: input.via } });
  } else {
    await prisma.contactPermission.create({
      data: {
        orgId: input.orgId,
        companyId: input.companyId,
        channel: input.channel,
        basis: 'NONE',
        source: input.via === 'LINK' ? 'DOI_LINK' : 'ADMIN',
        address: input.address ? normalizeAddress(input.address).slice(0, 320) : null,
        inquiryId: input.inquiryId ?? null,
        revokedAt: now,
        revokedVia: input.via,
      },
    });
  }
  await logActivity({
    action: 'contact_permission.revoked',
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    targetType: 'Company',
    targetId: input.companyId,
    detail: `channel=${input.channel} via=${input.via}`,
    // Only an admin's request: a public click carries no IP (see the header).
    ...(input.via === 'ADMIN' && input.request ? { request: input.request } : {}),
  });
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * THE question every marketing-mail path must ask before it sends: may this
 * account be sent advertising e-mail at this address? There is no such send
 * path in the app today (docs/contact-permission.md § The gate) — the first one
 * to be written calls this, per recipient, and skips on `false`.
 */
export async function canSendMarketingEmail(input: {
  orgId: string | null;
  companyId: string;
  address: string;
}): Promise<boolean> {
  const row = await prisma.contactPermission.findFirst({
    where: { companyId: input.companyId, channel: 'EMAIL', orgId: input.orgId },
    select: { channel: true, basis: true, revokedAt: true, confirmedAt: true, address: true },
  });
  return marketingEmailAllowed(row, input.address);
}

/**
 * The same rule as a Company filter, for list screens ("has provable e-mail
 * permission"). It checks the row, not that the row's address still equals
 * `contactEmail` (Prisma cannot compare two columns) — the send gate above
 * does; docs/contact-permission.md says why that is acceptable for a list.
 */
export function marketingEmailPermissionFilter(): Prisma.CompanyWhereInput {
  return {
    contactPermissions: {
      some: {
        channel: 'EMAIL',
        revokedAt: null,
        basis: { in: [...MARKETING_EMAIL_BASES] },
        OR: [{ basis: { not: 'DOI_CONFIRMED' } }, { confirmedAt: { not: null } }],
      },
    },
  };
}

// ── An admin, by hand ───────────────────────────────────────────────────────

export type AdminPermissionOutcome = { kind: 'ok' } | { kind: 'refused'; code: RuleRefusal };

/**
 * An admin records a basis (EXISTING_CUSTOMER_7_3 with a reason, INQUIRY_REPLY
 * or NONE) or revokes one. Never DOI_CONFIRMED — the rule refuses it.
 */
export async function adminSetContactPermission(input: {
  actor: { id: string; email: string | null };
  orgId: string | null;
  companyId: string;
  channel: ContactChannel;
  basis: ContactBasis;
  reason?: string | null;
  address?: string | null;
  request?: Request;
}): Promise<AdminPermissionOutcome> {
  const refusal = refuseWrite({ writer: 'admin', channel: input.channel, basis: input.basis, reason: input.reason });
  if (refusal) return { kind: 'refused', code: refusal };
  const existing = await prisma.contactPermission.findFirst({
    where: { companyId: input.companyId, channel: input.channel, orgId: input.orgId },
    select: { basis: true, revokedAt: true, revokedVia: true },
  });
  if (!writeReplaces('admin', input.basis, existing)) return { kind: 'refused', code: 'owner_objected' };
  await writeContactPermission({
    writer: 'admin',
    orgId: input.orgId,
    companyId: input.companyId,
    channel: input.channel,
    basis: input.basis,
    reason: input.reason,
    address: input.channel === 'EMAIL' ? input.address : null,
    grantedById: input.actor.id,
  });
  await logActivity({
    action: 'contact_permission.set',
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    targetType: 'Company',
    targetId: input.companyId,
    // The reason goes to the row (the evidence) and to this admin-only log.
    detail: `channel=${input.channel} basis=${input.basis}${input.reason ? ` reason=${input.reason.slice(0, 300)}` : ''}`,
    ...(input.request ? { request: input.request } : {}),
  });
  return { kind: 'ok' };
}
