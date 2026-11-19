import { z } from 'zod';
import { TEXT_LIMITS } from './textLimits';
import { normalizePublicHost } from './publicHostRule';

export type MailIdentityTransport = 'primary' | 'bulk';
export type MailAddress = { name: string; address: string };
export interface MailIdentityContext {
  platform: MailAddress;
  transport: MailIdentityTransport;
  barePlatform: boolean;
  explicitReplyTo: boolean;
}
export interface OrgMailIdentityRow {
  brandName: string | null;
  publicHost: string | null;
  publicHostVerifiedAt: Date | null;
  mailFromAddress: string | null;
  mailFromName: string | null;
  mailReplyTo: string | null;
  mailDomainVerifiedAt: Date | null;
}

/** The existing env chain, byte-for-byte in precedence and display-name rules. */
export function platformFromIdentity(brandName?: string | null, transport: MailIdentityTransport = 'primary', env: Record<string, string | undefined> = process.env): MailAddress {
  const configured = (transport === 'bulk' ? env.SMTP_BULK_FROM : undefined) || env.SMTP_FROM ||
    (transport === 'bulk' ? env.SMTP_BULK_USER : undefined) || env.SMTP_USER || '';
  const angled = configured.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const address = (angled ? angled[2] : configured).trim();
  const configuredName = angled?.[1].trim() || null;
  return { name: brandName || configuredName || env.MAIL_FROM_NAME || 'Internship CRM', address };
}

const cleanName = (name: string) => Array.from(name).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
const addressOnly = z.email().max(TEXT_LIMITS.orgMailAddress);
export function isMailAddress(value: string): boolean {
  return cleanName(value) && addressOnly.safeParse(value).success;
}
export function mailAddressDomain(value: string): string | null {
  return isMailAddress(value) ? value.slice(value.lastIndexOf('@') + 1).toLowerCase() : null;
}

/** Current main's ownership source; no parent-domain/subdomain inference. */
export function verifiedMailDomain(org: Pick<OrgMailIdentityRow, 'publicHost' | 'publicHostVerifiedAt'>): string | null {
  return org.publicHostVerifiedAt ? normalizePublicHost(org.publicHost) : null;
}

export function orgMailIdentity(org: OrgMailIdentityRow | null, platform: MailAddress) {
  const domain = org ? verifiedMailDomain(org) : null;
  const fromAddress = org?.mailFromAddress?.trim() || '';
  const replyTo = org?.mailReplyTo?.trim() || undefined;
  const name = org?.mailFromName?.trim() || org?.brandName?.trim() || platform.name;
  // Web ownership does NOT prove SPF/DKIM. The separate, server-owned mail
  // verification stamp is mandatory and cannot predate the current host proof.
  const active = !!(org?.mailDomainVerifiedAt && org.publicHostVerifiedAt && domain &&
    org.mailDomainVerifiedAt >= org.publicHostVerifiedAt && mailAddressDomain(fromAddress) === domain &&
    (!replyTo || mailAddressDomain(replyTo) === domain) && cleanName(name));
  return {
    from: active ? { name, address: fromAddress } : platform,
    replyTo: active ? replyTo : undefined,
    source: active ? 'tenant' as const : 'platform' as const,
    verifiedDomain: domain,
    mailDomainVerifiedAt: org?.mailDomainVerifiedAt ?? null,
  };
}

const optionalAddress = z.union([z.string().max(TEXT_LIMITS.orgMailAddress).refine(cleanName, 'Control characters are not allowed').transform(v => v.trim()).refine(v => !v || isMailAddress(v), 'A bare email address is required'), z.null()]).optional();
export const orgMailWriteFields = {
  mailFromAddress: optionalAddress,
  mailFromName: z.string().max(TEXT_LIMITS.orgMailFromName).refine(cleanName, 'Control characters are not allowed').transform(v => v.trim()).nullable().optional(),
  mailReplyTo: optionalAddress,
  // #1672 owns proof. A settings PATCH must never manufacture verification.
  mailDomainVerifiedAt: z.never().optional(),
};
export function mailIdentityDomainError(input: { mailFromAddress?: string | null; mailReplyTo?: string | null }, org: Pick<OrgMailIdentityRow, 'publicHost' | 'publicHostVerifiedAt'>): boolean {
  const domain = verifiedMailDomain(org);
  return [input.mailFromAddress, input.mailReplyTo].some(value => !!value && (!domain || mailAddressDomain(value) !== domain));
}
