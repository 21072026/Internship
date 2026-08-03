/** @type {import('next').NextConfig} */

// Pragmatic CSP: same-origin by default; allow inline/eval for Next's runtime
// and styles, data:/blob: images (avatars, CV object URLs, CSV downloads).
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  // The in-app meeting side panel embeds the Jitsi room we generate (#1054).
  // Narrow on purpose: only the host we actually create links for, and only
  // that host is allowed camera/microphone below. Keep this list in sync with
  // EMBEDDABLE_MEETING_HOSTS in src/lib/meetingLink.ts.
  "frame-src 'self' https://meet.jit.si",
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
