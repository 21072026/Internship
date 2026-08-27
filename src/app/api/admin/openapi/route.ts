import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { APP_VERSION } from '@/lib/version';

// The OpenAPI description of the ENTIRE internal API, for the admin API
// explorer at /admin/api-explorer.
//
// Why this is ADMIN-only. The public spec at /api/v1/openapi.json describes the
// two endpoints an integrator is meant to call. This document describes all ~300
// of them - every admin action, every cron trigger, every webhook receiver,
// which guard each one runs, and which request bodies they accept. That is an
// attack map: it is exactly the reconnaissance an attacker would otherwise have
// to spend weeks assembling by hand, and it must never be reachable without a
// signed-in ADMIN session. The guard below is the same requireAdmin() shape as
// src/app/api/admin/api-keys/route.ts, and returns the same 401 body.
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

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

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

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
  return NextResponse.json(spec, { headers: { 'Cache-Control': 'no-store' } });
}
