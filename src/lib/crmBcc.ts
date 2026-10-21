import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { defaultOrgId } from '@/lib/defaultOrg';
import { orgWhere } from '@/lib/tenantFilter';
import { runWithOrg } from '@/lib/orgContext';
import { findUsersInWorld, worldOfOrg } from '@/lib/userWorld';
import { inboundEmailDomain } from '@/lib/inboundDomain';
import { routeInboundEmail, type InboundEmail } from '@/lib/inboundEmail';
import { crmBccAddress, crmBccSourceRef, verifyCrmBccToken } from '@/lib/crmBccTokens';
import {
  addressesIn,
  clipSubject,
  crmBccEnabledFor,
  crmBccInboundNotes,
  crmBccNotes,
  customerAddresses,
  extractCrmBccToken,
  hasReplyToken,
  isCrmBccSender,
  mailDate,
  parseForwardedDate,
  parseForwardedHeaders,
  pickRelation,
  stripForwardPrefix,
} from '@/lib/crmBccRule';

// BCC-to-CRM (#2809): the Prisma-aware half. The rule is src/lib/crmBccRule.ts,
// the decision docs/marketing-vertical/sales-email-capture.md.
//
// Three things are load-bearing:
//   * two signals, both required — the signed token names the org, and the
//     From address must be an active ADMIN/MENTOR of THAT org, looked up in that
//     org's world (src/lib/userWorld.ts; never a bare e-mail lookup);
//   * metadata only — date, clipped subject, recipient addresses. The body and
//     the attachments are never read into a row. A forwarded customer reply
//     (#2815) is the one case the body is READ: in memory, only to find the
//     original sender, date and subject in the forward's header block;
//   * no ContactPermission write. A logged mail is a contact, not a consent
//     (docs/contact-permission.md).

export type CrmBccResult =
  | { ok: true; logged: number; duplicates: number; matchedAccounts: number }
  | { ok: false; status: 400 | 403 | 404; reason: string };

export type InboundMailResult =
  | ({ kind: 'reply' } & Awaited<ReturnType<typeof routeInboundEmail>>)
  | ({ kind: 'crm-bcc' } & CrmBccResult);

/**
 * The one entry point for an inbound mail, shared by the IMAP bridge and
 * `POST /api/inbound-email`: a `reply+` address is a thread reply (the older,
 * narrower path wins when both are present), a `crm+` address is a BCC log.
 */
export async function routeInboundMail(input: InboundEmail): Promise<InboundMailResult> {
  if (!hasReplyToken(input.to) && extractCrmBccToken(input.to)) {
    return { kind: 'crm-bcc', ...(await routeCrmBcc(input)) };
  }
  return { kind: 'reply', ...(await routeInboundEmail(input)) };
}

/** Is BCC-to-CRM on for this org? Its setting, else its vertical's default. */
export async function crmBccEnabled(orgId: string): Promise<boolean> {
  const [stored, vertical] = await Promise.all([resolveSettingRaw('crmBccEnabled', { orgId: orgId }), worldOfOrg(orgId)]);
  return crmBccEnabledFor(stored, vertical);
}

/** What the admin screen shows: on/off, whether that is the default, and the address. */
export async function crmBccState(orgId: string) {
  const [stored, version, vertical] = await Promise.all([
    resolveSettingRaw('crmBccEnabled', { orgId: orgId }),
    resolveSettingRaw('crmBccVersion', { orgId: orgId }),
    worldOfOrg(orgId),
  ]);
  const enabled = crmBccEnabledFor(stored, vertical);
  return {
    enabled,
    explicit: stored === 'true' || stored === 'false',
    address: enabled ? crmBccAddress(orgId, version) : null,
    domainConfigured: inboundEmailDomain() !== null,
  };
}

async function inOrg(userOrgId: string | null, orgId: string): Promise<boolean> {
  if (userOrgId === orgId) return true;
  return userOrgId === null && orgId === (await defaultOrgId());
}

