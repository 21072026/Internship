/**
 * A MARKETING host of the e2e server's OWN, for specs that map an organization
 * to a host (`Organization.publicHost`, unique) and must not fight the shared
 * marketing host over it (#2922). playwright.config.ts adds it to the local
 * server's MARKETING_HOSTS next to the default list, so it serves the marketing
 * product exactly like the default host does; a deployed environment
 * (BASE_URL) does not know it, and the specs that use it skip there.
 *
 * Zero imports on purpose: the Playwright config loads this file too.
 */
export const BRAND_E2E_HOST = 'brand-e2e.marketing.test';
