import crypto from 'node:crypto';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './db';
import { asHost, signInViaApi } from './auth';

/**
 * A SYNTHETIC branded MARKETING organization bound to `host` (#2922) — for the
 * specs that assert "a host bound to an organization wears its database brand".
 *
 * Everything here is fictional ("Acme Sales", a teal ramp, a slate tile). The
 * brand fields are written straight to the row (the exact palette is a super
 * admin's field), then one ordinary admin PATCH of the name goes through the
 * real API so the server's brand cache — which remembers misses for a minute —
 * is cleared in the process that renders the pages.
 *
 * `publicHost` is unique: whoever holds the host is unbound for the duration and
 * bound again by `release()`, which also clears the brand cache again (one more
 * admin PATCH after the host is unbound), so the next spec on that host does not
 * read this organization's brand for the cache's minute.
 */
export const SYNTHETIC_BRAND = {
  name: 'Acme Sales',
  color: '#0e7490',
  tile: '#1e293b',
  // Tailwind's cyan ramp: 600 = #0e7490 clears AA for white text.
  palette: ['#ecfeff', '#cffafe', '#a5f3fc', '#67e8f9', '#22d3ee', '#06b6d4', '#0e7490', '#155e75', '#164e63', '#083344'],
} as const;

export interface BoundBrand {
  orgId: string;
  adminEmail: string;
  adminPassword: string;
  release: () => Promise<void>;
}

export async function bindSyntheticBrand(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
  host: string,
): Promise<BoundBrand> {
  const request: APIRequestContext = await playwright.request.newContext({ baseURL });
  const holder = await prisma.organization.findUnique({ where: { publicHost: host }, select: { id: true } });
  if (holder) await prisma.organization.update({ where: { id: holder.id }, data: { publicHost: null } });
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: {
      name: `Synthetic Brand ${stamp}`,
      slug: `synthetic-brand-${stamp}`,
      vertical: 'MARKETING',
      plan: 'ENTERPRISE',
      publicHost: host,
      brandColor: SYNTHETIC_BRAND.color,
      brandTileColor: SYNTHETIC_BRAND.tile,
      brandAccent: 'brand',
      brandPalette: SYNTHETIC_BRAND.palette.join(','),
    },
  });
  const adminEmail = uniqueEmail('synthetic-brand');
  const adminPassword = 'SyntheticBrand123';
  await seedUser(adminEmail, adminPassword, 'ADMIN', 'Synthetic Brand Admin', { orgId: org.id });
  const login = await signInViaApi(request, adminEmail, adminPassword, { host });
  if (!login.ok) throw new Error(`bindSyntheticBrand: sign-in failed: ${login.error}`);
  const touch = async () => {
    const patch = await request.patch('/api/admin/organizations', {
      headers: asHost(host),
      data: { id: org.id, brandName: SYNTHETIC_BRAND.name },
    });
    if (patch.status() !== 200) throw new Error(`bindSyntheticBrand: PATCH ${patch.status()} ${await patch.text()}`);
  };
  await touch();

  return {
    orgId: org.id,
    adminEmail,
    adminPassword,
    release: async () => {
      await prisma.organization.updateMany({ where: { id: org.id }, data: { publicHost: null } }).catch(() => {});
      if (holder) await prisma.organization.update({ where: { id: holder.id }, data: { publicHost: host } }).catch(() => {});
      await touch().catch((e) => console.error('bindSyntheticBrand: could not clear the brand cache:', e));
      await request.dispose();
      await cleanupByEmail(adminEmail);
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    },
  };
}
