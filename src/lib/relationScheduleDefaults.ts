import { resolveSetting } from '@/lib/settingsResolver';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { sanitizeDefaults, type RelationScheduleDefaults } from '@/lib/relationSchedule';

// The duration and meeting rhythm a pairing gets when nobody chose one (#1784):
// programme → org → global, through the settings resolver. Server-only. A row
// without an org reads the default org's settings, like every other row.
export async function relationScheduleDefaults(orgId: string | null, programId?: string | null): Promise<RelationScheduleDefaults> {
  const scope = { orgId: await settingsOrgOfRow(orgId), programId: programId ?? null };
  const [durationMonths, cadenceWeeks] = await Promise.all([
    resolveSetting('relationDefaultDurationMonths', scope),
    resolveSetting('relationDefaultCadenceWeeks', scope),
  ]);
  return sanitizeDefaults({ durationMonths, cadenceWeeks });
}
