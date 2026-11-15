import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { resolveOrgId } from '@/lib/orgScope';
import { ExecutiveDashboard } from './ExecutiveDashboard';

// The executive dashboard (#1895). This server parent only decides what the
// org's product shows (#3706): a vertical without `mentorship` (MARKETING) gets
// no Capability block and no programme-cohort selector. Access itself is the
// admin shell's and the API's; the metrics are untouched.
export default async function ExecutiveDashboardPage() {
  const session = await getServerSession(authOptions);
  const capabilities = await shellCapabilities(resolveOrgId(session));
  return <ExecutiveDashboard hasMentorship={capabilities.includes('mentorship')} />;
}
