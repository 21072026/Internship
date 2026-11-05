// One org's notification retention window (#1646), resolved through the
// settings chain. Server-only. Shared by the nightly sweep (retentionEntries.ts)
// and the announcement history (#1921), which must withhold read counts the
// sweep has already thinned — so the two can never disagree about the window.

import { SETTING_DEFAULTS } from '@/lib/settings';
import { resolveSettingRaw } from '@/lib/settingsResolver';

/** The configured window for one org, falling back to the code default. */
export async function notificationWindowFor(orgId: string | null): Promise<number> {
  const fallback = Number.parseInt(SETTING_DEFAULTS.notificationRetentionDays, 10);
  try {
    const parsed = Number.parseInt(await resolveSettingRaw('notificationRetentionDays', { orgId }), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
