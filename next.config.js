/** @type {import('next').NextConfig} */

// The Content-Security-Policy lives in src/lib/cspPolicy.cjs (#1552), which
// also builds the strict nonce policy src/middleware.ts sends report-only on
// page requests — one set of host lists, so the two cannot drift. This is the
// ENFORCED policy: same-origin by default, inline/eval still allowed for
// scripts until the report-only stream says the strict one is safe.
//
// Growth analytics (#1242): NEXT_PUBLIC_* vars are inlined at build time, so the
// policy names only the providers this build actually has.
const { buildCsp, JAAS } = require('./src/lib/cspPolicy.cjs');
const csp = buildCsp(process.env);

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // camera/microphone/display-capture are granted to the app itself and to the
  // embedded Jitsi rooms only (8x8.vc is our JaaS tenant, meet.jit.si the older
  // public rooms) — a blanket `camera=()` disables them for every frame, which
  // would leave the meeting panel with a picture of nobody. geolocation stays
  // fully denied.
  {
    key: 'Permissions-Policy',
    value: [
      `camera=(self "https://meet.jit.si" "${JAAS}")`,
      `microphone=(self "https://meet.jit.si" "${JAAS}")`,
      `display-capture=(self "https://meet.jit.si" "${JAAS}")`,
      'geolocation=()',
    ].join(', '),
  },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

// Release fragments (#1275): the version shown to users is BASE (package.json)
// plus the pending fragments under releases/unreleased/, derived here at build
// time and inlined via env. PRs never edit package.json/CHANGELOG/releaseNotes
// directly — see releases/README.md; a scheduled workflow later compacts the
// fragments into those canonical files through a normal PR.
const pkg = require('./package.json');
const release = require('./scripts/release-derive.cjs');
// One release per fragment (#1457): the timeline assigns each pending fragment
// its own version, plus the date/time it was merged and the commit that brought
// it in (read from git, or from RELEASE_STAMPS where .git is absent — the Docker
// build, see .dockerignore). Throws on a malformed fragment, as before.
const { version: derivedVersion, timeline } = release.resolveRelease(__dirname, pkg.version);
const unreleasedEntries = release.unreleasedEntries(timeline);

// Admin API explorer: the OpenAPI description of every route under
// src/app/api is derived HERE, at config load, exactly like the release
// fragments above. It has to happen at build time - the Docker runner stage
// copies only public/, .next/, node_modules/, package.json and prisma/, so
// src/app/api does not exist when a request arrives - and it is inlined into
// the server bundle through `env` below, which is also why nothing under src/
// imports a generated file: `npx tsc --noEmit` on a fresh clone has nothing to
// miss. Failure degrades to an empty spec (the endpoint then answers 503 with
// "rebuild") rather than taking the whole config down with it, and buildSpec()
// returns null instead of throwing when src/app/api is missing. The runner stage
// ships neither src/ nor this file, so it never runs in the production container
// at all - `next start` uses the config baked into required-server-files.json -
// but a partial checkout must not be able to turn a docs generator into a build
// failure. See docs/api-explorer.md.
const openapi = require('./scripts/openapi-generate.cjs');
let openapiSpec = '';
try {
  const built = openapi.buildSpec(__dirname);
  if (built) openapiSpec = JSON.stringify(built.spec);
} catch (error) {
  console.warn(`next.config: OpenAPI derivation failed (${error.message}); /api/admin/openapi will report that it needs a rebuild.`);
}

const nextConfig = {
  reactStrictMode: true,
  env: {
    APP_DERIVED_VERSION: derivedVersion,
    // The whole internal API description, ~300 KB of JSON. Read by
    // src/app/api/admin/openapi/route.ts and served to admins only.
    APP_OPENAPI_SPEC: openapiSpec,
    // One RELEASE_NOTES entry PER not-yet-compacted change (newest first), or
    // '' when no pending fragment carries user-facing notes.
    APP_UNRELEASED_ENTRIES: unreleasedEntries.length ? JSON.stringify(unreleasedEntries) : '',
  },
  // pdf-parse/mammoth pull in Node-only deps (pdfjs) — keep them out of the
  // webpack server bundle so they load as plain CJS at runtime.
  // imapflow/mailparser are Node-only too (net/tls, iconv) and are used by the
  // inbound mail bridge started from instrumentation.ts.
  // web-push is Node-only too (node:crypto, node:https) and does its own
  // dynamic requires, so it stays out of the webpack server bundle (#1464).
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'pdf-parse', 'mammoth', 'imapflow', 'mailparser', 'web-push'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
