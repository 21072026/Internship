import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';

// DELETE /api/v1/hooks/{id} (#2002) — unsubscribe. Only a subscription the
// calling key owns: the ownership is in the `where` of the delete itself
// (apiKeyId AND orgId), not a check after a read, and every other id —
// another key's, an admin-created one, another tenant's, a missing one — is
// the same 404, never a 403 that confirms it exists.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'hooks:write', (key) =>
    apiWrite(request, key, z.object({}).strict(), async () => {
      const removed = await prisma.webhook.deleteMany({ where: { id, apiKeyId: key.id, orgId: key.orgId } });
      if (removed.count === 0) return apiNotFound();
      return writeOk(apiOk({ id, deleted: true }), { action: 'api.hook.unsubscribe', targetType: 'webhook', targetId: id });
    }),
  );
}
