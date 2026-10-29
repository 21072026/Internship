// The Content-Security-Policy, in ONE place (#1552).
//
// CommonJS for the same reason as analyticsCsp.cjs: next.config.js loads it
// before any TypeScript toolchain exists. It builds two policies from the same
// host lists, so the two can never disagree about who may serve us a script:
//
//   ENFORCED (no nonce) — the header next.config.js sets on every response,
//     unchanged since #1242: `script-src` still carries 'unsafe-inline' and
//     'unsafe-eval'. Byte-identical to the string next.config.js used to build
//     inline; scripts/test/csp-policy.test.mjs pins that.
//
//   STRICT (with a nonce) — sent by src/middleware.ts as
//     Content-Security-Policy-Report-Only on page requests, with a fresh nonce
//     per request. Its script-src is `'self' 'nonce-…' 'strict-dynamic'` plus
//     the hosts: no 'unsafe-inline', and 'unsafe-eval' only outside production
//     (React's dev runtime evaluates code; a production build does not). The
//     browser enforces NOTHING from it — it reports what the enforced policy
//     would block once it is swapped in, to /api/csp-report. That report stream
//     is what decides when enforcing it is safe (#1552, steps 2 and 3).
//
// style-src keeps 'unsafe-inline' in both: React writes `style` attributes,
// which a nonce cannot cover, and #1552 is about script-src.
//
// Next.js reads the nonce back out of the REQUEST header that carries this
// policy (content-security-policy or …-report-only) and stamps it on its own
// <script> tags; anything we inline ourselves reads it from `x-nonce`.

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

// A CommonJS module (next.config.js loads it before any bundler runs), so require() is the import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { analyticsCspHosts } = require('./analyticsCsp.cjs');

/** Where the browser posts what the report-only policy would have blocked. */
const CSP_REPORT_PATH = '/api/csp-report';

/**
 * @param {Record<string, string | undefined>} env  the NEXT_PUBLIC_* analytics
 *   variables (next.config.js passes process.env; the edge middleware passes
 *   them by name, because only named NEXT_PUBLIC_* reads are inlined there).
 * @param {{ nonce?: string, dev?: boolean }} [opts]  a nonce turns on the strict
 *   script-src and the report endpoint.
 */
function buildCsp(env, opts = {}) {
  const analytics = analyticsCspHosts(env);
  const analyticsScript = analytics.script.join(' ');
  const analyticsConnect = analytics.connect.join(' ');
  const hosts = `${JAAS} ${TAWK} ${TAWK_EMOJI}${analyticsScript ? ` ${analyticsScript}` : ''}`;
  const scriptSrc = opts.nonce
    ? `script-src 'self' 'nonce-${opts.nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ''} ${hosts}`
    : `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${hosts}`;
  const directives = [
    "default-src 'self'",
    scriptSrc,
    `style-src 'self' 'unsafe-inline' ${TAWK} ${TAWK_EMOJI}`,
    `img-src 'self' data: blob: ${TAWK} ${TAWK_EMOJI}`,
    `font-src 'self' ${TAWK}`,
    // wss: too — the chat holds a websocket open for incoming messages.
    `connect-src 'self' ${TAWK} wss://*.tawk.to${analyticsConnect ? ` ${analyticsConnect}` : ''}`,
    // The chat plays a notification sound; media-src has no fallback here other
    // than default-src 'self', which would block it.
    `media-src 'self' ${TAWK}`,
    // The in-app meeting side panel embeds the Jitsi room we generate (#1054) —
    // narrow on purpose: only the hosts we actually create links for, and only
    // those hosts are allowed camera/microphone (keep this in sync with
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
  ];
  if (opts.nonce) directives.push(`report-uri ${CSP_REPORT_PATH}`);
  return directives.join('; ');
}

module.exports = { buildCsp, CSP_REPORT_PATH, JAAS };
