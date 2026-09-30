// Which org's settings a caller reads and writes (#2628).
//
// `src/lib/settings.ts` resolves "tenant row → global row → default" for
// whatever org it is handed. This file decides WHICH org that is for the two
// kinds of caller that cannot rely on a bound tenant context:
//
//   * a signed-in request — the session's org, and the DEFAULT org when the
//     token carries none (the `tenantFilter.ts` rule: an org-less session or
//     row belongs to the default org, never to "everybody"). Returning `null`
//     there would address the GLOBAL row, which every tenant inherits — that is
//     exactly how a tenant admin's settings form came to switch
//     `premiumAnalytics` on for the whole deployment;
//   * a sessionless job walking many orgs' rows — one memoised lookup per org,
//     with a NULL row org read as the default org by the same rule.
//
// SERVER-ONLY: `defaultOrgId()` touches Prisma. settings.ts stays importable
// from a client graph (see its header); this file must not be.

import type { Session } from 'next-auth';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { getSetting, type SettingKey } from '@/lib/settings';

/** The org a signed-in caller's settings live in. Never `null`. */
export async function settingsOrgOf(session: Session | null | undefined): Promise<string> {
  return resolveOrgId(session) ?? (await defaultOrgId());
}

/** The org a stored row's settings live in: its own, or the default org's. */
export async function settingsOrgOfRow(orgId: string | null | undefined): Promise<string> {
  return orgId ?? (await defaultOrgId());
}

/**
 * One setting for many orgs, for a job that walks rows of several tenants.
 * Each org is read once however many rows it has.
 */
export function settingByOrg(key: SettingKey): (orgId: string | null | undefined) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return async (orgId) => {
    const org = await settingsOrgOfRow(orgId);
    let value = cache.get(org);
    if (!value) {
      value = getSetting(key, org);
      cache.set(org, value);
    }
    return value;
  };
}
