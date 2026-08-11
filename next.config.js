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

// Analytics providers — all are opt-in via env vars; the domains are added to
// the CSP unconditionally so the header does not change between builds
// (Content-Security-Policy is a static string; we cannot make it env-conditional
// without runtime header generation, which Next.js does not do in static mode).
const GA4 = 'https://www.googletagmanager.com https://www.google-analytics.com';
const PLAUSIBLE = 'https://plausible.io';
const POSTHOG = 'https://app.posthog.com https://us.i.posthog.com https://eu.i.posthog.com';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${TAWK} ${TAWK_EMOJI} ${GA4} ${PLAUSIBLE} ${POSTHOG}`,
  `style-src 'self' 'unsafe-inline' ${TAWK} ${TAWK_EMOJI}`,
  `img-src 'self' data: blob: ${TAWK} ${TAWK_EMOJI} ${GA4}`,
  `font-src 'self' ${TAWK}`,
  // wss: too — the chat holds a websocket open for incoming messages.
  `connect-src 'self' ${TAWK} wss://*.tawk.to ${GA4} ${PLAUSIBLE} ${POSTHOG}`,
  // The chat plays a notification sound; media-src has no fallback here other
  // than default-src 'self', which would block it.
  `media-src 'self' ${TAWK}`,
  // The in-app meeting side panel embeds the Jitsi room we generate (#1054) —
  // narrow on purpose: only the host we actually create links for, and only
  // that host is allowed camera/microphone below (keep this in sync with
  // EMBEDDABLE_MEETING_HOSTS in src/lib/meetingLink.ts). The chat widget renders
  // itself in an iframe, hence tawk.to here as well.
  `frame-src 'self' https://meet.jit.si ${TAWK}`,
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
  // embedded Jitsi room only — a blanket `camera=()` disables them for every
  // frame, which would leave the meeting panel with a picture of nobody.
  // geolocation stays fully denied.
  {
    key: 'Permissions-Policy',
    value:
      'camera=(self "https://meet.jit.si"), microphone=(self "https://meet.jit.si"), display-capture=(self "https://meet.jit.si"), geolocation=()',
  },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig = {
  reactStrictMode: true,
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
