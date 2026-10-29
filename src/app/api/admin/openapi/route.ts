import { NextResponse } from 'next/server';
import { APP_VERSION } from '@/lib/version';
import { brandProductName, hostBrandFor } from '@/lib/orgBrand';
import { isSuperAdmin, logCrossTenantDenial } from '@/lib/superAdmin';
import { requirePermission } from '@/lib/authz';

// The OpenAPI description of the ENTIRE internal API, for the admin API
// explorer at /admin/api-explorer.
//
// Why this is ADMIN-only. The public spec at /api/v1/openapi.json describes the
// two endpoints an integrator is meant to call. This document describes all ~300
// of them - every admin action, every cron trigger, every webhook receiver,
// which guard each one runs, and which request bodies they accept. That is an
// attack map: it is exactly the reconnaissance an attacker would otherwise have
// to spend weeks assembling by hand, and it must never be reachable without a
// signed-in ADMIN session. The guard below is requirePermission() (#1571): 401
// without a session, 403 for a signed-in account without an admin tier.
//
// And why it is SUPER-ADMIN only (#1575). It is not tenant data: it is one map
// of the whole deployment — every tenant's routes, the guard class of each, and
// exactly which ones the analyser could not prove tenant-scoped — so a customer
// org's ADMIN has no business reading it. A tenant admin gets 403.
//
// Why the document arrives through an env var. The Docker runner stage copies
// only public/, .next/, node_modules/, package.json and prisma/ - neither src/
// nor next.config.js exists at runtime - so the route tree cannot be scanned
// when the request arrives, and there is no config left to derive it from.
// scripts/openapi-generate.cjs runs at BUILD time from next.config.js and the
// result is inlined here through nextConfig.env - the same mechanism that
// carries the derived release version (#1275). Two useful consequences:
// nothing in src/ imports a generated file, so `npx tsc --noEmit` on a fresh
// clone has nothing to miss, and the document cannot drift from the code it
// describes - it is rebuilt by the same command that builds the code.

// Inlined at build time by webpack's DefinePlugin (next.config.js -> env).
const RAW_SPEC = process.env.APP_OPENAPI_SPEC || '';

type Spec = {
  info: { title: string; version: string; description?: string };
  externalDocs?: { url: string; description: string };
  [key: string]: unknown;
};

let cached: Spec | null = null;

function loadSpec(): Spec | null {
  if (cached) return cached;
  if (!RAW_SPEC) return null;
  try {
    const spec = JSON.parse(RAW_SPEC) as Spec;
    // The generator has no way to know the release version, so it writes a
    // placeholder and this fills it in from the same source as the UI footer.
    spec.info.version = APP_VERSION;
    // The public surface keeps its own document, including the outgoing-webhook
    // contract (`x-webhooks`). Link to it rather than restating it here: two
    // copies of the same contract is one copy too many, and the public one is
    // the one integrators actually read.
    spec.externalDocs = {
      url: '/api/v1/openapi.json',
      description: 'Public API description (key-authenticated /api/v1 surface and the outgoing-webhook contract). Served without authentication, unchanged by this endpoint.',
    };
    cached = spec;
    return cached;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  if (!(await isSuperAdmin(session))) {
    await logCrossTenantDenial(session, 'GET /api/admin/openapi', null);
    return NextResponse.json({ code: 'super_admin_only', error: 'The internal API description is for the platform operator only' }, { status: 403 });
  }

  const spec = loadSpec();
  if (!spec) {
    // Only reachable if the app was started from a build made without the
    // codegen in next.config.js. Say what to do instead of serving an empty
    // document that looks like "this app has no endpoints".
    return NextResponse.json(
      { error: 'The API description was not generated for this build. Run `npm run gen:openapi` and rebuild.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // no-store: it is derived per build, it is not public, and an intermediary
  // caching the full internal route inventory is not a risk worth taking for a
  // document that costs nothing to re-serve.
  // The build-time title names one product; the cached spec is shared by every
  // host, so the host's product name is applied per request (docs/worlds.md):
  // the host's brand (#2936), else its vertical's default.
  const brand = await hostBrandFor(request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
  const title = `${brandProductName(brand)} - internal API`;
  return NextResponse.json({ ...spec, info: { ...spec.info, title } }, { headers: { 'Cache-Control': 'no-store' } });
}
