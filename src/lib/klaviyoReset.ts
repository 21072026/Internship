// "Delete what Klaviyo brought in and read it again" — the Klaviyo card's
// reset (docs/integrations/klaviyo.md § Starting over).
//
// It is the operator rollback of one integration source (#2959,
// prisma/wipe-integration-source.mjs) run from the app, for the `klaviyo`
// source of the caller's own organization, and then a fresh first import:
//   • only accounts the connector CREATED (`Company.createdBySource = 'klaviyo'`)
//     are candidates — an account a person typed, a file import or a demo form
//     made is out of reach by construction;
//   • an account with a person's work on it (a note, a stage move, a follow-up,
//     a value, contact-permission evidence, another user …) is KEPT, with its
//     reasons — the verdict is the CLI's, re-read inside each account's
//     transaction, so work added while the reset runs keeps that account;
//   • what goes with an account: its funnel records, its own stand-in leads
//     (also the unassigned ones), its activity, its provider links (cascade);
//   • then the connection's profile cursor is reset to a quiet first import, so
//     the next run re-reads every profile under today's rules (unassigned leads,
//     the real address, phones that are a person's own).
// Nothing is mailed: the import writer sends nothing, and the customer-mail
// lock would stop it anyway.
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runWithOrg } from '@/lib/orgContext';
import { KLAVIYO_PROVIDER } from '@/lib/klaviyoRule';
import { buildPlan, wipeAccount } from '../../prisma/wipe-integration-source.mjs';

interface PlannedAccount {
  company: { id: string; name: string; createdAt: Date };
  action: 'wipe' | 'keep';
  reasons: string[];
}

export interface KlaviyoResetPreview {
  /** Accounts the reset would delete. */
  remove: number;
  /** Accounts it keeps because a person worked on them. */
  keep: number;
  /** Up to 20 kept accounts with why — names only, the admin's own org. */
  kept: { id: string; name: string; reasons: string[] }[];
}

async function plan(orgId: string): Promise<PlannedAccount[]> {
  const result = (await buildPlan(prisma, { id: orgId }, KLAVIYO_PROVIDER)) as { accounts: PlannedAccount[] };
  return result.accounts;
}

export async function klaviyoResetPreview(orgId: string): Promise<KlaviyoResetPreview> {
  return runWithOrg(orgId, async () => {
    const accounts = await plan(orgId);
    const kept = accounts.filter((a) => a.action === 'keep');
    return {
      remove: accounts.length - kept.length,
      keep: kept.length,
      kept: kept.slice(0, 20).map((a) => ({ id: a.company.id, name: a.company.name, reasons: a.reasons })),
    };
  });
}

export interface KlaviyoResetResult {
  removed: number;
  kept: number;
  /** Accounts that changed while the reset ran and were therefore kept. */
  changed: number;
}

/**
 * Apply the reset. `expectRemove` is the number the admin confirmed: when the
 * plan now says something else (somebody worked on an account, a sync created
 * more) nothing is deleted and the caller shows the new preview.
 */
export async function klaviyoResetApply(
  orgId: string,
  expectRemove: number,
): Promise<{ ok: true; result: KlaviyoResetResult } | { ok: false; code: 'not_connected' | 'plan_changed'; preview?: KlaviyoResetPreview }> {
  return runWithOrg(orgId, async () => {
    const connection = await prisma.externalConnection.findFirst({ where: { orgId, provider: KLAVIYO_PROVIDER }, select: { id: true } });
    if (!connection) return { ok: false as const, code: 'not_connected' as const };
    const accounts = await plan(orgId);
    const doomed = accounts.filter((a) => a.action === 'wipe');
    if (doomed.length !== expectRemove) {
      return { ok: false as const, code: 'plan_changed' as const, preview: await klaviyoResetPreview(orgId) };
    }
    let removed = 0;
    let changed = 0;
    for (const account of doomed) {
      try {
        await wipeAccount(prisma, orgId, KLAVIYO_PROVIDER, account);
        removed += 1;
      } catch (e) {
        changed += 1;
        logger.warning('klaviyo reset kept a changed account', { orgId, error: e instanceof Error ? e.name : 'unknown' });
      }
    }
    // A quiet first import again, from the beginning (the key is unchanged, so
    // the rest of the connection — lists, events … — stays as it is).
    await prisma.externalConnection.updateMany({
      where: { id: connection.id, orgId },
      data: {
        profilesSince: null,
        profilesQueryStartedAt: null,
        profilesPageCursor: null,
        profilesErrorFloor: null,
        profilesErrorHolds: null,
        initialSyncDoneAt: null,
        failures: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
      },
    });
    return { ok: true as const, result: { removed, kept: accounts.length - doomed.length, changed } };
  });
}
