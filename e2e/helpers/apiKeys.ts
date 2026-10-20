import { createHash, randomBytes } from 'crypto';
import { prisma, setOrgFeature } from './db';

// A throwaway organisation with the public API switched on and a key bound to
// it — the starting point of every /api/v1 contract spec. The hash matches
// lib/apiKey.ts's (sha256 of the raw string); hashing here keeps the spec free
// of the server-only module graph.
export const API_KEY_PREFIX = 'e2e-v1-contract';

export async function seedApiOrg(label: string, scopes = 'candidates:read') {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `${label} ${stamp}`, slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}` },
  });
  await setOrgFeature(org.id, 'INTEGRATIONS_API', true);
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: {
      name: `${API_KEY_PREFIX}-${stamp}`,
      hashedKey: createHash('sha256').update(raw).digest('hex'),
      scopes,
      orgId: org.id,
    },
  });
  return { orgId: org.id, headers: { authorization: `Bearer ${raw}` } };
}

export async function dropApiOrg(orgId: string) {
  await prisma.apiKey.deleteMany({ where: { orgId } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId } });
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}