export async function routeCrmBcc(input: InboundEmail): Promise<CrmBccResult> {
  const token = extractCrmBccToken(input.to);
  const payload = token ? verifyCrmBccToken(token) : null;
  if (!payload) return { ok: false, status: 400, reason: 'No valid CRM address' };
  const { orgId, version } = payload;

  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return { ok: false, status: 404, reason: 'Organization not found' };
  // A rotated address is dead: only the current version verifies for routing.
  if ((await resolveSettingRaw('crmBccVersion', { orgId: orgId })) !== version) {
    logger.warning('CRM BCC mail to a rotated address ignored', { orgId });
    return { ok: false, status: 403, reason: 'Address rotated' };
  }
  if (!(await crmBccEnabled(orgId))) return { ok: false, status: 403, reason: 'BCC-to-CRM is off for this organization' };

  return runWithOrg(orgId, async () => {
    // The sender: this address's account in the org's own world, and in the
    // org itself — a same-address account in another org or product is not it.
    const world = await worldOfOrg(orgId);
    const fromAddress = addressesIn(input.from)[0];
    if (!fromAddress) return { ok: false, status: 403, reason: 'Sender is not staff of this organization' };
    const accounts = await findUsersInWorld(fromAddress, world, { id: true, role: true, isActive: true, orgId: true });
    let sender: (typeof accounts)[number] | null = null;
    for (const a of accounts) if (await inOrg(a.orgId, orgId)) { sender = a; break; }
    if (!sender || !isCrmBccSender(sender)) {
      logger.warning('CRM BCC mail from a non-staff sender rejected', { orgId });
      return { ok: false, status: 403, reason: 'Sender is not staff of this organization' };
    }

    const now = new Date();
    // A forwarded customer reply (#2815): the account is the ORIGINAL sender's,
    // the date and subject are the original's. Otherwise: an outbound BCC.
    const original = input.forwarded?.from ? input.forwarded : parseForwardedHeaders(input.text, input.subject);
    const originalFrom = original ? addressesIn(original.from)[0] : undefined;
    const inbound = !!originalFrom && customerAddresses({ to: originalFrom, from: fromAddress, inboundDomain: inboundEmailDomain() }).length > 0;

    let addresses: string[];
    let date: Date;
    let subject: string | null;
    let sourceRef: string;
    let notesFor: (matched: string[]) => string;
    if (inbound && original && originalFrom) {
      const originalSubject = original.subject ?? stripForwardPrefix(input.subject);
      addresses = [originalFrom];
      date = mailDate(parseForwardedDate(original.date) ?? input.date ?? null, now);
      subject = clipSubject(originalSubject);
      sourceRef = crmBccSourceRef({ messageId: original.messageId, from: originalFrom, date: original.date ?? '', subject: originalSubject, recipients: [] });
      notesFor = () => crmBccInboundNotes(originalFrom);
    } else {
      addresses = customerAddresses({ to: input.to, cc: input.cc, from: fromAddress, inboundDomain: inboundEmailDomain() });
      date = mailDate(input.date ?? null, now);
      subject = clipSubject(input.subject);
      sourceRef = crmBccSourceRef({ messageId: input.messageId, from: fromAddress, date: input.date ?? '', subject: subject ?? '', recipients: addresses });
      notesFor = crmBccNotes;
    }
    if (addresses.length === 0) {
      logger.info('CRM BCC mail had no customer recipient', { orgId });
      return { ok: true, logged: 0, duplicates: 0, matchedAccounts: 0 };
    }

    const tenant = await orgWhere(orgId);
    const [byCompany, byContact] = await Promise.all([
      prisma.company.findMany({ where: { ...tenant, contactEmail: { in: addresses } }, select: { id: true, contactEmail: true } }),
      prisma.companyContact.findMany({ where: { ...tenant, email: { in: addresses } }, select: { companyId: true, email: true } }),
    ]);
    // Which of the mail's addresses belong to which account.
    const perCompany = new Map<string, Set<string>>();
    const add = (companyId: string, email: string | null) => {
      if (!email) return;
      const set = perCompany.get(companyId) ?? new Set<string>();
      set.add(email.toLowerCase());
      perCompany.set(companyId, set);
    };
    for (const c of byCompany) add(c.id, c.contactEmail);
    for (const c of byContact) add(c.companyId, c.email);
    if (perCompany.size === 0) {
      // Counted, never stored: no address in the log line (PII).
      logger.info('CRM BCC mail matched no account', { orgId, inbound, addresses: addresses.length });
      return { ok: true, logged: 0, duplicates: 0, matchedAccounts: 0 };
    }

    const relations = await prisma.mentorshipRelation.findMany({
      where: { ...tenant, companyId: { in: [...perCompany.keys()] }, status: 'ACTIVE' },
      select: { id: true, mentorId: true, companyId: true, startDate: true },
    });

    let logged = 0;
    let duplicates = 0;
    for (const [companyId, emails] of perCompany) {
      const relationId = pickRelation(
        relations.filter((r) => r.companyId === companyId).map((r) => ({ id: r.id, mentorId: r.mentorId, createdAt: r.startDate })),
        sender.id,
      );
      if (!relationId) continue;
      try {
        await prisma.interactionLog.create({
          data: { relationId, date, subject, notes: notesFor([...emails]), type: 'Email', autoLogged: true, sourceRef },
        });
        logged++;
      } catch (e) {
        // Unique (relationId, sourceRef): this mail was logged here already.
        if ((e as { code?: string }).code === 'P2002') { duplicates++; continue; }
        throw e;
      }
    }
    if (logged > 0) logger.info('CRM BCC mail logged', { orgId, inbound, logged, duplicates });
    return { ok: true, logged, duplicates, matchedAccounts: perCompany.size };
  });
}
