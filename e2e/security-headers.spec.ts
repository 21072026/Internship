import { test, expect } from '@playwright/test';
import { floodIp } from './helpers/rateLimit';

test('responses carry the security headers', async ({ request }) => {
  const res = await request.get('/');
  const h = res.headers();
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['content-security-policy']).toContain("default-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  // camera/microphone/display-capture are delegated to the app itself and to the
  // embedded Jitsi rooms only (the meeting panel needs them); a blanket
  // `camera=()` would leave that iframe with a picture of nobody. What matters
  // here is that the allow-lists stay pinned to the two meeting hosts — our JaaS
  // tenant `8x8.vc` (#1237) and the older public `meet.jit.si`, never `*` — and
  // that geolocation is still denied outright.
  const permissions = h['permissions-policy'];
  expect(permissions).toContain('camera=(self "https://meet.jit.si" "https://8x8.vc")');
  expect(permissions).toContain('microphone=(self "https://meet.jit.si" "https://8x8.vc")');
  expect(permissions).toContain('display-capture=(self "https://meet.jit.si" "https://8x8.vc")');
  expect(permissions).toContain('geolocation=()');
  expect(permissions).not.toContain('*');

  // The JaaS embed loads `<appId>/external_api.js` from 8x8.vc and that script
  // builds the call as an iframe on the same host: both directives have to name
  // it, and by exact host — a wildcard here would be a wide-open script source.
  const policy = h['content-security-policy'];
  expect(policy).toContain('script-src');
  expect(policy).toMatch(/script-src[^;]*https:\/\/8x8\.vc/);
  expect(policy).toMatch(/frame-src[^;]*https:\/\/8x8\.vc/);
  expect(policy).not.toContain('https://*.8x8.vc');
});

test('home page still renders without console errors under CSP', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Companies that want experience/i })).toBeVisible();
  expect(errors).toEqual([]);
});

// ── The strict CSP, report-only (#1552) ─────────────────────────────────────
// src/middleware.ts sends a nonce policy as Content-Security-Policy-Report-Only
// on every page request: script-src with a per-request nonce and no
// 'unsafe-inline'. Nothing is enforced from it yet — the enforced header above
// is unchanged — but every script Next.js renders and our one inline script
// must already carry the nonce, or the report stream would be all noise.
const nonceOf = (policy: string | undefined) => /'nonce-([^']+)'/.exec(policy ?? '')?.[1] ?? null;

test('pages carry a strict report-only CSP with a fresh nonce; the enforced one is unchanged', async ({ request }) => {
  const [a, b] = await Promise.all([request.get('/features'), request.get('/features')]);
  const ro = a.headers()['content-security-policy-report-only'];
  const scriptSrc = ro?.split('; ').find((d) => d.startsWith('script-src '));
  expect(scriptSrc).toContain("'strict-dynamic'");
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(ro).toContain('report-uri /api/csp-report');
  expect(nonceOf(ro)).toBeTruthy();
  expect(nonceOf(ro)).not.toBe(nonceOf(b.headers()['content-security-policy-report-only']));
  // The enforced policy still allows inline scripts — swapping it is a later step.
  expect(a.headers()['content-security-policy']).toMatch(/script-src 'self' 'unsafe-inline'/);
  // API responses are not documents; they get no report-only policy.
  const api = await request.get('/api/health');
  expect(api.headers()['content-security-policy-report-only']).toBeUndefined();
});

test('every script tag the server renders carries the request nonce', async ({ request }) => {
  // The served HTML, not the live DOM: scripts Next.js adds after load are
  // trusted through 'strict-dynamic' and need no nonce of their own.
  const res = await request.get('/features');
  const nonce = nonceOf(res.headers()['content-security-policy-report-only']);
  expect(nonce).toBeTruthy();
  const tags = (await res.text()).match(/<script\b[^>]*>/g) ?? [];
  const executable = tags.filter((t) => !t.includes('application/ld+json'));
  expect(executable.length).toBeGreaterThan(0);
  expect(executable.filter((t) => !t.includes(`nonce="${nonce}"`))).toEqual([]);
});

// /api/csp-report is limited to 60 reports per IP per 10 min, and in a full-suite
// shard every page any spec opens can send report-only violations into the one
// shared loopback bucket — so these tests post from an address of their own
// (e2e/helpers/rateLimit.ts, #2159).
const REPORT_IP = floodIp('security-headers:csp-report');

