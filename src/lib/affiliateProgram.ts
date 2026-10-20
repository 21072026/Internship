// The partner programme of the organisation a request's host belongs to
// (docs/affiliate-module.md, decision 13 and 14). Each organisation has its own
// public host (Organization.publicHost); the host decides which programme page
// and contract a visitor sees, never what data they can read.
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { normalizePublicHost } from '@/lib/publicHostRule';
import { requestHostHeader } from '@/lib/publicHostOrg';
import { localizedText, type LocaleMap } from '@/lib/affiliateContractRule';

/** The marketing organisation this request's host is registered to, or null. */
export async function affiliateOrgForRequest(): Promise<{ id: string } | null> {
  const raw = requestHostHeader(await headers());
  // A port is not part of the registered host name (a local dev server on :3000).
  const host = normalizePublicHost(raw?.split(':')[0] ?? null);
  if (!host) return null;
  return prisma.organization.findFirst({
    where: { publicHost: host, vertical: 'MARKETING' },
    select: { id: true },
  });
}

export interface LandingCopy {
  title: string;
  body: string;
}

/** The organisation's programme copy in one locale, English as the fallback. */
export function landingCopy(map: unknown, locale: string): LandingCopy | null {
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, LandingCopy | undefined>;
  const picked = record[locale] ?? record.en;
  return picked ? { title: String(picked.title ?? ''), body: String(picked.body ?? '') } : null;
}

export { localizedText, type LocaleMap };
