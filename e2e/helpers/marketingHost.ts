/**
 * The marketing host of the e2e suite (#2926) — a reserved example name, never a
 * real deployment's. There is no built-in marketing host any more
 * (src/lib/servedHosts.ts), so playwright.config.ts sets MARKETING_HOSTS to this
 * value for the local app server AND the test workers: a spec that forges
 * `x-forwarded-host` with it reaches the marketing product, and a `*.unit.spec.ts`
 * that resolves the marketing world in-process gets the same host.
 *
 * E2E_MARKETING_HOST overrides it, e.g. with BASE_URL pointing at a deployed
 * environment, whose marketing host is whatever that environment serves.
 *
 * Zero imports on purpose: the Playwright config loads this file too.
 */
export const E2E_MARKETING_HOST = process.env.E2E_MARKETING_HOST?.trim().toLowerCase() || 'marketing.example.test';