test('the report endpoint takes both report shapes and refuses garbage', async ({ request }) => {
  const legacy = await request.post('/api/csp-report', {
    headers: { 'content-type': 'application/csp-report', ...REPORT_IP },
    data: JSON.stringify({
      'csp-report': { 'document-uri': 'http://localhost/x?token=t', 'effective-directive': 'script-src-elem', 'blocked-uri': 'inline' },
    }),
  });
  expect(legacy.status()).toBe(204);
  const batch = await request.post('/api/csp-report', {
    headers: { 'content-type': 'application/reports+json', ...REPORT_IP },
    data: JSON.stringify([{ type: 'csp-violation', body: { effectiveDirective: 'script-src', blockedURL: 'eval' } }]),
  });
  expect(batch.status()).toBe(204);
  const junk = await request.post('/api/csp-report', {
    headers: { 'content-type': 'application/csp-report', ...REPORT_IP },
    data: 'not json',
  });
  expect(junk.status()).toBe(400);
});

test("a real browser's violation report reaches the endpoint and is accepted", async ({ page }) => {
  // The browser's own report goes out from this spec's address too (see above).
  await page.route('**/api/csp-report', (route) =>
    route.continue({ headers: { ...route.request().headers(), ...REPORT_IP } }),
  );
  await page.goto('/features');
  const report = page.waitForRequest((r) => r.url().endsWith('/api/csp-report') && r.method() === 'POST');
  // An inline event handler: the strict policy would block it (script-src-attr;
  // 'strict-dynamic' trusts inserted <script>s, never handler attributes), the
  // enforced one still runs it — so the page is unharmed and a report goes out.
  // The report is sent by the browser itself, through the cross-site write gate.
  const violation = await page.evaluate(
    () =>
      new Promise<{ directive: string; disposition: string } | null>((resolve) => {
        document.addEventListener('securitypolicyviolation', (e) =>
          resolve({ directive: e.effectiveDirective, disposition: e.disposition }),
        );
        const b = document.createElement('button');
        b.setAttribute('onclick', 'window.__cspProbe = 1');
        document.body.appendChild(b);
        b.click();
        setTimeout(() => resolve(null), 5000);
      }),
  );
  expect(violation).toEqual({ directive: 'script-src-attr', disposition: 'report' });
  expect(await page.evaluate(() => (window as unknown as { __cspProbe?: number }).__cspProbe)).toBe(1);
  const res = await (await report).response();
  expect(res?.status()).toBe(204);
});

// /auth/* pages are matched by the middleware since #1552 step 2, so the
// sign-in pages get their nonce too. None of the middleware's redirects may
// fire there: a remembered browser without a session is sent through
// /auth/resume from every OTHER page, and /auth/resume itself is an /auth page —
// were it redirected, the resume would loop. wantsResume() refuses /auth/*, and
// the /en 308 and the language rewrite cover public pages only.
const AUTH_PAGES = [
  '/auth/signin',
  '/auth/register',
  '/auth/forgot',
  '/auth/reset?token=x',
  '/auth/magic?token=x',
  '/auth/sso',
  '/auth/verify',
  '/auth/resume?next=%2Fportal',
];

test('/auth/* pages carry the nonce and are never redirected, even for a remembered browser', async ({ request }) => {
  for (const path of AUTH_PAGES) {
    const res = await request.get(path, {
      maxRedirects: 0,
      // A remembered browser with no session: what sends every other page to /auth/resume.
      headers: { cookie: 'internship.remember=1; internship.remember-token=probe' },
    });
    expect(res.status(), path).toBeLessThan(300);
    const nonce = nonceOf(res.headers()['content-security-policy-report-only']);
    expect(nonce, path).toBeTruthy();
    const tags = (await res.text()).match(/<script\b[^>]*>/g) ?? [];
    const executable = tags.filter((t) => !t.includes('application/ld+json'));
    expect(executable.filter((t) => !t.includes(`nonce="${nonce}"`)), path).toEqual([]);
  }
  // The control: the same browser on a page outside /auth IS sent through the resume.
  const page = await request.get('/portal', {
    maxRedirects: 0,
    headers: { cookie: 'internship.remember=1; internship.remember-token=probe' },
  });
  expect(page.status()).toBe(307);
  expect(page.headers()['location']).toContain('/auth/resume?next=%2Fportal');
});
