import { verticalFor } from '@/lib/verticalContext';
import type { VerticalCapability } from '@/lib/verticals';

// Whether the sales surface shows "New lead" (#2958). The same conditions
// POST /api/sales/leads checks after `hasSalesSurface`: the account master and
// the funnel (`companies` + `pipeline`) in a MARKETING org — the only vertical
// whose "lead" is an account typed in by hand. A button the route would refuse
// is not rendered.
export async function salesLeadCreateAvailable(
  orgId: string | null | undefined,
  capabilities: readonly VerticalCapability[],
): Promise<boolean> {
  if (!orgId || !capabilities.includes('companies') || !capabilities.includes('pipeline')) return false;
  return (await verticalFor(orgId)) === 'MARKETING';
}
