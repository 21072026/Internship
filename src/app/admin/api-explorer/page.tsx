import { ApiExplorer } from '@/components/ApiExplorer';

// /admin/api-explorer (#1447) — Swagger UI over the full internal API surface.
//
// No auth code here on purpose: src/app/admin/layout.tsx is an async server
// component that redirects a missing session to /auth/signin and a non-ADMIN
// role to /, before any child page renders. The spec endpoint
// (GET /api/admin/openapi) still checks the session itself — page gating is not
// API gating.
//
// The whole screen is one client component: Swagger UI is browser-only and its
// bundle is dynamically imported inside an effect, so nothing about it runs on
// the server and no other route pays for its ~1.2 MB chunk.
export default function ApiExplorerPage() {
  return <ApiExplorer />;
}
