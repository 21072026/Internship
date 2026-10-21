import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { signInViaApi } from './auth';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

/**
 * A request context signed in as the instance's operator — the seeded admin,
 * the default (INTERNSHIP) world's super admin. The batch and the
 * platform-wide `/api/cron` jobs sweep every tenant, so since #1575 they
 * refuse a tenant ADMIN; a spec that needs such a tick fires it through this,
 * while the tenant-scoped half of the spec stays with the tenant's own admin.
 * The caller disposes it.
 */
export async function operatorRequest(baseURL: string | undefined): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL });
  const signedIn = await signInViaApi(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!signedIn.ok) throw new Error(`operatorRequest: sign-in failed (${signedIn.error})`);
  return ctx;
}
