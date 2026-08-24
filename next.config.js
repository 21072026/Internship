/** @type {import('next').NextConfig} */

// Pragmatic CSP: same-origin by default; allow inline/eval for Next's runtime
// and styles, data:/blob: images (avatars, CV object URLs, CSV downloads).
// The tawk.to live chat (#1174) is loaded on the landing page only, and only
// after the visitor accepts marketing cookies — but CSP headers are per-request,
// not per-component, so the hosts have to be allowed app-wide. Nothing is
// fetched from them until the consent gate in src/components/TawkChat.tsx opens.
const TAWK = 'https://*.tawk.to';
// The chat's emoji picker is loaded from jsdelivr rather than from tawk's own
// CDN. Pinned to that one path prefix — allowing all of cdn.jsdelivr.net would
// mean allowing anything anyone has ever published to npm.
const TAWK_EMOJI = 'https://cdn.jsdelivr.net/emojione/';
// Our JaaS (Jitsi as a Service) tenant, #1237. Two things need it: the meeting
// panel loads `<appId>/external_api.js` from this host (script-src), and that
// script then builds the call as an iframe on the same host (frame-src). Listed
// unconditionally rather than behind the JAAS_* env: these headers are baked at
// build time and the credentials only exist at runtime. One exact host, and the
// same one Permissions-Policy hands camera/microphone to.
const JAAS = 'https://8x8.vc';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${JAAS} ${TAWK} ${TAWK_EMOJI}`,
  `style-src 'self' 'unsafe-inline' ${TAWK} ${TAWK_EMOJI}`,
  `img-src 'self' data: blob: ${TAWK} ${TAWK_EMOJI}`,
  `font-src 'self' ${TAWK}`,
  // wss: too — the chat holds a websocket open for incoming messages.
  `connect-src 'self' ${TAWK} wss://*.tawk.to`,
  // The chat plays a notification sound; media-src has no fallback here other
  // than default-src 'self', which would block it.
  `media-src 'self' ${TAWK}`,
  // The in-app meeting side panel embeds the Jitsi room we generate (#1054) —
  // narrow on purpose: only the hosts we actually create links for, and only
  // those hosts are allowed camera/microphone below (keep this in sync with
  // EMBEDDABLE_MEETING_HOSTS in src/lib/meetingLink.ts). meet.jit.si carries
  // group/bulk meetings and recurring series (hybrid routing — JaaS is 1:1
  // only, src/lib/meetingRoom.ts), rooms created before the JaaS switch, and
  // the free-room fallback when a JaaS call fails. The chat widget renders
  // itself in an iframe, hence tawk.to here as well.
  `frame-src 'self' https://meet.jit.si ${JAAS} ${TAWK}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

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
const releaseFragments = release.readFragments(__dirname);
releaseFragments.forEach(release.validateFragment);
const derivedVersion = release.deriveVersion(pkg.version, releaseFragments);
const unreleasedHighlights = release.unreleasedHighlights(releaseFragments);

const nextConfig = {
  reactStrictMode: true,
  env: {
    APP_DERIVED_VERSION: derivedVersion,
    // One synthetic RELEASE_NOTES entry for everything not yet compacted, or
    // '' when no pending fragment carries user-facing notes.
    APP_UNRELEASED_NOTES: unreleasedHighlights ? JSON.stringify(unreleasedHighlights) : '',
  },
  // pdf-parse/mammoth pull in Node-only deps (pdfjs) — keep them out of the
  // webpack server bundle so they load as plain CJS at runtime.
  // imapflow/mailparser are Node-only too (net/tls, iconv) and are used by the
  // inbound mail bridge started from instrumentation.ts.
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'pdf-parse', 'mammoth', 'imapflow', 'mailparser'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
