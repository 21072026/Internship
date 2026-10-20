import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/superAdmin';
import { getServerDictionary } from '@/i18n/server';
import { ApiExplorer } from '@/components/ApiExplorer';

// /admin/api-explorer (#1447) — Swagger UI over the full internal API surface.
//
// src/app/admin/layout.tsx redirects a missing session to /auth/signin and a
// non-ADMIN role to /, before any child page renders. On top of that the
// document is the whole deployment's map, so it is for the platform operator
// only (#1575): a tenant admin gets a short explanation instead of the screen.
// The spec endpoint (GET /api/admin/openapi) refuses them itself — page gating
// is not API gating.
//
// The screen is one client component: Swagger UI is browser-only and its
// bundle is dynamically imported inside an effect, so nothing about it runs on
// the server and no other route pays for its ~1.2 MB chunk.
export default async function ApiExplorerPage() {
  if (!(await isSuperAdmin(await getServerSession(authOptions)))) {
    const { t } = await getServerDictionary();
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-3">{t.apiExplorer.title}</h1>
        <p data-testid="api-explorer-super-admin-only" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t.apiExplorer.superAdminOnly}
        </p>
      </div>
    );
  }
  return <ApiExplorer />;
}
