import { test, expect } from '@playwright/test';
import { settleStreamedSuspense } from './helpers/auth';

/**
 * The sign-in page reports no `eval` to the CSP (#3642, #3643, #3675).
 *
 * zod 4 probes `new Function("")` while a `z.object()` is CONSTRUCTED, and the
 * sign-in page builds its schemas at module load. Under the strict report-only
 * policy (src/lib/cspPolicy.cjs, no 'unsafe-eval' outside dev) that probe is a
 * `securitypolicyviolation` — and a report to /api/csp-report — on every view
 * (enforced, as in this suite, it is also refused),
 * even though zod swallows the throw. The fix is `z.config({ jitless: true })`
 * in src/instrumentation-client.ts, which Next runs before any app module; set
 * any later (providers.tsx was the first attempt) the probe had already run.
 *
 * So the test is the browser's own word on it: listen for violations from the
 * first byte (an init script runs before the page's scripts), load the page,
 * exercise the form's validation, and expect no `eval` — neither as an event
 * nor in a report body. Reverting the instrumentation call turns this red.
 */

test('the sign-in page sends no eval report to the CSP', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: { blocked: string; directive: string }[] = [];
    (window as unknown as { __cspViolations: typeof seen }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push({ blocked: e.blockedURI, directive: e.effectiveDirective || e.violatedDirective });
    });
  });
  const reports: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/csp-report')) reports.push(req.postData() ?? '');
  });

  const response = await page.goto('/auth/signin');
  await settleStreamedSuspense(page);
  // The policy under test is the strict, nonce-based one the middleware sends —
  // enforced in this suite (playwright.config.ts CSP_ENFORCE, #1552), report-only
  // on the deployments (E2E_CSP_MODE=report). Either way an eval it refuses
  // fires `securitypolicyviolation`, which is what is counted below.
  const headers = response?.headers() ?? {};
  const csp = [headers['content-security-policy'], headers['content-security-policy-report-only']].find((v) => v?.includes("'nonce-")) ?? '';
  expect(csp, 'the strict nonce policy is on this page').toContain("'nonce-");
  expect(csp).not.toContain("'unsafe-eval'");

  // Validation runs on submit: parse an invalid address, the path that would
  // JIT-compile an object schema if it were allowed to.
  await page.fill('input[type="email"], input[name="email"]', 'not-an-address');
  await page.fill('input[type="password"]', 'x');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: { blocked: string; directive: string }[] }).__cspViolations);
  expect(violations.filter((v) => v.blocked === 'eval'), JSON.stringify(violations)).toEqual([]);
  expect(reports.filter((body) => body.includes('eval'))).toEqual([]);
});
