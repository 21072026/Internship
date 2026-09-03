import { createHash, randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateApiKey(): { raw: string; hash: string } {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  return { raw, hash: hashApiKey(raw) };
}

// Authenticate a request via "Authorization: Bearer <key>". Returns the
// ApiKey id when valid (and stamps lastUsedAt), else null.
//
// DELIBERATELY unchanged by #1545: the key's expiry, revocation and scope list
// are now RECORDED (see prisma ApiKey / lib/apiScopes.ts) but not yet CHECKED
// here. Refusing an expired/revoked/out-of-scope key — and an org-less
// /api/v1 read — is #1546. Storing a lifecycle field is not enforcing it, and
// splitting the two keeps the behaviour change reviewable on its own.
export async function authenticateApiKey(request: Request): Promise<{ id: string } | null> {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const key = await prisma.apiKey.findUnique({ where: { hashedKey: hashApiKey(m[1].trim()) } });
  if (!key) return null;
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { id: key.id };
}
