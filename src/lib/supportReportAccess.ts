import type { Session } from 'next-auth';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';

// Who may read the bug-report inbox (#3130): an ADMIN, and only for reports of
// their own org. Each route checks the session itself (the route-auth and
// OpenAPI analysers follow a guard only within the file); this resolves the
// org. `SupportReport.orgId` is never NULL (the POST route stamps it), so the
// scope is one equality — a report of another org answers 404 from every
// admin route, the same as an id that does not exist.

export { SUPPORT_REPORT_STATUSES } from '@/lib/supportReportStatus';

export async function reportAdminOrg(session: Session): Promise<string> {
  return resolveOrgId(session) ?? (await defaultOrgId());
}
